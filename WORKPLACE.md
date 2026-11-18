# Run Jobuy Routes

Install Node.js 22.13 or newer. From the GitHub checkout, run `npm ci` and `npm run dev`, then open the local address it prints.

**Upload screenshot** reads the image on the device. Review the extracted rows, set the delivery date and save the deliveries to the checklist. A saved checklist and its assignment ticks persist in this browser. The screenshot and raw OCR text stay in the review until you save, discard or leave it.

Route updates are still available at `/#/data`. Use **Import / Update Routes** to review and apply a new workbook. Company and coverage tools are available at `/#/team` for existing operators. Keep private workbooks, screenshots, checklist exports and company allocations in workplace-approved storage.

## Shared checklist on a warehouse network

An authorised administrator can run the app on a warehouse computer. Browsers opening that computer's address share the same checklist. The server writes confirmed delivery rows and their assignment status to a SQLite file in a private local directory. OCR still runs in the browser.

1. Run `npm ci` and `APP_BASE=/ npm run build` on the host.
2. Set `WORKPLACE_DATA_DIR` to a private folder outside the Git checkout. Set `WORKPLACE_ACCOUNTS_FILE` to a private JSON file mapping individual usernames to unique strong passwords of at least 16 characters. Use separate accounts and close the browser session on a shared workstation when finished.
3. Set `WORKPLACE_HOST` to the approved private network bind address, `WORKPLACE_PORT` to its port and `WORKPLACE_ORIGIN` to its exact HTTPS origin with no trailing slash. Set `WORKPLACE_CERT` and `WORKPLACE_KEY` to a certificate and key trusted by the warehouse browsers. The default listener is loopback for local testing.
4. Optionally set `WORKPLACE_COMPANY_FILE` to a private JSON array of approved rules. Each rule has a `route` and `company`, with an optional `date` in YYYY-MM-DD format. Dated rules take priority on that date. Conflicting company rules require a choice in review.
5. Run `npm run serve:workplace` and open the configured HTTPS address from staff browsers. Keep the host and its database backup inside the approved network.

Each browser can import a route workbook locally. The shared checklist preserves the route and company confirmed by the person who saved each delivery.
