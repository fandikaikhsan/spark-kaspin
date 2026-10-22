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
-- Store-scoped recipe catalog. Run after the multi-store and dashboard-auth migrations.
begin;

create table if not exists public.engineering_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  type text not null check (type in ('raw_material', 'base', 'addon', 'menu_item', 'variant')),
  code text not null check (length(btrim(code)) between 1 and 200),
  name text not null check (length(btrim(name)) between 1 and 200),
  purchase_price numeric check (purchase_price >= 0 and purchase_price <= 1000000000000),
  purchase_quantity numeric check (purchase_quantity > 0 and purchase_quantity <= 1000000000000),
  uom text check (uom in ('g', 'kg', 'ml', 'l', 'pcs')),
  supplier text,
  yield_portions numeric check (yield_portions > 0 and yield_portions <= 1000000000000),
  category text,
  suggested_price numeric check (suggested_price > 0 and suggested_price <= 1000000000000),
  parent_id uuid,
  pos_item_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  foreign key (store_id, parent_id) references public.engineering_items(store_id, id) on delete restrict,
  check (parent_id is null or parent_id <> id),
  check (
    (type = 'raw_material' and purchase_price is not null and purchase_quantity is not null and uom is not null
      and yield_portions is null and category is null and suggested_price is null and parent_id is null and pos_item_code is null)
    or (type in ('base', 'addon') and yield_portions is not null and purchase_price is null and purchase_quantity is null
      and uom is null and supplier is null and category is null and suggested_price is null and parent_id is null and pos_item_code is null)
    or (type in ('menu_item', 'variant') and length(btrim(category)) > 0 and category is not null and suggested_price is not null
      and purchase_price is null and purchase_quantity is null and uom is null and supplier is null and yield_portions is null
      and ((type = 'variant' and parent_id is not null) or (type = 'menu_item' and parent_id is null)))
  )
);
create unique index if not exists engineering_items_store_code_idx on public.engineering_items(store_id, lower(code));
create unique index if not exists engineering_items_pos_code_idx on public.engineering_items(store_id, pos_item_code) where pos_item_code is not null;
create index if not exists engineering_items_parent_idx on public.engineering_items(store_id, parent_id);

create table if not exists public.engineering_ingredients (
  store_id uuid not null,
  recipe_id uuid not null,
  ingredient_id uuid not null,
  quantity numeric not null check (quantity > 0 and quantity <= 1000000000000),
  uom text not null check (uom in ('g', 'kg', 'ml', 'l', 'pcs', 'porsi')),
  position integer not null check (position >= 0),
  primary key (recipe_id, ingredient_id),
  foreign key (store_id, recipe_id) references public.engineering_items(store_id, id) on delete cascade,
  foreign key (store_id, ingredient_id) references public.engineering_items(store_id, id) on delete restrict,
  check (recipe_id <> ingredient_id)
);
create index if not exists engineering_ingredients_reference_idx on public.engineering_ingredients(store_id, ingredient_id);
alter table public.engineering_items enable row level security;
alter table public.engineering_ingredients enable row level security;
revoke all on public.engineering_items, public.engineering_ingredients from anon, authenticated;
grant all on public.engineering_items, public.engineering_ingredients to service_role;

create or replace view public.pos_menu_categories with (security_invoker = true) as
select distinct store_id, category from public.pos_transaction_items where btrim(category) <> '';
revoke all on public.pos_menu_categories from anon, authenticated;
grant select on public.pos_menu_categories to service_role;

-- One transaction replaces the item and its ingredient rows. Locking the store serializes
-- catalog writes, including edits/deletes of ingredients referenced by concurrent saves.
create or replace function public.save_engineering_item(p_store_id uuid, p_id uuid, p_input jsonb)
returns uuid language plpgsql set search_path = public as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_type text := p_input->>'type';
  v_old_type text;
  v_code text;
