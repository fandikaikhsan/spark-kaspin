-- Integration checks for a local/disposable PostgreSQL database after 20261022_items.sql.
-- Everything, including the mock future recipe/count reference table, is rolled back.
begin;
create table public.__item_crud_reference_check (
  item_id text references public.items(id) on delete restrict,
  unit_id uuid references public.units(id) on delete restrict
);

do $$
declare a text; b text; u uuid; before_count bigint;
begin
  a := public.save_inventory_item(null, '{"name":"__QA SQL A","baseUom":"g","purchasePrice":30000,"purchaseQuantity":2,"purchaseUnitName":"bag","purchaseConversion":1000}');
  b := public.save_inventory_item(null, '{"id":"QA-SQL-B","supplier":"Market / Shop A","name":"__QA SQL B","baseUom":"g","purchasePrice":1000,"purchaseQuantity":1,"purchaseUnitName":"g","purchaseConversion":1}');
  if b <> 'QA-SQL-B' or (select supplier from public.items where id = b) <> 'Market / Shop A' then
    raise exception 'Custom ID or supplier was not saved';
  end if;
  begin
    perform public.save_inventory_item(null, '{"id":"QA-SQL-B","name":"Duplicate","baseUom":"g","purchasePrice":1,"purchaseQuantity":1,"purchaseUnitName":"g","purchaseConversion":1}');
    raise exception 'Duplicate ID accepted';
  exception when unique_violation then null;
  end;
  set constraints all immediate;
  set constraints all deferred;
  select purchase_unit_id into u from public.items where id = a;
  perform public.save_inventory_item(a, '{"name":"__QA SQL A updated","baseUom":"g","purchasePrice":40000,"purchaseQuantity":2,"purchaseUnitName":"kg","purchaseConversion":1000}');
  set constraints all immediate;
  set constraints all deferred;
  if (select purchase_unit_id from public.items where id = a) <> u then
    raise exception 'Editing replaced the unit ID';
  end if;

  begin
    update public.items set purchase_unit_id = (select purchase_unit_id from public.items where id = b) where id = a;
    set constraints all immediate;
    raise exception 'Cross-item unit reference accepted';
  exception when foreign_key_violation then null;
  end;
  set constraints all deferred;

  select count(*) into before_count from public.items;
  begin
    perform public.save_inventory_item(null, '{"name":"__QA SQL invalid","baseUom":"g","purchasePrice":1000,"purchaseQuantity":1,"purchaseUnitName":"kg","purchaseConversion":1}');
    set constraints all immediate;
    raise exception 'Invalid conversion accepted';
  exception when check_violation then null;
  end;
  if (select count(*) from public.items) <> before_count then
    raise exception 'Failed save left an orphan item';
  end if;
  set constraints all deferred;

  insert into public.__item_crud_reference_check values (a, u);
  begin
    perform public.delete_inventory_item(a);
    set constraints all immediate;
    raise exception 'Referenced item was deleted';
  exception when foreign_key_violation then null;
  end;
  if not exists (select 1 from public.items where id = a) or not exists (select 1 from public.units where id = u) then
    raise exception 'Failed deletion did not roll back';
  end if;

  delete from public.__item_crud_reference_check;
  perform public.delete_inventory_item(a);
  perform public.delete_inventory_item(b);
  set constraints all immediate;
  if exists (select 1 from public.units where item_id in (a, b)) then
    raise exception 'Deleted item left units';
  end if;
  if has_table_privilege('anon', 'public.items', 'SELECT')
    or has_table_privilege('authenticated', 'public.units', 'SELECT')
    or has_function_privilege('authenticated', 'public.save_inventory_item(text,jsonb)', 'EXECUTE') then
    raise exception 'Client database access exposed';
  end if;
end $$;

select 'PASS: atomic saves, stable unit IDs, cross-item FK, standard conversions, rollback, referenced-delete protection, unit cleanup and private database grants';
rollback;
