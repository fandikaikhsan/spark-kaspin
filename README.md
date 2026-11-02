# Kaspin POS analytics

A Next.js dashboard with an AWS Lambda ingestion worker. The worker fetches each active store every three seconds, refreshes its expired POS credentials, and stores normalized store-scoped data in Supabase. Telegram provides manual sync and status commands through a separate Lambda Function URL.

## Architecture

```text
EventBridge rule (once/minute)
  └─> 58-second polling Lambda
        └─> every active store every REFRESH_TIME seconds
              └─> Supabase transactions + hourly view

Telegram webhook ─> Telegram Lambda ─> immediate POS sync ─> Supabase

Browser ─> Vercel Next.js dashboard ─> Supabase hourly view
```

EventBridge itself has one-minute precision. The scheduled Lambda remains active for most of each minute. Stores are fetched in parallel within each cycle, while requests for an individual store remain sequential. Reserved concurrency is `1`, preventing two scheduled workers from overlapping.

## Included

- Store settings for branch name, UTC+7/UTC+8 timezone, and seed credentials
- Access-token refresh using each store's saved refresh token
- Rotated access- and refresh-token persistence in the private `integration_credentials` table
- Store-scoped, idempotent transaction and item-line upserts
- One audit summary per store per Lambda invocation, with 7-day success and 30-day failure retention
- Three-second scheduled POS ingestion through AWS Lambda
- Separate Telegram Lambda with `/stores`, `/sync`, and `/status`
- Supabase RLS, revoked public grants, and hourly aggregation view
- Responsive daily metrics and item-by-hour heatmap
- Live kitchen-ticket receipt rail and paginated transaction history
- Dashboard login with a bootstrap super-admin and managed admin accounts
- Demo dashboard data until Supabase is configured

### Dashboard reporting convention

Sales reporting uses each store's local **06:00 through 05:59 the next morning** as one business day. Dashboard totals, hourly charts, heatmaps and transaction-history date filters share this window. POS ingestion retains its existing calendar-date storage and sync schedule; no historical transaction rewrite is needed.

Live/daily KPI deltas compare with the **previous seven complete business days' average**. For the current day, each comparison day is cut at the same elapsed time, including after midnight. AOV is total gross item sales divided by transaction count over those matching windows, not an average of daily AOVs. Orange shows the selected day, blue the seven-day hourly average, and gold one real highest-sales completed day before the selected period. Monthly reporting compares with the previous month and the best earlier month in the available stored history. Missing baselines remain unavailable. Historical chart benchmarks are cached for five minutes; live KPI baselines refresh once a minute, independently of live sales polling.

Dashboard, Catalogue, Inventory, Settings and Transactions share the compact header/sidebar. The public `/staff/stock-opname` and `/staff/receiving` forms remain isolated.

## 1. Supabase setup