begin
  perform 1 from public.stores where id = p_store_id for update;
  if not found then raise exception 'Store not found'; end if;
  if p_id is not null then
    select type into v_old_type from public.engineering_items where id = p_id and store_id = p_store_id;
    if not found then raise exception 'Item not found'; end if;
    if v_old_type <> v_type then raise exception 'An existing item type cannot be changed'; end if;
  end if;
  if jsonb_typeof(p_input->'ingredients') is distinct from 'array' then raise exception 'Ingredients must be an array'; end if;
  if (v_type = 'raw_material' and jsonb_array_length(p_input->'ingredients') <> 0)
    or (v_type <> 'raw_material' and jsonb_array_length(p_input->'ingredients') not between 1 and 200) then
    raise exception 'Recipes require between 1 and 200 ingredients; raw materials have none';
  end if;
  v_code := nullif(btrim(p_input->>'code'), '');
  if v_code is null and v_type = 'raw_material' then raise exception 'Material ID is required'; end if;
  v_code := coalesce(v_code, upper(v_type) || '-' || v_id::text);
  if v_type = 'variant' and not exists (
    select 1 from public.engineering_items where id = (p_input->>'parentId')::uuid
      and store_id = p_store_id and type = 'menu_item'
  ) then raise exception 'Select a main menu item from this store'; end if;

  insert into public.engineering_items (
    id, store_id, type, code, name, purchase_price, purchase_quantity, uom, supplier,
    yield_portions, category, suggested_price, parent_id, pos_item_code
  ) values (
    v_id, p_store_id, v_type, v_code, btrim(p_input->>'name'), (p_input->>'purchasePrice')::numeric,
    (p_input->>'purchaseQuantity')::numeric, p_input->>'uom', p_input->>'supplier',
    (p_input->>'yieldPortions')::numeric, p_input->>'category', (p_input->>'suggestedPrice')::numeric,
    (p_input->>'parentId')::uuid, p_input->>'posItemCode'
  ) on conflict (id) do update set
    code = excluded.code, name = excluded.name, purchase_price = excluded.purchase_price,
    purchase_quantity = excluded.purchase_quantity, uom = excluded.uom, supplier = excluded.supplier,
    yield_portions = excluded.yield_portions, category = excluded.category,
    suggested_price = excluded.suggested_price, parent_id = excluded.parent_id,
    pos_item_code = excluded.pos_item_code, updated_at = now();

  delete from public.engineering_ingredients where recipe_id = v_id and store_id = p_store_id;
  insert into public.engineering_ingredients (store_id, recipe_id, ingredient_id, quantity, uom, position)
  select p_store_id, v_id, (entry->>'itemId')::uuid, (entry->>'quantity')::numeric, entry->>'uom', (ordinality - 1)::integer
  from jsonb_array_elements(p_input->'ingredients') with ordinality as rows(entry, ordinality);

  -- Validate all affected relationships after edits, including a material's changed UOM.
  if exists (
    select 1 from public.engineering_ingredients r
    join public.engineering_items recipe on recipe.id = r.recipe_id
    join public.engineering_items ingredient on ingredient.id = r.ingredient_id
    where r.store_id = p_store_id and (
      recipe.type = 'raw_material'
      or (recipe.type in ('base', 'addon') and ingredient.type <> 'raw_material')
      or (recipe.type in ('menu_item', 'variant') and ingredient.type not in ('raw_material', 'base', 'addon'))
      or not (
        (ingredient.type in ('base', 'addon') and r.uom = 'porsi')
        or (ingredient.type = 'raw_material' and (
          (ingredient.uom in ('g', 'kg') and r.uom in ('g', 'kg'))
          or (ingredient.uom in ('ml', 'l') and r.uom in ('ml', 'l'))
          or (ingredient.uom = 'pcs' and r.uom = 'pcs')
        ))
      )
    )
  ) then raise exception 'Invalid ingredient type or incompatible unit. Check recipes using this material before changing its unit.'; end if;
  return v_id;
end;
$$;

create or replace function public.delete_engineering_item(p_store_id uuid, p_id uuid)
returns void language plpgsql set search_path = public as $$
begin
  perform 1 from public.stores where id = p_store_id for update;
  if not found then raise exception 'Store not found'; end if;
  if exists (select 1 from public.engineering_ingredients where store_id = p_store_id and ingredient_id = p_id)
    or exists (select 1 from public.engineering_items where store_id = p_store_id and parent_id = p_id) then
    raise exception 'This item is used by a recipe or variant. Remove those references before deleting it.';
  end if;
  delete from public.engineering_items where store_id = p_store_id and id = p_id;
  if not found then raise exception 'Item not found'; end if;
end;
$$;

