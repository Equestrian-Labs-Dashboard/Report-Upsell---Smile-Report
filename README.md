# CORRO - Upsell & Smile Report

This repository generates a static GitHub Pages dashboard for the Upsell + Smile report.

## How it works

- Shopify is fetched once per week by GitHub Actions.
- Smile is read from CSV exports saved in `data/smile/`.
- The dashboard reads `docs/report-data.json`.
- The public/private report page is `docs/index.html`.

## Required GitHub Secrets

Go to:

`GitHub repo → Settings → Secrets and variables → Actions → New repository secret`

Add:

- `SHOPIFY_STORE` = `your-store.myshopify.com`
- `SHOPIFY_ACCESS_TOKEN` = `shpat_xxxxxxxxx`
- `UPSELL_IDENTIFIER` = `__eliteCartUpsell`
- `SHOPIFY_API_VERSION` = `2026-04` (optional)

## Smile CSV files

Upload these files into:

`data/smile/`

Recommended exact filenames:

- `smile_customers.csv`
- `smile_points_activity_over_time.csv`
- `smile_points_redemptions.csv`
- `smile_points_transactions.csv`
- `smile_influenced_orders.csv`
- `smile_total_members_over_time.csv`
- `smile_redemption_rate_over_time.csv`

Do **not** use a public repo if the CSVs include customer emails or personal data. Use a private repository.

## Run manually

In GitHub:

`Actions → Update Upsell & Smile Report → Run workflow`

## GitHub Pages

Go to:

`Settings → Pages → Build and deployment → Source: Deploy from a branch`

Use:

- Branch: `main`
- Folder: `/docs`

Then open the GitHub Pages URL.
