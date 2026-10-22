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