revoke all on function public.save_engineering_item(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.delete_engineering_item(uuid, uuid) from public, anon, authenticated;
grant execute on function public.save_engineering_item(uuid, uuid, jsonb) to service_role;
grant execute on function public.delete_engineering_item(uuid, uuid) to service_role;
commit;


-- Global purchased-stock catalog. Item/unit writes are atomic; no store filter applies.
begin;

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  base_uom text not null check (base_uom in ('g', 'kg', 'ml', 'l', 'pcs')),
  purchase_price numeric not null check (purchase_price >= 0 and purchase_price <= 1000000000000),
  purchase_qty numeric not null check (purchase_qty >= 0.000000001 and purchase_qty <= 1000000000000),
  purchase_unit_id uuid not null,
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.units (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.items(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  conversion numeric not null check (conversion >= 0.000000001 and conversion <= 1000000000000),
  unique (item_id, id)
);

create unique index if not exists units_item_name_idx on public.units(item_id, lower(btrim(name)));
create index if not exists items_name_idx on public.items(lower(name), id);

-- A deferred FK allows an item and its required purchase unit to be created in one RPC.
-- The composite key also prevents an item from pointing at another item's unit.
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.items'::regclass and conname = 'items_purchase_unit_fk') then
    alter table public.items add constraint items_purchase_unit_fk
      foreign key (id, purchase_unit_id) references public.units(item_id, id)
      deferrable initially deferred;
  end if;
end $$;

create or replace function public.inventory_standard_conversion(p_name text, p_base text)
returns numeric language plpgsql immutable set search_path = public as $$
declare v_source record; v_base record;
begin
  select * into v_source from (values
    ('g', 'mass', 1::numeric), ('kg', 'mass', 1000::numeric),
    ('ml', 'volume', 1::numeric), ('l', 'volume', 1000::numeric), ('pcs', 'count', 1::numeric)
  ) as u(name, dimension, factor) where name = lower(btrim(p_name));
  if not found then return null; end if;
  select * into v_base from (values
    ('g', 'mass', 1::numeric), ('kg', 'mass', 1000::numeric),
    ('ml', 'volume', 1::numeric), ('l', 'volume', 1000::numeric), ('pcs', 'count', 1::numeric)
  ) as u(name, dimension, factor) where name = p_base;
  if not found or v_source.dimension <> v_base.dimension then
    raise exception 'Incompatible standard purchase unit and base unit' using errcode = '23514';
  end if;
  return v_source.factor / v_base.factor;
end;
$$;

create or replace function public.validate_inventory_units()
returns trigger language plpgsql set search_path = public as $$
declare v_id uuid; v_base text; v_unit record; v_expected numeric;
begin
  if tg_table_name = 'items' then v_id := new.id; else v_id := new.item_id; end if;
  select base_uom into v_base from public.items where id = v_id;
  if not found then return null; end if;
  for v_unit in select name, conversion from public.units where item_id = v_id loop
    v_expected := public.inventory_standard_conversion(v_unit.name, v_base);
    if v_expected is not null and v_unit.conversion <> v_expected then
      raise exception 'Incorrect standard unit conversion' using errcode = '23514';
    end if;
  end loop;
  return null;
end;
$$;

drop trigger if exists items_validate_units on public.items;
create constraint trigger items_validate_units after insert or update on public.items
  deferrable initially deferred for each row execute function public.validate_inventory_units();
drop trigger if exists units_validate_conversion on public.units;
create constraint trigger units_validate_conversion after insert or update on public.units
  deferrable initially deferred for each row execute function public.validate_inventory_units();

create or replace function public.touch_inventory_item()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
drop trigger if exists items_updated_at on public.items;
create trigger items_updated_at before update on public.items
  for each row execute function public.touch_inventory_item();

create or replace function public.save_inventory_item(p_id uuid, p_input jsonb)
returns uuid language plpgsql set search_path = public as $$
declare v_id uuid; v_unit uuid; v_unit_name text;
begin
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'Item details must be an object' using errcode = '22023';
  end if;
  v_unit_name := btrim(p_input->>'purchaseUnitName');
  if lower(v_unit_name) in ('g', 'kg', 'ml', 'l', 'pcs') then v_unit_name := lower(v_unit_name); end if;
  if p_id is null then
    v_id := gen_random_uuid(); v_unit := gen_random_uuid();
    insert into public.items(id, name, base_uom, purchase_price, purchase_qty, purchase_unit_id)
    values (v_id, btrim(p_input->>'name'), p_input->>'baseUom', (p_input->>'purchasePrice')::numeric,
      (p_input->>'purchaseQuantity')::numeric, v_unit);
    insert into public.units(id, item_id, name, conversion)
    values (v_unit, v_id, v_unit_name, (p_input->>'purchaseConversion')::numeric);
  else
    select id, purchase_unit_id into v_id, v_unit from public.items where id = p_id for update;
    if not found then raise exception 'Item not found' using errcode = 'P0002'; end if;
    update public.items set name = btrim(p_input->>'name'), base_uom = p_input->>'baseUom',
      purchase_price = (p_input->>'purchasePrice')::numeric, purchase_qty = (p_input->>'purchaseQuantity')::numeric
    where id = v_id;
    update public.units set name = v_unit_name, conversion = (p_input->>'purchaseConversion')::numeric
    where id = v_unit and item_id = v_id;
    if not found then raise exception 'Purchase unit not found' using errcode = '23503'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_inventory_item(p_id uuid)
returns void language plpgsql set search_path = public as $$
begin
  -- Units are removed with the item. Other recipe/count/receipt FKs must use RESTRICT.
  -- A reference to either the item or one of its units blocks the entire deletion.
  delete from public.items where id = p_id;
  if not found then raise exception 'Item not found' using errcode = 'P0002'; end if;
end;
$$;

alter table public.items enable row level security;
alter table public.units enable row level security;
revoke all on public.items, public.units from public, anon, authenticated;
grant all on public.items, public.units to service_role;

revoke all on function public.inventory_standard_conversion(text, text) from public, anon, authenticated;
revoke all on function public.validate_inventory_units() from public, anon, authenticated;
revoke all on function public.touch_inventory_item() from public, anon, authenticated;
revoke all on function public.save_inventory_item(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.delete_inventory_item(uuid) from public, anon, authenticated;
grant execute on function public.inventory_standard_conversion(text, text) to service_role;
grant execute on function public.validate_inventory_units() to service_role;
grant execute on function public.touch_inventory_item() to service_role;
grant execute on function public.save_inventory_item(uuid, jsonb) to service_role;
grant execute on function public.delete_inventory_item(uuid) to service_role;

notify pgrst, 'reload schema';
commit;

-- Optional user-defined item IDs and free-text supplier notes. Preserve existing IDs/data.
begin;
alter table public.items drop constraint if exists items_purchase_unit_fk;
alter table public.units drop constraint if exists units_item_id_fkey;
alter table public.items alter column id drop default;
do $$ begin
  if (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'items' and column_name = 'id') <> 'text' then
    alter table public.items alter column id type text using id::text;
  end if;
  if (select data_type from information_schema.columns where table_schema = 'public' and table_name = 'units' and column_name = 'item_id') <> 'text' then
    alter table public.units alter column item_id type text using item_id::text;
  end if;
end $$;
alter table public.items alter column id set default gen_random_uuid()::text;
alter table public.items add column if not exists supplier text;
alter table public.items drop constraint if exists items_id_format;
alter table public.items add constraint items_id_format check (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$');
alter table public.items drop constraint if exists items_supplier_length;
alter table public.items add constraint items_supplier_length check (supplier is null or length(supplier) <= 1000);
alter table public.units add constraint units_item_id_fkey foreign key (item_id) references public.items(id) on delete cascade;
alter table public.items add constraint items_purchase_unit_fk
  foreign key (id, purchase_unit_id) references public.units(item_id, id) deferrable initially deferred;
-- Remove the previous UUID overloads so PostgREST resolves calls unambiguously.
drop function if exists public.save_inventory_item(uuid, jsonb);
drop function if exists public.delete_inventory_item(uuid);

create or replace function public.validate_inventory_units()
returns trigger language plpgsql set search_path = public as $$
declare v_id text; v_base text; v_unit record; v_expected numeric;
begin
  if tg_table_name = 'items' then v_id := new.id; else v_id := new.item_id; end if;
  select base_uom into v_base from public.items where id = v_id;
  if not found then return null; end if;
  for v_unit in select name, conversion from public.units where item_id = v_id loop
    v_expected := public.inventory_standard_conversion(v_unit.name, v_base);
    if v_expected is not null and v_unit.conversion <> v_expected then
      raise exception 'Incorrect standard unit conversion' using errcode = '23514';
    end if;
  end loop;
  return null;
end;
$$;

create or replace function public.save_inventory_item(p_id text, p_input jsonb)
returns text language plpgsql set search_path = public as $$
declare v_id text; v_unit uuid; v_unit_name text;
begin
  if jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'Item details must be an object' using errcode = '22023';
  end if;
  v_unit_name := btrim(p_input->>'purchaseUnitName');
  if lower(v_unit_name) in ('g', 'kg', 'ml', 'l', 'pcs') then v_unit_name := lower(v_unit_name); end if;
  if p_id is null then
    v_id := coalesce(nullif(btrim(p_input->>'id'), ''), gen_random_uuid()::text); v_unit := gen_random_uuid();
    insert into public.items(id, name, base_uom, purchase_price, purchase_qty, purchase_unit_id, supplier)
    values (v_id, btrim(p_input->>'name'), p_input->>'baseUom', (p_input->>'purchasePrice')::numeric,
      (p_input->>'purchaseQuantity')::numeric, v_unit, nullif(btrim(p_input->>'supplier'), ''));
    insert into public.units(id, item_id, name, conversion)
    values (v_unit, v_id, v_unit_name, (p_input->>'purchaseConversion')::numeric);
  else
    if nullif(btrim(p_input->>'id'), '') is not null and btrim(p_input->>'id') <> p_id then
      raise exception 'Item ID cannot change after creation' using errcode = '22023';
    end if;
    select id, purchase_unit_id into v_id, v_unit from public.items where id = p_id for update;
    if not found then raise exception 'Item not found' using errcode = 'P0002'; end if;
    update public.items set supplier = nullif(btrim(p_input->>'supplier'), ''), name = btrim(p_input->>'name'), base_uom = p_input->>'baseUom',
      purchase_price = (p_input->>'purchasePrice')::numeric, purchase_qty = (p_input->>'purchaseQuantity')::numeric
    where id = v_id;
    update public.units set name = v_unit_name, conversion = (p_input->>'purchaseConversion')::numeric
    where id = v_unit and item_id = v_id;
    if not found then raise exception 'Purchase unit not found' using errcode = '23503'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_inventory_item(p_id text)
returns void language plpgsql set search_path = public as $$
begin
  -- Units are removed with the item. Other recipe/count/receipt FKs must use RESTRICT.
  -- A reference to either the item or one of its units blocks the entire deletion.
  delete from public.items where id = p_id;
  if not found then raise exception 'Item not found' using errcode = 'P0002'; end if;
end;
$$;

revoke all on function public.save_inventory_item(text, jsonb) from public, anon, authenticated;
revoke all on function public.delete_inventory_item(text) from public, anon, authenticated;
grant execute on function public.save_inventory_item(text, jsonb) to service_role;
grant execute on function public.delete_inventory_item(text) to service_role;
notify pgrst, 'reload schema';
commit;

-- Global prepared bases, with one required current recipe per base.
begin;
create table if not exists public.bases (
  id text primary key default gen_random_uuid()::text check (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  name text not null check (length(btrim(name)) between 1 and 200),
  base_uom text not null check (base_uom in ('porsi','g','kg','ml','l','pcs')),
  recipe_id uuid not null unique,
  updated_at timestamptz not null default clock_timestamp()
);
create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  output_base_id text not null unique references public.bases(id) on delete cascade,
  yield_qty numeric not null check (yield_qty >= 0.000000001 and yield_qty <= 1000000000000),
  unique (id, output_base_id)
);
create table if not exists public.recipe_ingredients (
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  line_number integer not null check (line_number between 1 and 200),
  item_id text not null references public.items(id) on delete restrict,
  quantity numeric not null check (quantity >= 0.000000001 and quantity <= 1000000000000),
  uom text not null check (length(btrim(uom)) between 1 and 80),
  primary key (recipe_id, line_number)
);
create index if not exists recipe_ingredients_item_idx on public.recipe_ingredients(item_id);
create index if not exists bases_name_idx on public.bases(lower(name), id);
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.bases'::regclass and conname = 'bases_recipe_fk') then
    alter table public.bases add constraint bases_recipe_fk foreign key (recipe_id, id)
      references public.recipes(id, output_base_id) deferrable initially deferred;
  end if;
end $$;
drop trigger if exists bases_updated_at on public.bases;
create trigger bases_updated_at before update on public.bases for each row execute function public.touch_inventory_item();

create or replace function public.base_ingredient_factor(p_item text, p_uom text)
returns numeric language plpgsql stable set search_path = public as $$
declare v_base text; v_factor numeric;
begin
  select base_uom into v_base from public.items where id = p_item;
  if not found then raise exception 'Raw material not found' using errcode = '23503'; end if;
  v_factor := public.inventory_standard_conversion(p_uom, v_base);
  if v_factor is not null then return v_factor; end if;
  select conversion into v_factor from public.units where item_id = p_item and lower(btrim(name)) = lower(btrim(p_uom));
  if not found then raise exception 'Invalid ingredient unit' using errcode = '23514'; end if;
  return v_factor;
end;
$$;
create or replace function public.validate_base_recipe(p_recipe uuid)
returns void language plpgsql set search_path = public as $$
declare v_row record; v_count integer;
begin
  if not exists (select 1 from public.recipes where id = p_recipe) then return; end if;
  select count(*) into v_count from public.recipe_ingredients where recipe_id = p_recipe;
  if v_count < 1 or v_count > 200 then raise exception 'Recipe needs 1 to 200 raw materials' using errcode = '23514'; end if;
  for v_row in select item_id, uom from public.recipe_ingredients where recipe_id = p_recipe loop
    perform public.base_ingredient_factor(v_row.item_id, v_row.uom);
  end loop;
end;
$$;
create or replace function public.check_base_recipe()
returns trigger language plpgsql set search_path = public as $$
declare v_recipe uuid;
begin
  if tg_table_name = 'recipes' then
    if tg_op <> 'INSERT' then perform public.validate_base_recipe(old.id); end if;
    if tg_op <> 'DELETE' then perform public.validate_base_recipe(new.id); end if;
  elsif tg_table_name = 'recipe_ingredients' then
    if tg_op <> 'INSERT' then perform public.validate_base_recipe(old.recipe_id); end if;
    if tg_op <> 'DELETE' then perform public.validate_base_recipe(new.recipe_id); end if;
  else
    -- Keep recipes valid when a referenced item's base unit or pack definition changes.
    if tg_table_name = 'items' then
      for v_recipe in select distinct recipe_id from public.recipe_ingredients where item_id = new.id loop
        perform public.validate_base_recipe(v_recipe);
      end loop;
    else
      for v_recipe in select distinct recipe_id from public.recipe_ingredients where item_id = old.item_id or item_id = new.item_id loop
        perform public.validate_base_recipe(v_recipe);
      end loop;
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists recipes_require_ingredients on public.recipes;
create constraint trigger recipes_require_ingredients after insert or update or delete on public.recipes
  deferrable initially deferred for each row execute function public.check_base_recipe();
drop trigger if exists ingredients_require_valid_recipe on public.recipe_ingredients;
create constraint trigger ingredients_require_valid_recipe after insert or update or delete on public.recipe_ingredients
  deferrable initially deferred for each row execute function public.check_base_recipe();
drop trigger if exists items_protect_base_recipes on public.items;
create constraint trigger items_protect_base_recipes after update on public.items
  deferrable initially deferred for each row execute function public.check_base_recipe();
drop trigger if exists units_protect_base_recipes on public.units;
create constraint trigger units_protect_base_recipes after update on public.units
  deferrable initially deferred for each row execute function public.check_base_recipe();

create or replace function public.save_prepared_base(p_id text, p_input jsonb)
returns text language plpgsql set search_path = public as $$
declare v_id text; v_recipe uuid; v_row record;
begin
  if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Base must be an object' using errcode = '22023'; end if;
  if jsonb_typeof(p_input->'ingredients') is distinct from 'array' then raise exception 'Ingredients required' using errcode = '22023'; end if;
  if jsonb_array_length(p_input->'ingredients') not between 1 and 200 then raise exception 'Add 1 to 200 ingredients' using errcode = '23514'; end if;
  if p_id is null then
    v_id := coalesce(nullif(btrim(p_input->>'id'), ''), gen_random_uuid()::text); v_recipe := gen_random_uuid();
    insert into public.bases(id, name, base_uom, recipe_id) values(v_id, btrim(p_input->>'name'), p_input->>'baseUom', v_recipe);
    insert into public.recipes(id, output_base_id, yield_qty) values(v_recipe, v_id, (p_input->>'yieldQuantity')::numeric);
  else
    if nullif(btrim(p_input->>'id'), '') is not null and btrim(p_input->>'id') <> p_id then raise exception 'Base ID cannot change' using errcode = '22023'; end if;
    select id, recipe_id into v_id, v_recipe from public.bases where id = p_id for update;
    if not found then raise exception 'Base not found' using errcode = 'P0002'; end if;
    update public.bases set name = btrim(p_input->>'name'), base_uom = p_input->>'baseUom' where id = v_id;
    update public.recipes set yield_qty = (p_input->>'yieldQuantity')::numeric where id = v_recipe;
    delete from public.recipe_ingredients where recipe_id = v_recipe;
  end if;
  for v_row in select value, ordinality from jsonb_array_elements(p_input->'ingredients') with ordinality loop
    insert into public.recipe_ingredients(recipe_id, line_number, item_id, quantity, uom)
      values(v_recipe, v_row.ordinality, v_row.value->>'itemId', (v_row.value->>'quantity')::numeric, btrim(v_row.value->>'uom'));
  end loop;
  perform public.validate_base_recipe(v_recipe);
  return v_id;
end;
$$;
create or replace function public.delete_prepared_base(p_id text)
returns void language plpgsql set search_path = public as $$
begin
  delete from public.bases where id = p_id;
  if not found then raise exception 'Base not found' using errcode = 'P0002'; end if;
end;
$$;
alter table public.bases enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
revoke all on public.bases, public.recipes, public.recipe_ingredients from public, anon, authenticated;
grant all on public.bases, public.recipes, public.recipe_ingredients to service_role;
revoke all on function public.base_ingredient_factor(text,text), public.validate_base_recipe(uuid), public.check_base_recipe(), public.save_prepared_base(text,jsonb), public.delete_prepared_base(text) from public, anon, authenticated;
grant execute on function public.base_ingredient_factor(text,text), public.validate_base_recipe(uuid), public.check_base_recipe(), public.save_prepared_base(text,jsonb), public.delete_prepared_base(text) to service_role;
notify pgrst, 'reload schema';
commit;

-- Products share the current-recipe infrastructure with Bases. No POS writes.
begin;
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200)
);
create unique index if not exists categories_name_idx on public.categories(lower(btrim(name)));
create table if not exists public.products (
  id text primary key default gen_random_uuid()::text check (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  name text not null check (length(btrim(name)) between 1 and 200),
  type text not null check (type in ('menu','variant','addon')),
  parent_product_id text references public.products(id) on delete restrict,
  category_id uuid references public.categories(id) on delete restrict,
  sales_price numeric not null check (sales_price >= 0 and sales_price <= 1000000000000),
  recipe_id uuid not null unique,
  updated_at timestamptz not null default clock_timestamp(),
  check ((type = 'variant') = (parent_product_id is not null)),
  check (parent_product_id is null or parent_product_id <> id)
);
create index if not exists products_name_idx on public.products(lower(name),id);
create index if not exists products_parent_idx on public.products(parent_product_id);
create index if not exists products_category_idx on public.products(category_id);
alter table public.recipes alter column output_base_id drop not null;
alter table public.recipes add column if not exists output_product_id text unique references public.products(id) on delete cascade;
alter table public.recipes drop constraint if exists recipes_output_required;
alter table public.recipes add constraint recipes_output_required check (num_nonnulls(output_base_id,output_product_id) = 1);
alter table public.recipes drop constraint if exists recipes_product_yield;
alter table public.recipes add constraint recipes_product_yield check (output_product_id is null or yield_qty = 1);
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.recipes'::regclass and conname='recipes_id_product_key') then
    alter table public.recipes add constraint recipes_id_product_key unique(id,output_product_id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.products'::regclass and conname='products_recipe_fk') then
    alter table public.products add constraint products_recipe_fk foreign key(recipe_id,id)
      references public.recipes(id,output_product_id) deferrable initially deferred;
  end if;
end $$;
alter table public.recipe_ingredients alter column item_id drop not null;
alter table public.recipe_ingredients add column if not exists base_id text references public.bases(id) on delete restrict;
alter table public.recipe_ingredients drop constraint if exists recipe_ingredients_source_required;
alter table public.recipe_ingredients add constraint recipe_ingredients_source_required check(num_nonnulls(item_id,base_id) = 1);
create index if not exists recipe_ingredients_base_idx on public.recipe_ingredients(base_id);
drop trigger if exists products_updated_at on public.products;
create trigger products_updated_at before update on public.products for each row execute function public.touch_inventory_item();

create or replace function public.prepared_base_factor(p_base text,p_uom text)
returns numeric language plpgsql stable set search_path=public as $$
declare v_unit text; v_factor numeric;
begin
  select base_uom into v_unit from public.bases where id=p_base;
  if not found then raise exception 'Base not found' using errcode='23503'; end if;
  if v_unit='porsi' then
    if lower(btrim(p_uom))='porsi' then return 1; end if;
    raise exception 'Portions cannot be converted to weight or volume without a measured conversion' using errcode='23514';
  end if;
  v_factor:=public.inventory_standard_conversion(p_uom,v_unit);
  if v_factor is null then raise exception 'Invalid base ingredient unit' using errcode='23514'; end if;
  return v_factor;
end;
$$;
-- Preserve the original function name used by the Bases RPC and deferred triggers.
create or replace function public.validate_base_recipe(p_recipe uuid)
returns void language plpgsql set search_path=public as $$
declare v_row record; v_count integer; v_base text;
begin
  select output_base_id into v_base from public.recipes where id=p_recipe;
  if not found then return; end if;
  select count(*) into v_count from public.recipe_ingredients where recipe_id=p_recipe;
  if v_count < 1 or v_count > 200 then raise exception 'Recipe needs 1 to 200 ingredients' using errcode='23514'; end if;
  for v_row in select item_id,base_id,uom from public.recipe_ingredients where recipe_id=p_recipe loop
    if v_row.item_id is not null then perform public.base_ingredient_factor(v_row.item_id,v_row.uom);
    else
      if v_base is not null then raise exception 'Base recipes only accept raw materials' using errcode='23514'; end if;
      perform public.prepared_base_factor(v_row.base_id,v_row.uom);
    end if;
  end loop;
end;
$$;
create or replace function public.check_base_recipe()
returns trigger language plpgsql set search_path=public as $$
declare v_recipe uuid;
begin
  if tg_table_name='recipes' then
    if tg_op<>'INSERT' then perform public.validate_base_recipe(old.id); end if;
    if tg_op<>'DELETE' then perform public.validate_base_recipe(new.id); end if;
  elsif tg_table_name='recipe_ingredients' then
    if tg_op<>'INSERT' then perform public.validate_base_recipe(old.recipe_id); end if;
    if tg_op<>'DELETE' then perform public.validate_base_recipe(new.recipe_id); end if;
  elsif tg_table_name='bases' then
    for v_recipe in select distinct recipe_id from public.recipe_ingredients where base_id=new.id loop perform public.validate_base_recipe(v_recipe); end loop;
  elsif tg_table_name='items' then
    for v_recipe in select distinct recipe_id from public.recipe_ingredients where item_id=new.id loop perform public.validate_base_recipe(v_recipe); end loop;
  else
    for v_recipe in select distinct recipe_id from public.recipe_ingredients where item_id=old.item_id or item_id=new.item_id loop perform public.validate_base_recipe(v_recipe); end loop;
  end if;
  return null;
end;
$$;
drop trigger if exists bases_protect_product_recipes on public.bases;
create constraint trigger bases_protect_product_recipes after update on public.bases deferrable initially deferred for each row execute function public.check_base_recipe();
create or replace function public.validate_product_parent()
returns trigger language plpgsql set search_path=public as $$
declare v_product public.products%rowtype;
begin
  select * into v_product from public.products where id=new.id;
  if not found then return null; end if;
  if v_product.type='variant' then
    perform 1 from public.products where id=v_product.parent_product_id and type='menu' for share;
    if not found then raise exception 'A variant must reference a main menu product' using errcode='23514'; end if;
  end if;
  if v_product.type<>'menu' and exists(select 1 from public.products where parent_product_id=v_product.id) then
    raise exception 'A main menu product with variants must remain a menu product' using errcode='23514';
  end if;
  return null;
end;
$$;
drop trigger if exists products_validate_parent on public.products;
create constraint trigger products_validate_parent after insert or update on public.products deferrable initially deferred for each row execute function public.validate_product_parent();

create or replace function public.create_product_category(p_name text)
returns jsonb language plpgsql set search_path=public as $$
declare v_category public.categories%rowtype;
begin
  insert into public.categories(name) values(btrim(p_name))
    on conflict (lower(btrim(name))) do update set name=categories.name returning * into v_category;
  return jsonb_build_object('id',v_category.id,'name',v_category.name);
end;
$$;
create or replace function public.save_catalog_product(p_id text,p_input jsonb)
returns text language plpgsql set search_path=public as $$
declare v_id text; v_recipe uuid; v_row record;
begin
  if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Product must be an object' using errcode='22023'; end if;
  if jsonb_typeof(p_input->'ingredients') is distinct from 'array' then raise exception 'Ingredients required' using errcode='22023'; end if;
  if jsonb_array_length(p_input->'ingredients') not between 1 and 200 then raise exception 'Add 1 to 200 ingredients' using errcode='23514'; end if;
  if p_id is null then
    v_id:=coalesce(nullif(btrim(p_input->>'id'),''),gen_random_uuid()::text); v_recipe:=gen_random_uuid();
    insert into public.products(id,name,type,parent_product_id,category_id,sales_price,recipe_id)
      values(v_id,btrim(p_input->>'name'),p_input->>'type',nullif(p_input->>'parentProductId',''),nullif(p_input->>'categoryId','')::uuid,(p_input->>'salesPrice')::numeric,v_recipe);
    insert into public.recipes(id,output_product_id,yield_qty) values(v_recipe,v_id,1);
  else
    if nullif(btrim(p_input->>'id'),'') is not null and btrim(p_input->>'id')<>p_id then raise exception 'Product ID cannot change' using errcode='22023'; end if;
    select id,recipe_id into v_id,v_recipe from public.products where id=p_id for update;
    if not found then raise exception 'Product not found' using errcode='P0002'; end if;
    update public.products set name=btrim(p_input->>'name'),type=p_input->>'type',parent_product_id=nullif(p_input->>'parentProductId',''),
      category_id=nullif(p_input->>'categoryId','')::uuid,sales_price=(p_input->>'salesPrice')::numeric where id=v_id;
    delete from public.recipe_ingredients where recipe_id=v_recipe;
  end if;
  for v_row in select value,ordinality from jsonb_array_elements(p_input->'ingredients') with ordinality loop
    if coalesce(v_row.value->>'kind','') not in ('item','base') then raise exception 'Only raw material or base ingredients allowed' using errcode='23514'; end if;
    insert into public.recipe_ingredients(recipe_id,line_number,item_id,base_id,quantity,uom)
      values(v_recipe,v_row.ordinality,case when v_row.value->>'kind'='item' then v_row.value->>'ingredientId' end,
        case when v_row.value->>'kind'='base' then v_row.value->>'ingredientId' end,(v_row.value->>'quantity')::numeric,btrim(v_row.value->>'uom'));
  end loop;
  perform public.validate_base_recipe(v_recipe);
  return v_id;
end;
$$;
create or replace function public.delete_catalog_product(p_id text)
returns void language plpgsql set search_path=public as $$
begin
  delete from public.products where id=p_id;
  if not found then raise exception 'Product not found' using errcode='P0002'; end if;
end;
$$;
alter table public.categories enable row level security;
alter table public.products enable row level security;
revoke all on public.categories,public.products from public,anon,authenticated;
grant all on public.categories,public.products to service_role;
revoke all on function public.prepared_base_factor(text,text), public.validate_product_parent(), public.create_product_category(text), public.save_catalog_product(text,jsonb), public.delete_catalog_product(text) from public,anon,authenticated;
grant execute on function public.prepared_base_factor(text,text), public.validate_product_parent(), public.create_product_category(text), public.save_catalog_product(text,jsonb), public.delete_catalog_product(text) to service_role;
notify pgrst,'reload schema';
commit;
