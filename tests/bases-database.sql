-- Run against local/disposable PostgreSQL. All checks and fixtures roll back.
begin;
create table public.__base_reference_check (base_id text references public.bases(id) on delete restrict);
do $$
declare v_item text; v_base text; v_recipe uuid; v_before bigint;
begin
  v_item := public.save_inventory_item(null, '{"id":"QA-BASE-MILK","name":"QA base milk","baseUom":"ml","purchasePrice":240000,"purchaseQuantity":1,"purchaseUnitName":"carton","purchaseConversion":12000}');
  v_base := public.save_prepared_base(null, '{"id":"QA-BASE-CARBONARA","name":"QA Carbonara","baseUom":"porsi","yieldQuantity":22,"ingredients":[{"itemId":"QA-BASE-MILK","quantity":1000,"uom":"ml"}]}');
  set constraints all immediate; set constraints all deferred;
  select recipe_id into v_recipe from public.bases where id = v_base;
  if (select count(*) from public.recipes where output_base_id = v_base) <> 1 then raise exception 'One recipe per base violated'; end if;
  perform public.save_prepared_base(v_base, '{"name":"QA Carbonara edited","baseUom":"porsi","yieldQuantity":24,"ingredients":[{"itemId":"QA-BASE-MILK","quantity":1,"uom":"carton"}]}');
  set constraints all immediate; set constraints all deferred;
  if (select recipe_id from public.bases where id = v_base) <> v_recipe then raise exception 'Recipe ID changed on edit'; end if;
  if (select count(*) from public.recipe_ingredients where recipe_id = v_recipe) <> 1 then raise exception 'Edit duplicated recipe lines'; end if;
  if public.base_ingredient_factor(v_item,'l') <> 1000 or public.base_ingredient_factor(v_item,'carton') <> 12000 then raise exception 'Incorrect unit conversion'; end if;
  begin
    delete from public.recipe_ingredients where recipe_id = v_recipe;
    set constraints all immediate;
    raise exception 'Empty recipe accepted';
  exception when check_violation then null; end;
  set constraints all deferred;
  begin
    insert into public.bases(id,name,base_uom,recipe_id) values ('QA-NO-RECIPE','Missing recipe','porsi',gen_random_uuid());
    set constraints all immediate;
    raise exception 'Orphan base accepted';
  exception when foreign_key_violation then null; end;
  set constraints all deferred;
  select count(*) into v_before from public.bases;
  begin
    perform public.save_prepared_base(null, '{"name":"Invalid unit","baseUom":"porsi","yieldQuantity":22,"ingredients":[{"itemId":"QA-BASE-MILK","quantity":1,"uom":"kg"}]}');
    raise exception 'Incompatible unit accepted';
  exception when check_violation then null; end;
  if (select count(*) from public.bases) <> v_before then raise exception 'Failed save left orphan base'; end if;
  begin
    perform public.delete_inventory_item(v_item);
    raise exception 'Referenced item was deleted';
  exception when foreign_key_violation then null; end;
  begin
    perform public.save_inventory_item(v_item, '{"name":"QA base milk","baseUom":"ml","purchasePrice":240000,"purchaseQuantity":1,"purchaseUnitName":"bottle","purchaseConversion":12000}');
    set constraints all immediate;
    raise exception 'Rename broke an existing recipe';
  exception when check_violation then null; end;
  set constraints all deferred;
  insert into public.__base_reference_check values(v_base);
  begin
    perform public.delete_prepared_base(v_base);
    raise exception 'Referenced base was deleted';
  exception when foreign_key_violation then null; end;
  delete from public.__base_reference_check;
  perform public.delete_prepared_base(v_base); set constraints all immediate;
  if exists(select 1 from public.recipes where id=v_recipe) or exists(select 1 from public.recipe_ingredients where recipe_id=v_recipe) then raise exception 'Base delete left orphan recipe'; end if;
  perform public.delete_inventory_item(v_item);
  if has_table_privilege('anon','public.bases','SELECT') or has_table_privilege('authenticated','public.recipes','SELECT')
    or has_function_privilege('authenticated','public.save_prepared_base(text,jsonb)','EXECUTE') then raise exception 'Private recipe data exposed'; end if;
end $$;
select 'PASS: atomic base/recipe saves, required recipe and ingredients, stable recipe IDs, valid units, protected references, cleanup and private grants';
rollback;