1. Create a project at [database.new](https://database.new).
2. Open **SQL Editor**, paste [`supabase/schema.sql`](supabase/schema.sql), and run it once.
3. Open **Settings → API Keys**.
4. Copy:
   - Project URL → `SUPABASE_URL`
   - A server-side secret key beginning with `sb_secret_` → `SUPABASE_SECRET_KEY`

Do not use a publishable or anonymous key for the worker. The secret key bypasses RLS and must only exist in Lambda and server-side Vercel variables.

### Upgrade an existing single-store database

Temporarily disable the EventBridge schedule, then run
[`supabase/migrations/20260927_multi_store.sql`](supabase/migrations/20260927_multi_store.sql)
in the Supabase SQL Editor. It preserves existing data under a generated **Default store** and changes transaction keys to include `store_id`.

Upload the newly built worker and Telegram bundles before enabling the schedule again. The old worker is not compatible with the migrated primary keys.

After the multi-store migration, run
[`supabase/migrations/20260927_dashboard_auth.sql`](supabase/migrations/20260927_dashboard_auth.sql)
to add the private managed-user table used by dashboard login.

## 2. Telegram setup

1. Open a chat with `@BotFather`.
2. Run `/newbot` and save the bot token as `TELEGRAM_BOT_TOKEN`.
3. Open your new bot and send `/start`.
4. Before registering a webhook, find your chat ID locally:

   ```bash
   curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates" \
     | jq '.result[-1].message.chat.id'
   ```

5. Save that number as `TELEGRAM_ALLOWED_CHAT_ID`.
6. Generate a webhook secret containing only Telegram-supported characters:

   ```bash
   openssl rand -hex 24
   ```

   Save the result as `TELEGRAM_WEBHOOK_SECRET`.

Do not paste the bot token, webhook secret, or Supabase secret key into chat or commit them.

## 3. AWS setup

Prerequisites:

- AWS CLI configured with your account or AWS SSO
- AWS SAM CLI
- Node.js 22 or newer
- pnpm

Verify the tools:

```bash
aws sts get-caller-identity
sam --version
node --version
pnpm --version
```

Install and build:

```bash
pnpm install
pnpm aws:validate
pnpm aws:build
```

Deploy interactively:

```bash
sam deploy --guided
```

Recommended answers:

- Stack name: `spark-kaspin`
- Region: a region near your Supabase project, such as `ap-southeast-1`
- `RefreshTime`: `3`
- Allow SAM to create IAM roles: yes
- Telegram Function URL without IAM authentication: yes
- Save deployment arguments to `samconfig.toml`: **no**, because the parameters contain secrets

Enter the values from `.env`, Supabase, and Telegram when SAM requests the template parameters. The sensitive CloudFormation parameters are marked `NoEcho`.

The infrastructure in [`template.yaml`](template.yaml) creates:

- One ARM64 polling Lambda with 128 MB memory, 58-second timeout, and reserved concurrency `1`
- One EventBridge invocation per minute
- One separate Telegram Lambda
- Seven-day CloudWatch log retention and no retry pile-up for failed scheduled invocations
- One public Lambda Function URL protected at the application layer by Telegram’s secret header and chat allow-list

## 4. Register the deployed Telegram webhook

Get the generated Function URL:

```bash
export TELEGRAM_WEBHOOK_URL="$(aws cloudformation describe-stacks \
  --stack-name spark-kaspin \
  --query "Stacks[0].Outputs[?OutputKey=='TelegramWebhookUrl'].OutputValue" \
  --output text)"
```

Register it with Telegram:

```bash
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  --data "$(jq -n \
    --arg url "$TELEGRAM_WEBHOOK_URL" \
    --arg secret "$TELEGRAM_WEBHOOK_SECRET" \
    '{url:$url, secret_token:$secret, allowed_updates:["message"]}')"
```

Then test in the bot chat:

- `/status`
- `/stores`
- `/sync` when there is only one store
- `/sync <store-id> 2026-09-27` when there are multiple stores

## 5. Vercel dashboard setup

Vercel now hosts only the dashboard and `/api/analytics`; it has no cron configuration.

Add these server-side environment variables to the Vercel project:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `REFRESH_TIME=30` (dashboard refresh; AWS can remain at `3`)
- `SETTINGS_ADMIN_USERNAME`
- `SETTINGS_ADMIN_PASSWORD` (use a unique, randomly generated password)
- `AUTH_SESSION_SECRET` (generate with `openssl rand -hex 32`)

The POS and Telegram secrets are not needed in Vercel because those responsibilities run in AWS.

After redeploying Vercel, open `/login` and sign in with `SETTINGS_ADMIN_USERNAME` and `SETTINGS_ADMIN_PASSWORD`. This environment-backed account is the bootstrap super-admin. Open `/settings` to rename the migrated default store, add branches, or create managed admin accounts. Managed passwords are stored only as salted scrypt hashes. Existing POS token values are never returned to the browser; blank token fields preserve the saved credentials when editing.

The refresh token is required when a store is created. An expired access token cannot be renewed from the access token alone. After a successful refresh, Lambda replaces both stored tokens with the rotated values returned by the POS API.

## Legacy menu-engineering prototype

The current catalog uses `/items`, `/bases`, and `/products`, described below. `/menu-engineering` redirects to Products. The following describes the preserved earlier prototype (`20261013_menu_engineering.sql`); its store-scoped tables and APIs are retained for existing data, while new entries use the shared catalog.

The catalog is scoped to each store and supports creating, viewing, editing, and deleting raw materials, bases, add-ons, menu items, and variants. Raw materials require a material ID, name, total purchase price, purchase quantity, and UOM; supplier is optional. Bases and add-ons require a name, at least one raw material, and a yield in porsi. Menu items and variants require a name, category, positive suggested selling price, and at least one raw material, base, or add-on; variants also require a main menu item and have their own complete recipe. Categories suggest existing KasirPintar labels without cleaning them. An optional, store-unique POS item code links a menu recipe to ingested transaction items for future usage calculations.

- Raw-material unit cost = purchase price / purchase quantity; compatible mass (kg/g) and volume (l/ml) units convert automatically. Pieces cannot convert to weight or volume. Prepared ingredients use porsi.
- Base/add-on batch production cost = ingredient subtotal × 1.05; price per portion = batch cost / yield.
- Menu production cost = sum of ingredient costs, including any prepared ingredient's allowance. Direct raw materials do not receive an additional allowance. Cost percentage = production cost / suggested price × 100. Margin = suggested price − production cost; margin percentage = margin / suggested price × 100.

Costs are calculated from current material prices and yields when the catalog loads; changing either updates dependent recipe costs. No historical cost snapshot is implied. Recipe saves replace item details and ingredients in one database transaction. Referenced ingredients and main menus cannot be deleted; remove their recipe/variant references first. Item types are fixed after creation. API handlers enforce admin access, and the tables and write functions are inaccessible to Supabase anonymous/authenticated clients.

`lib/menu-engineering/model.ts` includes `theoreticalRawUsage`, which expands menu recipes into raw-material quantities using each material's purchase UOM. The 5% production cost allowance does not add physical usage. Actual usage, stock opname, receiving, and delta COGS reporting are future work.

## Local development

### Local Supabase with a production data snapshot (Windows)

Install Docker Desktop with its WSL 2 backend, complete any required Windows restart, and open Docker Desktop until its Linux engine is running. The project includes the Supabase CLI as a dev dependency. Use Node.js 22 or newer for the app and local helper scripts.

Add `SUPABASE_PRODUCTION_DB_URL` to the root `.env` using **Supabase Dashboard → Connect → Session pooler** (port 5432). Substitute the actual database password and URL-encode special characters. The existing Supabase API secret is a different credential. Keep the URI in `.env`; the helper does not print credentials or place the password in command arguments.

```powershell
npm run local:check
npm run local:source
npm run local:start
npm run local:clone
npm run dev
```

`local:clone` exports the production `public` schema and all its data in a consistent PostgreSQL archive using a read-only connection. It saves an archive, readable schema, and row-count manifest under the ignored `supabase/backups/` directory, backs up existing local data, and restores into the checked `spark-kaspin-local` Docker container. The restore and menu-engineering migration run in one local transaction. The helper compares every imported table's row count with the archive before generating `.env.local` with the local API URL and service-role key. Root `.env` production values remain intact. Restart an existing Next.js dev server after switching databases.

Local Studio is **http://127.0.0.1:54323**, the API is **http://127.0.0.1:54321**, and PostgreSQL is **127.0.0.1:54322** (database/user/password: `postgres`). Published ports are bound to loopback through a dedicated Docker network. The app uses its existing custom login; production `app_users` and password hashes are included. Supabase-managed Auth/Storage schemas, Storage files, Edge Functions, and cloud project settings are outside this app-data clone.

Production snapshots include private integration credentials and user password hashes. Keep `supabase/backups/` and `.env.local` out of source control. The helper starts database/API/Studio services; it does not start the AWS ingestion workers or Telegram bot.

Use `npm run local:status` to show local URLs, `npm run local:progress` to inspect downloaded images and container startup, `npm run local:stop` to stop services while retaining data, and `npm run local:start` to resume. `npm run local:migrate` reapplies the idempotent catalog and recipe migrations locally. Running `local:clone` again refreshes local data from production and replaces local edits after backing them up.

### Items: global purchased-stock catalog

Open `/items` using the **Items** navigation link. Access to the page and every read/write API is restricted to the existing `admin` (manager) and `super_admin` (owner) roles. Employee/staff roles are not allowed. Do not assign employee accounts the `admin` role.

The single item form saves both the item and its purchase unit. Enter a name, base unit (`g`, `kg`, `ml`, `l`, or `pcs`), purchase-unit name, number of base units in one purchase unit, purchase quantity, and total reference purchase price. For example, two 1,000 g bags at Rp30,000 total represent 2,000 g at Rp15/g. Standard mass/volume/count conversions are automatic; pack sizes are explicit. Blank IDs and update timestamps are generated automatically. The list supports name/ID search, refresh, create, edit, and confirmed deletion.

`public.items` and `public.units` are global, without `store_id`. The database saves them atomically, prevents cross-item purchase-unit references, validates standard conversions, and uses RLS with access granted only to the server service role. Future recipe/count/receipt references should use restrictive foreign keys so referenced stock cannot be deleted. This new catalog is separate from the earlier store-scoped menu-engineering prototype; it does not yet change those existing recipes.

For local setup, run `npm.cmd run local:migrate` and restart the dashboard if needed. This applies the Items migrations (`20261022_items.sql` and `20261022_item_details.sql`) along with the earlier menu-engineering migration without cloning data. A future production release must apply the Items migration to the production database before using the page there; the local helper never applies it to production.

Automatic CLI migration replay and seeding are disabled in `supabase/config.toml`: the older SQL files are manual upgrades for an existing schema, with duplicate date versions and no empty-database baseline. Use the helpers above for this workflow. They never link or push to the production project. To return Next.js to the production configuration, remove the two generated Supabase overrides from `.env.local` and restart the dev server.

### Live production transactions in the local dashboard

With Docker Desktop and local Supabase running, fetch the full production transaction history once:

```powershell
npm.cmd run local:sync
```

To keep transactions updated, run this in a separate terminal alongside `npm.cmd run dev`:

```powershell
npm.cmd run local:sync -- --watch
```

Watch mode refreshes every 30 seconds; use `--watch --interval 60` to change the interval (minimum 10 seconds). Press **Ctrl+C** to stop. The dashboard's normal refresh picks up the mirrored data. Postman can remain closed.

This uses the `SUPABASE_PRODUCTION_DB_URL` in root `.env` through a read-only PostgreSQL connection and writes only to the verified local Docker database. Each export is a consistent source snapshot, and each local update commits in one transaction. The first cycle backfills all sales; later cycles fetch new transactions and re-read today/yesterday in each store's timezone to capture receipt edits and refunds. Every 15 minutes, a full reconciliation also captures older edits and source deletions. Transaction lines are replaced for each affected receipt, including removed lines.

Production is authoritative for the local `pos_transactions` and `pos_transaction_items` tables. Existing local recipes, POS credentials, users, branch settings, and other sync history are retained; missing source branches are added without changing the local default branch. Mirror audit summaries retain production's actual successful-sync timestamp. No POS requests or token refreshes are performed locally, so the production worker remains the sole POS ingestion path. Do not run `local:clone` while watch mode is running; cloning replaces the local database, whereas `local:sync` refreshes sales only.

The latest private snapshot and sync summary are saved under ignored `supabase/backups/live-transactions/`. Only one mirror can run at a time. A failed export or local transaction leaves the last successfully mirrored data available; watch mode retries on the next interval.

Copy values from [`.env.example`](.env.example) into `.env`, then run:

```bash
pnpm install
pnpm dev
```

Without Supabase variables, the dashboard intentionally renders the supplied sample-data preview.

Deployment uses `pnpm@10.17.1` and requires Node.js 22 or newer, as declared in `package.json`. Keep `pnpm-lock.yaml` committed and synchronized whenever dependencies change. If you installed or updated dependencies with npm, run `pnpm import` to synchronize from `package-lock.json`, then verify with `pnpm install --frozen-lockfile` before pushing. Deployment checks the lockfile strictly and stops before the build if it is out of date.

## Environment variables

| Variable | Used by | Purpose |
| --- | --- | --- |
| `BASE_URL` | AWS worker | POS origin without a trailing slash |
| `TOKEN` | AWS worker | Migration fallback for the default store's initial access token |
| `REFRESH_TOKEN` | AWS worker | Migration fallback for the default store's initial refresh token |
| `REFRESH_TIME` | AWS and dashboard | AWS polling or frontend refresh interval; configure separately per service |
| `POS_UTC_OFFSET` | AWS worker | Legacy default-store fallback; settings now store each branch offset |
| `POS_TIME_ZONE` | AWS worker | Legacy default-store fallback; settings now store each branch timezone |
| `SUPABASE_URL` | AWS and Vercel | Supabase project URL |
| `SUPABASE_SECRET_KEY` | AWS and Vercel server | Private `sb_secret_…` server key |
| `TELEGRAM_BOT_TOKEN` | Telegram Lambda | BotFather token |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram Lambda | Validates Telegram’s webhook header |
| `TELEGRAM_ALLOWED_CHAT_ID` | Telegram Lambda | Only this chat can run commands |
| `SETTINGS_ADMIN_USERNAME` | Vercel | Username protecting `/settings` and `/api/stores` |
| `SETTINGS_ADMIN_PASSWORD` | Vercel | Long unique password for the bootstrap super-admin |
| `AUTH_SESSION_SECRET` | Vercel | Signs 12-hour HTTP-only dashboard sessions |

## Cost and timing note

A continuously scheduled 58-second, 128 MB Lambda uses approximately 313,000 GB-seconds in a 30-day month before overhead. That is below AWS Lambda’s standard 400,000 GB-second monthly free allowance if your account is eligible and the allowance is not used elsewhere. Data transfer, logs, Supabase usage, or other AWS resources can still produce charges. Create an AWS Budget alert before leaving the worker enabled.

Three seconds is aggressive for a transaction-report endpoint. Confirm the POS provider permits that request frequency. A store never starts a second request before its previous cycle finishes. Adding stores increases POS and Supabase traffic, although the scheduled Lambda duration remains capped at 58 seconds.

`sync_runs` keeps one row per active store per scheduled Lambda invocation rather than one row per three-second cycle. Successful summaries older than 7 days and failed summaries older than 30 days are removed by the worker's hourly retention pass.

## Validation

```bash
pnpm test
pnpm lint
pnpm build
pnpm aws:validate  # requires AWS SAM CLI
pnpm aws:build     # requires AWS SAM CLI
```

The source `api.json`, `.env`, `.aws-sam`, and `samconfig.toml` are excluded from source control because they can contain operational data or secrets.

Items can use an optional unique ID (up to 80 letters, numbers, dots, hyphens, or underscores); blank IDs are generated. IDs remain fixed after creation. Optional Supplier notes are free text (up to 1,000 characters), editable in the same form and shown in the catalog.

### Bases and current recipes

Open `/bases` from Items, Products, or the dashboard. Manager/owner access matches Items; employee roles are denied on the page and all APIs. Bases are global across stores. Name, base unit, positive batch yield, and at least one raw-material ingredient are required; the ID is optional and fixed after creation. Portions (`porsi`) are the default output unit; g/kg/ml/l/pcs are also supported. Changing the output unit does not automatically convert a yield. Portion-to-weight conversions are not part of this MVP.

One form atomically saves `bases`, its one current `recipes` row, and `recipe_ingredients`. Recipes use the new Items catalog only (no nested bases or historical recipe versions). Ingredient units can use compatible standard units or that item's purchase pack. Costing uses current reference prices and conversions, adds 5% production allowance, and divides by batch yield. Refresh picks up changes made in Items. Base identity, yield and ingredient rows can be edited together; deletion removes its recipe and lines, while future restrictive references block deletion. Items used by recipes cannot be deleted, and changes to item units must keep existing recipes valid.

Run `npm.cmd run local:migrate` to apply `20261022_bases.sql` after the Items migrations. The local helper never applies changes to production. Existing menu-engineering prototype records are preserved; new raw-material/base entry routes to Items/Bases. Product recipes now use the shared recipe tables through `/products`.

### Products and categories

Open `/products` for Menu, Variant and Add-on products. One form saves a product and its current recipe together; recipes require 1–200 ingredients from Items and/or Bases and define a batch yield quantity and output unit (porsi, g/kg, ml/l, or pcs). Selling price is per ONE selected output unit. Existing products retain their quantities with a default yield of 1 porsi. Variants reference a main Menu product and retain their own complete recipe and selling price. Main menus used by variants cannot be deleted or changed into another type. Optional IDs follow the Items/Bases convention and stay fixed after creation. A zero selling price is supported; percentage metrics are undefined and displayed as a dash.

Categories are optional and shared across stores. Select a category or choose **+ Create category** within the product form. Creation trims names and reuses an existing category when only capitalization differs. There is no separate Categories page or category hierarchy in this MVP.

Batch production cost sums raw-material costs and base costs at current reference prices. Cost per output unit = batch cost / yield. Ingredient quantities describe the entire batch. Base costs already include their 5% allowance; Products adds no second allowance. Cost percentage = cost per output unit / selling price × 100. Margin per output unit = selling price − cost per output unit. Refresh reloads ingredient prices and recipes. Portion-based bases can only be consumed in portions; mass/volume conversions work within their dimensions, and raw materials can also use their defined purchase packs.

Only managers/owners can access Products and Categories or their APIs. New tables use RLS with server service-role access only. Apply `20261022_products.sql` after the Bases migration using `npm.cmd run local:migrate` locally; the helper never pushes production migrations. The previous `/menu-engineering` page now redirects to Products; its legacy tables and APIs are preserved. There are no POS product writes or automatic POS mappings in this change.

### Stock opname

Open **Stock Opname** from the dashboard or catalog navigation (`/stock-opname`) for the manager/owner form and history. Employees use `/staff/stock-opname` from the login page without an account; their separate form has no history or dashboard navigation. The selected counter name is independent of the dashboard account.

Select a store and counter; the system records the submission date/time in that store's timezone. The fixed form contains 6 prep quantities, 22 inventory quantities, and 12 explicit Ya/Tidak restock answers. All 40 answers are required; zero and fractional quantities are accepted, while blank answers are never treated as zero or Tidak. There are no price fields. One save atomically writes `stock_opnames` and its `stock_opname_lines`; retrying the same submission does not create another record. Managers can expand recent submissions below their authenticated form.

Counts retain the displayed units (Pack, Tray, Karung, etc.) and do not post inventory movements. The dashboard consumption panel separately converts them using explicit count-unit definitions. Prep and restock entries are operational only. Existing Items/Bases are linked by an unambiguous name match when available; incomplete prep catalog data does not block a count. Labels and count units are retained with the submission.

Run `npm.cmd run local:migrate` to install `20261022_stock_opname.sql` after Products in local Supabase. The new tables and submission function allow server service-role access only. `tests/stock-opname-database.sql` provides rollback-only local database checks.

### Receiving

Open **Receiving** (`/receiving`) from the dashboard, Stock Opname, or catalog navigation. It uses the current dashboard manager/owner login and the same employee-name list as Stock Opname. Select the store and receiver, then add 1–100 existing Items with positive quantities. Item search accepts names or IDs. Duplicate items should be combined into one row; fractional quantities are allowed. Receiving defaults to the item's purchase unit and allows compatible standard units (g/kg, ml/l, or pcs) plus that configured purchase unit. There are no prices, purchase orders, invoices, or supplier fields.

One save atomically writes `receivings` and `receiving_lines`, with server-recorded receipt time and signed-in submitter. Entry time is treated as receipt time; backdated receiving is deferred. A repeated request with the same submission ID and items returns the saved receipt instead of duplicating it. Recent receipts for the selected store appear in expandable history. History refresh errors do not invalidate a successful save.

The database verifies that every item exists, checks that it has not changed since the form loaded, and snapshots its name, purchase unit definition, selected receiving unit and conversion. The received amount is retained in the chosen unit, alongside its calculated base quantity. Unknown packs and incompatible dimensions are rejected by the database. Later catalog edits cannot rewrite historical receiving quantities or units. Referenced items/units cannot be deleted. A stale form must be reloaded and quantities/units checked before submitting. The operational catalog projection and receiving history contain no monetary fields.

Receiving does not overwrite stock opname or update an inventory balance. Its saved quantities feed the separate dashboard consumption engine. Run `npm.cmd run local:migrate` to install `20261022_receiving.sql` locally after Stock Opname. Tables and submission functions remain restricted to the server service role. `tests/receiving-database.sql` contains rollback-only checks.

Product yields and receiving unit selection are installed locally by `20261024_product_yields_receiving_units.sql` via `npm.cmd run local:migrate`. Existing receipts are backfilled using their original saved purchase units; their quantities remain unchanged. Inventory balances remain deferred. Public employee entry is available through the standalone forms described below. The dashboard groups navigation into Catalogue and Inventory; count-unit definitions live in its Consumption variance panel.

### Quantity consumption / delta COGS

The dashboard's **Consumption variance** panel compares the 22 inventory materials from the fixed stock-opname form. It contains no monetary values. Prep stock and Ya/Tidak restock answers remain operational only.

Apply `20261024_cogs_quantity_engine.sql` after the other catalog migrations. `npm.cmd run local:migrate` includes it and only changes the checked local Supabase container. For a hosted deployment, apply the migration to that environment separately. The migration adds store-specific POS-to-product links, count-unit definitions and an optional physical `counted_at` timestamp; it does not change POS ingestion, rewrite counts or populate guessed mappings. New configuration tables and APIs are manager/owner only, with database access limited to the server service role.

To enable results for a store:

1. Complete the Products/Bases recipes and batch yields. Purchased resale products can use a one-item recipe. Variants have their own complete recipes; separately sold add-ons have their own POS links.
2. Expand **Set up POS links & count units → POS → Products**. Link each observed Kasirpintar `item_code` to its catalogue product. Confirm the product output quantity represented by **one** POS unit. For example, one POS serving may mean 1 porsi or 250 g; batch yield is handled separately. A shared product can have different POS codes in each store. No automatic fuzzy name matching or writes back to Kasirpintar occur.
3. Under **Count units → Raw materials**, define each inventory count line and the amount in one Pack/Tray/Karung/etc. For example, enter the measured grams per beef pack; do not assume the purchase unit and stock-count pack have the same size. Each raw material can occupy only one inventory line per store. These definitions are independent of purchase prices.
4. Submit two physical stock counts. Current forms automatically use submission time as the count cutoff, so staff should submit promptly after counting. Old date-only counts retain a missing time and cannot establish an interval. Counts with identical times are ambiguous and rejected by the report.
5. Enter all deliveries promptly in Receiving and ensure sales for every covered date have synced through the closing count. An interval crossing midnight requires a full sync of the previous date after that date has ended; the existing scheduled worker normally polls today's date. Receiving currently uses entry time as receipt time; backdated receiving is not supported.

The calculation uses **opening time < event time ≤ closing time**, scoped to one store. Actual quantity = opening count + saved receiving base quantities − closing count. Theoretical quantity = net POS quantities (sold minus returned) × mapped output quantities × raw-material recipe amounts per output unit. Product and base batch yields and compatible units are applied; the 5% monetary base-cost allowance is never applied to physical quantities. Receiving uses its saved base-unit conversion, preserving amounts after catalog edits. Changed incompatible units, missing links, invalid returns, incomplete sale details or insufficient sync coverage produce unavailable values rather than fabricated zeroes. Any unresolved positive sale withholds all theoretical totals and differences, since its ingredients are unknown. Negative actual usage is shown as a stock-gain warning with no difference.

`cogs_sales_coverage` retains one watermark per store/business date because successful `sync_runs` audits are pruned after seven days. A trigger captures successful syncs (including local mirror audit inserts) and backfills existing audit evidence during migration. Coverage uses the run's **start time**, conservatively proving that at least one successful fetch began after the required cutoff; completion time alone is not enough. Watermarks survive audit cleanup and do not regress when an older mirror summary is replayed. This does not prove that the POS itself has finished posting late edits/returns; re-sync affected dates when those occur.

Live/Daily/Monthly calendar filters select possible closing counts. The panel shows **one selected closing count and its preceding timed count**, with exact bounds; it is not a summed daily/monthly consumption report. The preceding count may fall before the calendar filter. Actual usage changes only when a new count closes an interval. The panel refreshes once per minute and supports manual refresh. The MVP uses current recipes and count definitions for past intervals; recipe or conversion edits recalculate past results. Intervals longer than 93 days require a closer physical count.

Delta = actual − theoretical. A positive delta is not proof of waste or loss: ingredients moved into unsold prepared bases are included in raw-material disappearance while prep balances are excluded by design. Refunds also reduce theoretical usage without proving that physical ingredients returned to stock. Neither factor is adjusted automatically.

Run `npm.cmd test` for engine, API and loader checks. `tests/cogs-database.sql` provides rollback-only local checks for mapping constraints, access grants and physical-count timestamp retries.

### Employee Stock Opname and Receiving

The login page now has **Untuk tim toko → Stock opname / Receiving** links. The standalone pages are `/staff/stock-opname` and `/staff/receiving`. They require no dashboard account. Each is a separate form with no logo header, tabs, dashboard/catalogue navigation, prices or submission history. Only active-store choices and the receiving form's minimal item/name/unit choices are exposed. Employee names use the existing fixed list; the selected name is a claimed identity, not an authenticated account. Anyone who has a form link can submit it.

Public access is limited to GET/HEAD on those two page paths and POST on `/api/staff/stock-opname` and `/api/staff/receiving`. Other dashboard pages, catalogue/history APIs, and COGS remain protected. Public submission endpoints validate the same complete answers and item revisions as the manager forms, reject cross-origin browser submissions and oversized/non-JSON payloads, and return only a submission ID/retry status. Database service-role credentials stay on the server. No direct database permissions were granted to anonymous users. The authenticated manager pages retain their history views.

Stock Opname keeps all 40 required answers and displays only a thin fixed progress line while scrolling. Both forms use **Selesai** at the end of the form, without a floating footer. The section hints are **Untuk menentukan jumlah prep besok.** and **Hitung dan isi sesuai satuan.**; restock guidance stays unchanged. Number badges use a soft green background, and both Ya/Tidak choices use the same green selected state. Receiving still supports multiple items, compatible standard units and each item's purchase unit, without monetary fields.

The current forms use automatic server submission time. `20261024_employee_forms.sql` adds `submit_stock_opname_now`, which records equal `counted_at` and `submitted_at` values and derives the count date in the store timezone. Retrying the same submission preserves its original date/time, including after midnight; conflicting retries are rejected. Previously saved timestamps are unchanged, and the older explicit-time API remains compatible. Employees should submit promptly after counting because the COGS engine now treats submission as the physical count cutoff. Receiving already records server receipt time automatically.

Run `npm.cmd run local:migrate` to install locally. Before publishing the employee links on a hosted deployment, apply `20261024_employee_forms.sql` there after the existing migrations and deploy this app version. Localhost links are for this computer; employees need the hosted website URL to use the forms on their own phones. `tests/employee-forms-database.sql` checks automatic timestamps, retries and private database grants in a rollback-only transaction.
