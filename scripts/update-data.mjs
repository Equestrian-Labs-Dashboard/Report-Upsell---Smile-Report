import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data", "smile");
const DOCS_DIR = path.join(ROOT, "docs");
const OUT_FILE = path.join(DOCS_DIR, "report-data.json");

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || "";
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || "";
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";
const UPSELL_IDENTIFIER = process.env.UPSELL_IDENTIFIER || "__eliteCartUpsell";

const START_YEAR = 2025; // Needed for 2026 YoY comparisons.
const CURRENT_DATE = new Date();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readFileIfExists(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function parseCSV(text) {
  if (!text || !text.trim()) return [];

  // Handles commas, quotes, escaped quotes, and newlines inside quoted fields.
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(field);
      field = "";
      if (row.some(v => String(v).trim() !== "")) rows.push(row);
      row = [];
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some(v => String(v).trim() !== "")) rows.push(row);

  if (!rows.length) return [];

  const headers = rows[0].map(h => normalizeHeader(h));
  return rows.slice(1).map(values => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = values[i] ?? "";
    });
    return obj;
  });
}

function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  const text = String(value)
    .replace(/[$,%]/g, "")
    .replace(/,/g, "")
    .replace(/points/gi, "")
    .trim();
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

function parseDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

function monthKeyFromDate(value) {
  const d = parseDate(value);
  if (!d) return "";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function quarterFromMonth(monthNumber) {
  if (monthNumber <= 3) return "Q1";
  if (monthNumber <= 6) return "Q2";
  if (monthNumber <= 9) return "Q3";
  return "Q4";
}

function createMonthSkeleton() {
  const months = {};
  const endYear = Math.max(2026, CURRENT_DATE.getUTCFullYear());

  for (let year = START_YEAR; year <= endYear; year++) {
    for (let month = 1; month <= 12; month++) {
      const first = new Date(Date.UTC(year, month - 1, 1));
      if (first > CURRENT_DATE) continue;

      const key = `${year}-${String(month).padStart(2, "0")}`;
      months[key] = {
        year,
        quarter: quarterFromMonth(month),
        month: key,

        // Shopify
        total_orders: 0,
        orders_with_upsell: 0,
        upsell_revenue: 0,
        upsell_items: 0,
        conversion_rate: 0,
        average_upsell_value: 0,

        // Smile
        new_members: 0,
        total_customer_base: 0,
        points_earned: 0,
        points_redeemed: 0,
        redemption_rate: 0,
        sales_influenced: 0
      };
    }
  }

  return months;
}

function addToMonth(months, month, values) {
  if (!month || !months[month]) return;
  for (const [key, value] of Object.entries(values)) {
    months[month][key] = (Number(months[month][key]) || 0) + (Number(value) || 0);
  }
}

function setMonth(months, month, values) {
  if (!month || !months[month]) return;
  for (const [key, value] of Object.entries(values)) {
    months[month][key] = value;
  }
}

function loadSmileCsv(name) {
  const filePath = path.join(DATA_DIR, name);
  return parseCSV(readFileIfExists(filePath));
}

function buildSmileMonthly(months) {
  const totalMembersRows = loadSmileCsv("smile_total_members_over_time.csv");
  for (const row of totalMembersRows) {
    const month = monthKeyFromDate(row["date"]);
    addToMonth(months, month, {
      new_members: parseNumber(row["new members added"])
    });

    // Keep the latest cumulative members value in each month.
    const date = parseDate(row["date"]);
    if (month && months[month]) {
      const stampKey = "__total_members_stamp";
      const currentStamp = months[month][stampKey] || 0;
      const stamp = date ? date.getTime() : 0;
      if (stamp >= currentStamp) {
        months[month][stampKey] = stamp;
        months[month].total_customer_base = parseNumber(row["cumulative members"]);
      }
    }
  }

  const pointsActivityRows = loadSmileCsv("smile_points_activity_over_time.csv");
  for (const row of pointsActivityRows) {
    const month = monthKeyFromDate(row["date"]);
    setMonth(months, month, {
      points_earned: parseNumber(row["points earned"]),
      points_redeemed: Math.abs(parseNumber(row["points redeemed"]))
    });
  }

  // Fallbacks if points activity report is missing.
  const transactionsRows = loadSmileCsv("smile_points_transactions.csv");
  for (const row of transactionsRows) {
    const month = monthKeyFromDate(row["date"]);
    const type = String(row["type"] || "").toLowerCase();
    const points = parseNumber(row["points change"]);
    if (type.includes("earned") && points > 0 && months[month] && !months[month].points_earned) {
      addToMonth(months, month, { points_earned: points });
    }
  }

  const redemptionsRows = loadSmileCsv("smile_points_redemptions.csv");
  for (const row of redemptionsRows) {
    const month = monthKeyFromDate(row["date"]);
    const points = Math.abs(parseNumber(row["points redeemed"]));
    if (points && months[month] && !months[month].points_redeemed) {
      addToMonth(months, month, { points_redeemed: points });
    }
  }

  const influencedRows = loadSmileCsv("smile_influenced_orders.csv");
  for (const row of influencedRows) {
    const month = monthKeyFromDate(row["placed at"] || row["date"] || row["created at"]);
    addToMonth(months, month, {
      sales_influenced: parseNumber(row["grand total"] || row["total"] || row["order total"])
    });
  }

  // Compute redemption rate after points have been loaded.
  for (const row of Object.values(months)) {
    row.redemption_rate = row.points_earned ? row.points_redeemed / row.points_earned : 0;
    delete row.__total_members_stamp;
  }
}

function getMonthRange(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59));
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString()
  };
}

