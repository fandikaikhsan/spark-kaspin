create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  time_zone text not null check (time_zone in ('Asia/Jakarta', 'Asia/Makassar')),
  utc_offset text not null check (
    (time_zone = 'Asia/Jakarta' and utc_offset = '+07:00') or
    (time_zone = 'Asia/Makassar' and utc_offset = '+08:00')
  ),
  is_default boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists stores_single_default_idx
  on public.stores (is_default)
  where is_default;

create table if not exists public.integration_credentials (
  store_id uuid not null references public.stores(id) on delete cascade,
  provider text not null default 'pos',
  access_token text,
  refresh_token text not null,
  access_token_expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (store_id, provider)
);

create table if not exists public.pos_transactions (
  store_id uuid not null references public.stores(id) on delete cascade,
  transaction_code text not null,
  receipt_number bigint not null,
  business_date date not null,
  business_hour smallint not null check (business_hour between 0 and 23),
  occurred_at timestamptz not null,
  subtotal numeric(14, 2) not null default 0,
  grand_total numeric(14, 2) not null default 0,
  payment_type text not null default 'unknown',
  synced_at timestamptz not null default now(),
  primary key (store_id, transaction_code)
);

create index if not exists pos_transactions_store_date_idx
  on public.pos_transactions (store_id, business_date, business_hour);
create index if not exists pos_transactions_store_date_occurred_idx
  on public.pos_transactions (store_id, business_date, occurred_at desc);

create table if not exists public.pos_transaction_items (
  store_id uuid not null,
  transaction_code text not null,
  line_number integer not null,
  item_code text not null,
  item_name text not null,
  category text not null default 'Uncategorized',
  quantity numeric(12, 3) not null default 0,
  returned_quantity numeric(12, 3) not null default 0,
  gross_sales numeric(14, 2) not null default 0,
  primary key (store_id, transaction_code, line_number),
  foreign key (store_id, transaction_code)
    references public.pos_transactions(store_id, transaction_code)
    on delete cascade
);

create index if not exists pos_transaction_items_store_item_idx
  on public.pos_transaction_items (store_id, item_code);

create table if not exists public.sync_runs (
  id bigint generated always as identity primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  business_date date not null,
  trigger text not null,
  status text not null check (status in ('running', 'success', 'failed')),
  successful_cycles integer not null default 0,
  failed_cycles integer not null default 0,
  transaction_count integer not null default 0,
  item_count integer not null default 0,
  error_message text,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists sync_runs_store_status_completed_idx
  on public.sync_runs (store_id, status, completed_at desc);

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null,
  normalized_username text not null unique,
  password_hash text not null,
  role text not null default 'admin' check (role in ('admin')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (normalized_username = lower(normalized_username))
);

create or replace view public.pos_hourly_item_sales
with (security_invoker = true) as
select
  t.store_id,
  t.business_date,
  t.business_hour,
  i.item_code,
  max(i.item_name) as item_name,
  max(i.category) as category,
  sum(greatest(i.quantity - i.returned_quantity, 0)) as quantity,
  sum(i.gross_sales) as revenue
from public.pos_transaction_items i
join public.pos_transactions t
  on t.store_id = i.store_id
 and t.transaction_code = i.transaction_code
group by t.store_id, t.business_date, t.business_hour, i.item_code;

alter table public.stores enable row level security;
alter table public.integration_credentials enable row level security;
alter table public.pos_transactions enable row level security;
alter table public.pos_transaction_items enable row level security;
alter table public.sync_runs enable row level security;
alter table public.app_users enable row level security;

-- No public policies are created. The dashboard, settings API, and Lambda
-- use a server-side Supabase secret key, which bypasses RLS.
revoke all on table public.stores from anon, authenticated;
revoke all on table public.integration_credentials from anon, authenticated;
revoke all on table public.pos_transactions from anon, authenticated;
revoke all on table public.pos_transaction_items from anon, authenticated;
revoke all on table public.sync_runs from anon, authenticated;
revoke all on table public.app_users from anon, authenticated;
revoke all on table public.pos_hourly_item_sales from anon, authenticated;
