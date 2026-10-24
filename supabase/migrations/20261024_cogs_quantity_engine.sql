-- Quantity variance only. Shared catalog, store-specific POS codes and count packaging.
begin;
create table if not exists public.cogs_pos_mappings (
  store_id uuid not null references public.stores(id) on delete restrict,
  item_code text not null check(length(btrim(item_code)) between 1 and 200 and item_code !~ '^unknown-[0-9]+$'),
  product_id text not null references public.products(id) on delete restrict,
  output_quantity numeric not null check(output_quantity between 0.000000001 and 1000000000000),
  output_uom text not null check(output_uom in ('porsi','g','kg','ml','l','pcs')),
  primary key(store_id,item_code)
);
create table if not exists public.cogs_count_mappings (
  store_id uuid not null references public.stores(id) on delete restrict,
  field_key text not null check(public.stock_opname_field_section(field_key) is not null and public.stock_opname_field_section(field_key)='inventory'),
  item_id text not null references public.items(id) on delete restrict,
  conversion numeric not null check(conversion between 0.000000001 and 1000000000000),
  base_uom text not null check(base_uom in ('g','kg','ml','l','pcs')),
  primary key(store_id,field_key),
  unique(store_id,item_id)
);
alter table public.cogs_pos_mappings enable row level security;
alter table public.cogs_count_mappings enable row level security;
revoke all on public.cogs_pos_mappings,public.cogs_count_mappings from public,anon,authenticated;
grant all on public.cogs_pos_mappings,public.cogs_count_mappings to service_role;

-- The worker prunes successful audit runs after 7 days. Keep one durable coverage
-- watermark per business date, not an audit/version history. A run's START time is
-- conservative: a later completion does not prove its last successful fetch was later.
create table if not exists public.cogs_sales_coverage (
  store_id uuid not null references public.stores(id) on delete restrict,
  business_date date not null,
  confirmed_through timestamptz not null,
  completed_at timestamptz not null,
  primary key(store_id,business_date),
  check(confirmed_through<=completed_at)
);
alter table public.cogs_sales_coverage enable row level security;
revoke all on public.cogs_sales_coverage from public,anon,authenticated;
grant all on public.cogs_sales_coverage to service_role;
create or replace function public.preserve_cogs_sales_coverage()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.status='success' and new.successful_cycles>0 and new.started_at is not null
    and new.completed_at is not null and new.started_at<=new.completed_at then
    insert into public.cogs_sales_coverage(store_id,business_date,confirmed_through,completed_at)
      values(new.store_id,new.business_date,new.started_at,new.completed_at)
      on conflict(store_id,business_date) do update set confirmed_through=excluded.confirmed_through,completed_at=excluded.completed_at
      where excluded.confirmed_through>cogs_sales_coverage.confirmed_through;
  end if;
  return new;
end;
$$;
drop trigger if exists sync_runs_cogs_coverage on public.sync_runs;
create trigger sync_runs_cogs_coverage after insert or update of status,started_at,completed_at on public.sync_runs
  for each row execute function public.preserve_cogs_sales_coverage();
insert into public.cogs_sales_coverage(store_id,business_date,confirmed_through,completed_at)
  select distinct on (store_id,business_date) store_id,business_date,started_at,completed_at from public.sync_runs
  where status='success' and successful_cycles>0 and started_at is not null and completed_at is not null and started_at<=completed_at
  order by store_id,business_date,started_at desc,completed_at desc
  on conflict(store_id,business_date) do update set confirmed_through=excluded.confirmed_through,completed_at=excluded.completed_at
  where excluded.confirmed_through>cogs_sales_coverage.confirmed_through;
revoke all on function public.preserve_cogs_sales_coverage() from public,anon,authenticated;
grant execute on function public.preserve_cogs_sales_coverage() to service_role;

-- A submission timestamp is not necessarily the physical count's time. Old counts
-- retain NULL rather than acquiring an invented timestamp.
alter table public.stock_opnames add column if not exists counted_at timestamptz;
create index if not exists stock_opnames_count_time on public.stock_opnames(store_id,counted_at desc,id desc);
create index if not exists pos_transactions_cogs_interval on public.pos_transactions(store_id,occurred_at,transaction_code);
create or replace function public.submit_stock_opname_at(p_id uuid,p_store uuid,p_date date,p_counter text,p_submitted_by text,p_lines jsonb,p_counted_at timestamptz)
returns jsonb language plpgsql set search_path=public as $$
declare v_result jsonb; v_zone text; v_previous timestamptz;
begin
  select time_zone into v_zone from public.stores where id=p_store and active for share;
  if v_zone is null or p_counted_at is null or not isfinite(p_counted_at)
    or (p_counted_at at time zone v_zone)::date <> p_date or p_counted_at > clock_timestamp()+interval '5 minutes' then
    raise exception 'Count time must match the store date and cannot be in the future' using errcode='23514';
  end if;
  v_result:=public.submit_stock_opname(p_id,p_store,p_date,p_counter,p_submitted_by,p_lines);
  select counted_at into v_previous from public.stock_opnames where id=p_id for update;
  if (v_result->>'replayed')::boolean and v_previous is distinct from p_counted_at then
    raise exception 'Submission ID already used with a different count time' using errcode='23505';
  end if;
  if not (v_result->>'replayed')::boolean then
    update public.stock_opnames set counted_at=p_counted_at where id=p_id;
  end if;
  return v_result;
end;
$$;
revoke all on function public.submit_stock_opname_at(uuid,uuid,date,text,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.submit_stock_opname_at(uuid,uuid,date,text,text,jsonb,timestamptz) to service_role;
notify pgrst,'reload schema';
commit;