function nextPageInfoFromLink(linkHeader) {
  if (!linkHeader) return "";
  const parts = String(linkHeader).split(",");
  for (const part of parts) {
    if (part.includes('rel="next"')) {
      const match = part.match(/[?&]page_info=([^&>]+)/);
      if (match) return decodeURIComponent(match[1]);
    }
  }
  return "";
}

async function shopifyFetchJson(url) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Accept": "application/json"
    }
  });

  const body = await res.text();

  if (!res.ok) {
    throw new Error(`Shopify API ${res.status}: ${body}`);
  }

  return {
    json: JSON.parse(body),
    link: res.headers.get("link") || ""
  };
}

function isUpsellLineItem(item, order) {
  const identifier = UPSELL_IDENTIFIER.toLowerCase();

  const properties = item.properties || [];
  const noteAttributes = order.note_attributes || [];
  const orderTags = String(order.tags || "")
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);

  const text = [
    item.title || "",
    item.sku || "",
    item.vendor || "",
    ...orderTags,
    ...properties.map(p => `${p.name || ""}:${p.value || ""}`),
    ...noteAttributes.map(p => `${p.name || ""}:${p.value || ""}`)
  ].join(" ").toLowerCase();

  return text.includes(identifier);
}

function calculateShopifyMetrics(orders) {
  let totalOrders = orders.length;
  let ordersWithUpsell = 0;
  let upsellRevenue = 0;
  let upsellItems = 0;

  for (const order of orders) {
    let hasUpsell = false;

    for (const item of order.line_items || []) {
      if (isUpsellLineItem(item, order)) {
        hasUpsell = true;

        const qty = parseNumber(item.quantity);
        const price = parseNumber(item.price);
        const discount = parseNumber(item.total_discount);
        const revenue = Math.max(0, qty * price - discount);

        upsellItems += qty;
        upsellRevenue += revenue;
      }
    }

    if (hasUpsell) ordersWithUpsell += 1;
  }

  return {
    total_orders: totalOrders,
    orders_with_upsell: ordersWithUpsell,
    upsell_revenue: roundMoney(upsellRevenue),
    upsell_items: upsellItems,
    conversion_rate: totalOrders ? ordersWithUpsell / totalOrders : 0,
    average_upsell_value: upsellItems ? upsellRevenue / upsellItems : 0
  };
}

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

async function fetchShopifyOrdersForMonth(monthKey) {
  const { startIso, endIso } = getMonthRange(monthKey);
  const fields = [
    "id",
    "name",
    "created_at",
    "tags",
    "note_attributes",
    "line_items",
    "total_price"
  ].join(",");

  let url =
    `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json` +
    `?status=any&limit=250` +
    `&created_at_min=${encodeURIComponent(startIso)}` +
    `&created_at_max=${encodeURIComponent(endIso)}` +
    `&fields=${encodeURIComponent(fields)}`;

  let orders = [];
  let safety = 0;

  while (url) {
    const { json, link } = await shopifyFetchJson(url);
    orders = orders.concat(json.orders || []);

    const next = nextPageInfoFromLink(link);
    if (next) {
      url =
        `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/orders.json` +
        `?limit=250&fields=${encodeURIComponent(fields)}&page_info=${encodeURIComponent(next)}`;
    } else {
      url = "";
    }

    safety += 1;
    if (safety > 100) throw new Error(`Too many Shopify pages for ${monthKey}`);
  }

  return orders;
}

async function buildShopifyMonthly(months) {
  if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
    console.warn("Shopify secrets are missing. Shopify metrics will remain 0.");
    return;
  }

  const keys = Object.keys(months).sort();

  for (const monthKey of keys) {
    console.log(`Fetching Shopify ${monthKey}...`);
    const orders = await fetchShopifyOrdersForMonth(monthKey);
    const metrics = calculateShopifyMetrics(orders);
    Object.assign(months[monthKey], metrics);
  }
}

async function main() {
  ensureDir(DOCS_DIR);

  const months = createMonthSkeleton();

  buildSmileMonthly(months);
  await buildShopifyMonthly(months);

  const monthly = Object.values(months).sort((a, b) => a.month.localeCompare(b.month));

  const report = {
    generatedAt: new Date().toISOString(),
    source: {
      shopify: SHOPIFY_STORE ? "Shopify Admin API" : "Not configured",
      smile: "CSV files in data/smile"
    },
    monthly
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2), "utf8");
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
