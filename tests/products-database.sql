-- Rollback-only local integration checks, including compatibility with existing Bases.
begin;
do $$
declare v_item text; v_base text; v_menu text; v_variant text; v_addon text; v_recipe uuid; v_category uuid; v_other uuid; v_input jsonb; v_before bigint;
begin
  v_item:=public.save_inventory_item(null,'{"id":"QA-PRODUCT-RAW","name":"QA Milk","baseUom":"ml","purchasePrice":100000,"purchaseQuantity":1,"purchaseUnitName":"carton","purchaseConversion":10000}');
  v_base:=public.save_prepared_base(null,'{"id":"QA-PRODUCT-BASE","name":"QA Sauce","baseUom":"porsi","yieldQuantity":10,"ingredients":[{"itemId":"QA-PRODUCT-RAW","quantity":1000,"uom":"ml"}]}');
  v_category:=(public.create_product_category(' QA Product Category ')->>'id')::uuid;
  v_other:=(public.create_product_category('qa product category')->>'id')::uuid;
  if v_category<>v_other then raise exception 'Duplicate case-insensitive category'; end if;
  v_input:=jsonb_build_object('id','QA-PRODUCT-MENU','name','QA Pasta','type','menu','categoryId',v_category,'salesPrice',30000,'ingredients',jsonb_build_array(jsonb_build_object('kind','base','ingredientId',v_base,'quantity',1,'uom','porsi'),jsonb_build_object('kind','item','ingredientId',v_item,'quantity',100,'uom','ml')));
  v_menu:=public.save_catalog_product(null,v_input);
  v_variant:=public.save_catalog_product(null,v_input||jsonb_build_object('id','QA-PRODUCT-VARIANT','type','variant','parentProductId',v_menu,'salesPrice',35000));
  v_addon:=public.save_catalog_product(null,v_input||jsonb_build_object('id','QA-PRODUCT-ADDON','type','addon','salesPrice',0));
  set constraints all immediate; set constraints all deferred;
  select recipe_id into v_recipe from public.products where id=v_menu;
  if (select yield_qty from public.recipes where id=v_recipe)<>1 then raise exception 'Product output is not one unit'; end if;
  perform public.save_catalog_product(v_menu,v_input||jsonb_build_object('salesPrice',32000));
  set constraints all immediate; set constraints all deferred;
  if (select recipe_id from public.products where id=v_menu)<>v_recipe or (select count(*) from public.recipe_ingredients where recipe_id=v_recipe)<>2 then raise exception 'Edit replaced recipe or duplicated lines'; end if;
  begin
    perform public.save_catalog_product(null,v_input||jsonb_build_object('id','QA-PRODUCT-BAD-PARENT','type','variant','parentProductId',v_addon));
    set constraints all immediate; raise exception 'Variant accepted an add-on parent';
  exception when check_violation then null; end;
  set constraints all deferred;
  begin
    perform public.save_catalog_product(v_menu,v_input||jsonb_build_object('type','addon'));
    set constraints all immediate; raise exception 'Main menu with variants changed type';
  exception when check_violation then null; end;
  set constraints all deferred;
  begin
    perform public.delete_catalog_product(v_menu); raise exception 'Main menu with variants deleted';
  exception when foreign_key_violation then null; end;
  begin
    perform public.delete_prepared_base(v_base); raise exception 'Used base deleted';
  exception when foreign_key_violation then null; end;
  begin
    delete from public.recipe_ingredients where recipe_id=v_recipe;
    set constraints all immediate; raise exception 'Empty product recipe accepted';
  exception when check_violation then null; end;
  set constraints all deferred;
  begin
    update public.recipes set yield_qty=2 where id=v_recipe; raise exception 'Product yield other than one accepted';
  exception when check_violation then null; end;
  begin
    insert into public.products(id,name,type,sales_price,recipe_id) values('QA-PRODUCT-ORPHAN','Orphan','menu',1,gen_random_uuid());
    set constraints all immediate; raise exception 'Orphan product accepted';
  exception when foreign_key_violation then null; end;
  set constraints all deferred;
  select count(*) into v_before from public.products;
  begin
    perform public.save_catalog_product(null,v_input||jsonb_build_object('id','QA-PRODUCT-BAD-UNIT','ingredients',jsonb_build_array(jsonb_build_object('kind','base','ingredientId',v_base,'quantity',1,'uom','g'))));
    raise exception 'Portion to gram conversion invented';
  exception when check_violation then null; end;
  if (select count(*) from public.products)<>v_before then raise exception 'Failed save left orphan product'; end if;
  begin
    perform public.save_prepared_base(v_base,'{"name":"QA Sauce","baseUom":"g","yieldQuantity":1000,"ingredients":[{"itemId":"QA-PRODUCT-RAW","quantity":1000,"uom":"ml"}]}');
    set constraints all immediate; raise exception 'Base unit change broke product recipe';
  exception when check_violation then null; end;
  set constraints all deferred;
  begin
    update public.recipe_ingredients set item_id=null,base_id=v_base where recipe_id=(select recipe_id from public.bases where id=v_base);
    set constraints all immediate; raise exception 'Nested base recipe accepted';
  exception when check_violation then null; end;
  set constraints all deferred;
  perform public.delete_catalog_product(v_variant); perform public.delete_catalog_product(v_addon); perform public.delete_catalog_product(v_menu);
  set constraints all immediate;
  if exists(select 1 from public.recipes where id=v_recipe) or exists(select 1 from public.recipe_ingredients where recipe_id=v_recipe) then raise exception 'Delete left orphan recipe'; end if;
  perform public.delete_prepared_base(v_base); perform public.delete_inventory_item(v_item);
  if has_table_privilege('anon','public.products','SELECT') or has_table_privilege('authenticated','public.categories','SELECT')
    or has_function_privilege('authenticated','public.save_catalog_product(text,jsonb)','EXECUTE') or has_function_privilege('authenticated','public.create_product_category(text)','EXECUTE') then raise exception 'Private catalog access exposed'; end if;
end $$;
select 'PASS: categories, atomic product recipes, main-menu variants, protected references, one-unit yield, valid ingredients and units, rollback, cleanup and private grants';
rollback;
