create table if not exists public.integration_credentials (
  provider text primary key,
  access_token text,
  refresh_token text not null,
  access_token_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.pos_transactions (
  transaction_code text primary key,
  receipt_number bigint not null,
  business_date date not null,
  business_hour smallint not null check (business_hour between 0 and 23),
  occurred_at timestamptz not null,
  subtotal numeric(14, 2) not null default 0,
  grand_total numeric(14, 2) not null default 0,
  payment_type text not null default 'unknown',
  synced_at timestamptz not null default now()
);

create index if not exists pos_transactions_business_date_idx
  on public.pos_transactions (business_date, business_hour);

create table if not exists public.pos_transaction_items (
  transaction_code text not null references public.pos_transactions(transaction_code) on delete cascade,
  line_number integer not null,
  item_code text not null,
  item_name text not null,
  category text not null default 'Uncategorized',
  quantity numeric(12, 3) not null default 0,
  returned_quantity numeric(12, 3) not null default 0,
  gross_sales numeric(14, 2) not null default 0,
  primary key (transaction_code, line_number)
);

create index if not exists pos_transaction_items_item_code_idx
  on public.pos_transaction_items (item_code);

create table if not exists public.sync_runs (
  id bigint generated always as identity primary key,
  business_date date not null,
  trigger text not null,
  status text not null check (status in ('running', 'success', 'failed')),
  transaction_count integer not null default 0,
  item_count integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists sync_runs_status_completed_idx
  on public.sync_runs (status, completed_at desc);

create or replace view public.pos_hourly_item_sales
with (security_invoker = true) as
select
  t.business_date,
  t.business_hour,
  i.item_code,
  max(i.item_name) as item_name,
  max(i.category) as category,
  sum(greatest(i.quantity - i.returned_quantity, 0)) as quantity,
  sum(i.gross_sales) as revenue
from public.pos_transaction_items i
join public.pos_transactions t on t.transaction_code = i.transaction_code
group by t.business_date, t.business_hour, i.item_code;

alter table public.integration_credentials enable row level security;
alter table public.pos_transactions enable row level security;
alter table public.pos_transaction_items enable row level security;
alter table public.sync_runs enable row level security;

-- No public policies are created. This application queries these tables only
-- with a server-side Supabase secret key, which uses the service_role and bypasses RLS.
revoke all on table public.integration_credentials from anon, authenticated;
revoke all on table public.pos_transactions from anon, authenticated;
revoke all on table public.pos_transaction_items from anon, authenticated;
revoke all on table public.sync_runs from anon, authenticated;
revoke all on table public.pos_hourly_item_sales from anon, authenticated;
