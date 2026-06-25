import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data", "smile");
const DOCS_DIR = path.join(ROOT, "docs");
const OUT_FILE = path.join(DOCS_DIR, "report-data.json");

const SHOPIFY_STORE = cleanStore(process.env.SHOPIFY_STORE || "");
const SHOPIFY_ACCESS_TOKEN = String(process.env.SHOPIFY_ACCESS_TOKEN || "").trim();
const SHOPIFY_API_VERSION = String(process.env.SHOPIFY_API_VERSION || "2026-04").trim();
const UPSELL_IDENTIFIER = String(process.env.UPSELL_IDENTIFIER || "__eliteCartUpsell").trim();

const START_YEAR = 2025;
const CURRENT_DATE = new Date();

function cleanStore(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function listSmileFiles() {
  if (!fs.existsSync(DATA_DIR)) return [];

  return fs.readdirSync(DATA_DIR)
    .filter(file => file.toLowerCase().endsWith(".csv"))
    .sort();
}

function findSmileFile(kind) {
  const files = listSmileFiles();

  const rules = {
    customers: [
      ["customer"]
    ],
    totalMembers: [
      ["total", "members", "over", "time"],
      ["members", "over", "time"],
      ["total members"]
    ],
    pointsActivity: [
      ["points", "activity", "over", "time"],
      ["point", "activity", "over", "time"]
    ],
    pointTransactions: [
      ["points", "transactions"],
      ["point", "transactions"]
    ],
    pointRedemptions: [
      ["points", "redemptions"],
      ["point", "redemptions"],
      ["redemptions"]
    ],
    influencedOrders: [
      ["smile", "influenced", "orders"],
      ["influenced", "orders"]
    ],
    redemptionRate: [
      ["redemption", "rate", "over", "time"]
    ],
    outstandingPoints: [
      ["outstanding", "points", "over", "time"]
    ],
    vipTierChanges: [
      ["vip", "tier", "changes"]
    ],
    vipTierMembers: [
      ["vip", "tier", "members", "over", "time"]
    ]
  };

  for (const rule of rules[kind] || []) {
    const match = files.find(file => {
      const normalized = normalizeName(file);
      return rule.every(token => normalized.includes(token));
    });

    if (match) return path.join(DATA_DIR, match);
  }

  return "";
}

function readSmileCsv(kind) {
  const file = findSmileFile(kind);

  if (!file) {
    console.warn(
      `Smile CSV missing for ${kind}. Available CSV files: ${listSmileFiles().join(", ") || "(none)"}`
    );
    return [];
  }

  const rows = parseCSV(fs.readFileSync(file, "utf8"));
  console.log(`Smile ${kind}: ${path.basename(file)} → ${rows.length} rows`);

  if (rows.length) {
    console.log(`Smile ${kind} headers: ${Object.keys(rows[0]).join(" | ")}`);
  }

  return rows;
}

function parseCSV(text) {
  if (!text || !text.trim()) return [];

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

      if (row.some(value => String(value).trim() !== "")) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    field += char;
  }

  row.push(field);

  if (row.some(value => String(value).trim() !== "")) {
    rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map(header => normalizeHeader(header));

  return rows.slice(1).map(values => {
    const repairedValues = repairSmileRow(values, headers.length);

    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = repairedValues[index] ?? "";
    });

    return obj;
  });
}

function repairSmileRow(values, expectedColumnCount) {
  /*
   * Handles two Smile malformed CSV patterns:
   *
   * Pattern A - rows beginning with a date:
   * "June 25, 2026,0,""22,699"""
   * Should become:
   * ["June 25, 2026", "0", "22,699"]
   *
   * Pattern B - influenced orders, full row wrapped in quotes:
   * "Stacey,Ritala,email@example.com,153089,624.83,paid,false,code,false,points_redemption,""May 17, 2026, 12:38 AM"",Member"
   */
  if (!values || values.length !== 1 || expectedColumnCount <= 1) {
    return values;
  }

  let raw = String(values[0] || "").trim();

  if (!raw) {
    return values;
  }

  if (raw.startsWith('"') && raw.endsWith('"')) {
    raw = raw.slice(1, -1);
  }

  raw = raw.replace(/""/g, '"');

  // SPECIAL CASE:
  // Smile metric CSVs start with an unquoted date containing a comma:
  // June 25, 2026,0,"22,699"
  // If we parse this normally, it becomes ["June 25", "2026", ...] and breaks.
  const dateAtStart = raw.match(/^([A-Za-z]+\s+\d{1,2},\s+\d{4}),(.*)$/);

  if (dateAtStart && expectedColumnCount <= 5) {
    const datePart = dateAtStart[1];
    const rest = dateAtStart[2];
    const restFields = parseCsvLine(rest);
    const repaired = [datePart, ...restFields];

    return repaired.length >= expectedColumnCount ? repaired : values;
  }

  // Normal malformed row repair for Smile influenced orders.
  const repaired = parseCsvLine(raw);

  return repaired.length >= expectedColumnCount ? repaired : values;
}

