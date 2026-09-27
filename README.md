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
- Demo dashboard data until Supabase is configured

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
- Node.js 20 or newer
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

The POS and Telegram secrets are not needed in Vercel because those responsibilities run in AWS.

After redeploying Vercel, open `/settings`. The browser will request the settings username and password. Rename the migrated default store or add branches, select either `Asia/Jakarta` (UTC+7) or `Asia/Makassar` (UTC+8), and enter both the initial access token and refresh token. Existing token values are never returned to the browser; blank token fields preserve the saved credentials when editing.

The refresh token is required when a store is created. An expired access token cannot be renewed from the access token alone. After a successful refresh, Lambda replaces both stored tokens with the rotated values returned by the POS API.

## Local development

Copy values from [`.env.example`](.env.example) into `.env`, then run:

```bash
pnpm install
pnpm dev
```

Without Supabase variables, the dashboard intentionally renders the supplied sample-data preview.

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
| `SETTINGS_ADMIN_PASSWORD` | Vercel | Long unique password protecting store and token changes |

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
