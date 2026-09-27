begin;

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

insert into public.stores (name, time_zone, utc_offset, is_default)
select 'Default store', 'Asia/Jakarta', '+07:00', true
where not exists (select 1 from public.stores);

alter table public.integration_credentials
  add column if not exists store_id uuid references public.stores(id) on delete cascade;
alter table public.pos_transactions
  add column if not exists store_id uuid references public.stores(id) on delete cascade;
alter table public.pos_transaction_items
  add column if not exists store_id uuid;
alter table public.sync_runs
  add column if not exists store_id uuid references public.stores(id) on delete cascade,
  add column if not exists successful_cycles integer not null default 0,
  add column if not exists failed_cycles integer not null default 0;

update public.integration_credentials
set store_id = (select id from public.stores where is_default limit 1)
where store_id is null;

update public.pos_transactions
set store_id = (select id from public.stores where is_default limit 1)
where store_id is null;

update public.pos_transaction_items i
set store_id = t.store_id
from public.pos_transactions t
where i.store_id is null
  and i.transaction_code = t.transaction_code;

update public.sync_runs
set store_id = (select id from public.stores where is_default limit 1)
where store_id is null;

drop view if exists public.pos_hourly_item_sales;

alter table public.pos_transaction_items
  drop constraint if exists pos_transaction_items_transaction_code_fkey;
alter table public.integration_credentials
  drop constraint if exists integration_credentials_pkey;
alter table public.pos_transactions
  drop constraint if exists pos_transactions_pkey;
alter table public.pos_transaction_items
  drop constraint if exists pos_transaction_items_pkey;

alter table public.integration_credentials alter column store_id set not null;
alter table public.pos_transactions alter column store_id set not null;
alter table public.pos_transaction_items alter column store_id set not null;
alter table public.sync_runs alter column store_id set not null;

alter table public.integration_credentials
  add constraint integration_credentials_pkey primary key (store_id, provider);
alter table public.pos_transactions
  add constraint pos_transactions_pkey primary key (store_id, transaction_code);
alter table public.pos_transaction_items
  add constraint pos_transaction_items_pkey primary key (store_id, transaction_code, line_number);
alter table public.pos_transaction_items
  add constraint pos_transaction_items_store_transaction_fkey
  foreign key (store_id, transaction_code)
  references public.pos_transactions(store_id, transaction_code)
  on delete cascade;

drop index if exists public.pos_transactions_business_date_idx;
drop index if exists public.pos_transaction_items_item_code_idx;
drop index if exists public.sync_runs_status_completed_idx;

create index if not exists pos_transactions_store_date_idx
  on public.pos_transactions (store_id, business_date, business_hour);
create index if not exists pos_transaction_items_store_item_idx
  on public.pos_transaction_items (store_id, item_code);
create index if not exists sync_runs_store_status_completed_idx
  on public.sync_runs (store_id, status, completed_at desc);

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
revoke all on table public.stores from anon, authenticated;
revoke all on table public.pos_hourly_item_sales from anon, authenticated;

commit;