function parseCsvLine(line) {
  const values = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

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
      values.push(field);
      field = "";
      continue;
    }

    field += char;
  }

  values.push(field);

  return values.map(value => String(value).trim().replace(/^"|"$/g, ""));
}

function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function getValue(row, aliases) {
  for (const alias of aliases) {
    const key = normalizeHeader(alias);

    if (row[key] !== undefined && String(row[key]).trim() !== "") {
      return row[key];
    }
  }

  const rowKeys = Object.keys(row);

  for (const alias of aliases) {
    const key = normalizeHeader(alias);

    const match = rowKeys.find(rowKey => {
      const normalizedRowKey = normalizeHeader(rowKey);
      return normalizedRowKey.includes(key) || key.includes(normalizedRowKey);
    });

    if (match && row[match] !== undefined && String(row[match]).trim() !== "") {
      return row[match];
    }
  }

  return "";
}

function parseNumber(value) {
  if (value === null || value === undefined || value === "") return 0;

  const text = String(value)
    .replace(/[$,%]/g, "")
    .replace(/,/g, "")
    .replace(/points/gi, "")
    .trim();

  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

function detectSalesValue(row) {
  const ignoredWords = [
    "id",
    "customer",
    "email",
    "phone",
    "points",
    "discount",
    "code",
    "referral",
    "url",
    "date",
    "time",
    "name",
    "order number",
    "status",
    "membership"
  ];

  let best = 0;

  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = normalizeHeader(key);
    const shouldIgnore = ignoredWords.some(word => normalizedKey.includes(word));

    if (shouldIgnore) continue;

    const raw = String(value || "").trim();
    if (!raw) continue;

    const looksLikeMoney =
      raw.includes("$") ||
      raw.includes(".") ||
      raw.match(/^\d{1,3}(,\d{3})+(\.\d+)?$/) ||
      raw.match(/^\d+(\.\d+)?$/);

    if (!looksLikeMoney) continue;

    const number = parseNumber(raw);

    if (number > best && number < 100000) {
      best = number;
    }
  }

  return best;
}

function parseDate(value) {
  if (!value) return null;

  const text = String(value).trim();
  const date = new Date(text);

  return Number.isNaN(date.getTime()) ? null : date;
}

