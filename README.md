# Kaspin POS analytics

A Next.js dashboard with an AWS Lambda ingestion worker. The worker fetches daily POS transactions every three seconds, refreshes expired POS tokens, and stores normalized data in Supabase. Telegram provides manual `/sync` and `/status` commands through a separate Lambda Function URL.

## Architecture

```text
EventBridge rule (once/minute)
  └─> 58-second polling Lambda
        └─> POS every REFRESH_TIME seconds
              └─> Supabase transactions + hourly view

Telegram webhook ─> Telegram Lambda ─> immediate POS sync ─> Supabase

Browser ─> Vercel Next.js dashboard ─> Supabase hourly view
```

EventBridge itself has one-minute precision. The scheduled Lambda remains active for most of each minute and runs sequential polling cycles internally. Reserved concurrency is `1`, preventing two scheduled workers from overlapping.

## Included

- Access-token refresh using the seed `REFRESH_TOKEN`
- Rotated refresh-token persistence in the private `integration_credentials` table
- Idempotent transaction and item-line upserts
- Three-second scheduled POS ingestion through AWS Lambda
- Separate Telegram Lambda with `/sync [YYYY-MM-DD]` and `/status`
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
- `/sync`
- `/sync 2026-09-27`

## 5. Vercel dashboard setup

Vercel now hosts only the dashboard and `/api/analytics`; it has no cron configuration.

Add these server-side environment variables to the Vercel project:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY`
- `REFRESH_TIME=3`
- `POS_TIME_ZONE=Asia/Jakarta`

The POS and Telegram secrets are not needed in Vercel because those responsibilities run in AWS.

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
| `TOKEN` | AWS worker | Initial POS access token; it may be expired |
| `REFRESH_TOKEN` | AWS worker | Seed refresh token used until a rotated token is stored |
| `REFRESH_TIME` | AWS and dashboard | Polling and frontend refresh interval in seconds; minimum `3` |
| `POS_UTC_OFFSET` | AWS worker | POS timestamp offset, default `+07:00` |
| `POS_TIME_ZONE` | AWS and dashboard | Business timezone, default `Asia/Jakarta` |
| `SUPABASE_URL` | AWS and Vercel | Supabase project URL |
| `SUPABASE_SECRET_KEY` | AWS and Vercel server | Private `sb_secret_…` server key |
| `TELEGRAM_BOT_TOKEN` | Telegram Lambda | BotFather token |
| `TELEGRAM_WEBHOOK_SECRET` | Telegram Lambda | Validates Telegram’s webhook header |
| `TELEGRAM_ALLOWED_CHAT_ID` | Telegram Lambda | Only this chat can run commands |

## Cost and timing note

A continuously scheduled 58-second, 128 MB Lambda uses approximately 313,000 GB-seconds in a 30-day month before overhead. That is below AWS Lambda’s standard 400,000 GB-second monthly free allowance if your account is eligible and the allowance is not used elsewhere. Data transfer, logs, Supabase usage, or other AWS resources can still produce charges. Create an AWS Budget alert before leaving the worker enabled.

Three seconds is aggressive for a transaction-report endpoint. Confirm the POS provider permits that request frequency. The design is sequential, so it never starts a second POS request before the previous one completes.

## Validation

```bash
pnpm test
pnpm lint
pnpm build
pnpm aws:validate  # requires AWS SAM CLI
pnpm aws:build     # requires AWS SAM CLI
```

The source `api.json`, `.env`, `.aws-sam`, and `samconfig.toml` are excluded from source control because they can contain operational data or secrets.
