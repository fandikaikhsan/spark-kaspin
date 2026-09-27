begin;

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

create index if not exists pos_transactions_store_date_occurred_idx
  on public.pos_transactions (store_id, business_date, occurred_at desc);

alter table public.app_users enable row level security;
revoke all on table public.app_users from anon, authenticated;

commit;