function monthKeyFromDate(value) {
  const date = parseDate(value);
  if (!date) return "";

  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function dateStamp(value) {
  const date = parseDate(value);
  return date ? date.getTime() : 0;
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

        total_orders: 0,
        orders_with_upsell: 0,
        upsell_revenue: 0,
        upsell_items: 0,
        conversion_rate: 0,
        average_upsell_value: 0,

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

function setLatestInMonth(months, month, stampKey, stamp, values) {
  if (!month || !months[month]) return;

  const currentStamp = months[month][stampKey] || 0;

  if (stamp >= currentStamp) {
    months[month][stampKey] = stamp;

    for (const [key, value] of Object.entries(values)) {
      months[month][key] = value;
    }
  }
}

function buildSmileMonthly(months) {
  const totalMembersRows = readSmileCsv("totalMembers");

  for (const row of totalMembersRows) {
    const date = getValue(row, ["date", "day", "month", "period"]);
    const month = monthKeyFromDate(date);

    if (!month || !months[month]) continue;

    addToMonth(months, month, {
      new_members: parseNumber(getValue(row, [
        "new members added",
        "new members",
        "members added",
        "members"
      ]))
    });

    setLatestInMonth(months, month, "__total_members_stamp", dateStamp(date), {
      total_customer_base: parseNumber(getValue(row, [
        "cumulative members",
        "total members",
        "members total",
        "total customer base",
        "value"
      ]))
    });
  }

  const pointsActivityRows = readSmileCsv("pointsActivity");

  if (pointsActivityRows.length) {
    for (const row of pointsActivityRows) {
      const date = getValue(row, ["date", "day", "month", "period"]);
      const month = monthKeyFromDate(date);

      if (!month || !months[month]) continue;

      addToMonth(months, month, {
        points_earned: parseNumber(getValue(row, [
          "points earned",
          "earned points",
          "points issued",
          "points added"
        ])),
        points_redeemed: Math.abs(parseNumber(getValue(row, [
          "points redeemed",
          "redeemed points",
          "points spent",
          "points used"
        ])))
      });
    }
  } else {
    const transactionRows = readSmileCsv("pointTransactions");

    for (const row of transactionRows) {
      const date = getValue(row, ["date", "created at", "processed at", "completed at"]);
      const month = monthKeyFromDate(date);
      const points = parseNumber(getValue(row, [
        "points change",
        "points changed",
        "points",
        "amount"
      ]));

      if (points > 0) {
        addToMonth(months, month, { points_earned: points });
      }
    }

    const redemptionRows = readSmileCsv("pointRedemptions");

    for (const row of redemptionRows) {
      const date = getValue(row, ["date", "created at", "redeemed at", "processed at", "completed at"]);
      const month = monthKeyFromDate(date);
      const points = Math.abs(parseNumber(getValue(row, [
        "points redeemed",
        "redeemed points",
        "points spent",
        "points",
        "amount"
      ])));

      if (points > 0) {
        addToMonth(months, month, { points_redeemed: points });
      }
    }
  }

  const influencedRows = readSmileCsv("influencedOrders");

  if (influencedRows.length) {
    console.log("Influenced orders headers:", Object.keys(influencedRows[0]).join(" | "));
  }

  for (const row of influencedRows) {
    const date = getValue(row, [
      "placed at",
      "date",
      "created at",
      "order date",
      "processed at",
      "completed at",
      "order placed at",
      "ordered at"
    ]);

    const month = monthKeyFromDate(date);

    let sales = parseNumber(getValue(row, [
      "grand total",
      "total",
      "order total",
      "order total amount",
      "total order value",
      "order value",
      "revenue",
      "sales",
      "amount",
      "subtotal",
      "total price",
      "price",
      "paid",
      "amount paid",
      "total paid"
    ]));

    if (!sales) {
      sales = detectSalesValue(row);
    }

    if (month && sales) {
      addToMonth(months, month, {
        sales_influenced: sales
      });
    }
  }

  const customersRows = readSmileCsv("customers");

  if (customersRows.length) {
    const totalCustomers = customersRows.length;
    const lastMonth = Object.keys(months).sort().filter(key => key >= "2026-01").at(-1);
    const hasAnyBase = Object.values(months).some(row => Number(row.total_customer_base || 0) > 0);

    if (!hasAnyBase && lastMonth && months[lastMonth]) {
      months[lastMonth].total_customer_base = totalCustomers;
      months[lastMonth].__base_fallback = true;
    }

    for (const row of customersRows) {
      const date = getValue(row, [
        "became member",
        "became member at",
        "membership date",
        "member since",
        "joined at",
        "created at"
      ]);

      const month = monthKeyFromDate(date);

      if (month && months[month]) {
        addToMonth(months, month, { new_members: 1 });
      }
    }
  }

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
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ACCESS_TOKEN,
      "Accept": "application/json"
    }
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Shopify API ${response.status}: ${body}`);
  }

  return {
    json: JSON.parse(body),
    link: response.headers.get("link") || ""
  };
}

function propertyToText(property) {
  return `${property.name || property.key || ""}:${property.value || ""}`;
}

function isUpsellLineItem(item, order) {
  const identifier = UPSELL_IDENTIFIER.toLowerCase();

  const properties = item.properties || item.customAttributes || [];
  const noteAttributes = order.note_attributes || order.customAttributes || [];

  const orderTags = String(order.tags || "")
    .split(",")
    .map(tag => tag.trim())
    .filter(Boolean);

  const text = [
    item.title || "",
    item.name || "",
    item.sku || "",
    item.vendor || "",
    ...orderTags,
    ...properties.map(propertyToText),
    ...noteAttributes.map(propertyToText)
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

    if (hasUpsell) {
      ordersWithUpsell += 1;
    }
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

    if (safety > 100) {
      throw new Error(`Too many Shopify pages for ${monthKey}`);
    }
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

    console.log(
      `${monthKey}: orders=${metrics.total_orders}, upsell orders=${metrics.orders_with_upsell}, revenue=${metrics.upsell_revenue}`
    );
  }
}

async function main() {
  ensureDir(DOCS_DIR);

  console.log(`Smile CSV files found: ${listSmileFiles().join(", ") || "(none)"}`);

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

main().catch(error => {
  console.error(error);
  process.exit(1);
});
