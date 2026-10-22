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
alter table public.items alter column id type text using id::text;
alter table public.units alter column item_id type text using item_id::text;
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
