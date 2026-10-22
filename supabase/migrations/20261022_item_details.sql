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
