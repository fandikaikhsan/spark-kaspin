-- Rollback-only local checks for batch yields and selectable receipt units.
begin;
do $$
declare v_item text; v_product text; v_store uuid; v_receipt uuid:=gen_random_uuid(); v_bad uuid:=gen_random_uuid(); v_lines jsonb; v_recipe uuid; v_result jsonb;
begin
  select id into v_store from public.stores where active order by is_default desc,id limit 1;
  if v_store is null then raise exception 'Active local store required'; end if;
  v_item:=public.save_inventory_item(null,'{"id":"QA-YIELD-UNIT-RAW","name":"QA Yield Unit Raw","baseUom":"g","purchasePrice":50000,"purchaseQuantity":1,"purchaseUnitName":"pack","purchaseConversion":500}');
  v_product:=public.save_catalog_product(null,jsonb_build_object('id','QA-YIELD-UNIT-PRODUCT','name','QA Batch Product','type','menu','salesPrice',10000,'baseUom','porsi','yieldQuantity',20,'ingredients',jsonb_build_array(jsonb_build_object('kind','item','ingredientId',v_item,'quantity',1,'uom','kg'))));
  set constraints all immediate; set constraints all deferred;
  select recipe_id into v_recipe from public.products where id=v_product;
  if not exists(select 1 from public.recipes where id=v_recipe and yield_qty=20) then raise exception 'Batch yield not saved'; end if;
  begin
    perform public.save_catalog_product(v_product,jsonb_build_object('name','Bad Yield','type','menu','salesPrice',10000,'baseUom','porsi','yieldQuantity',0,'ingredients',jsonb_build_array(jsonb_build_object('kind','item','ingredientId',v_item,'quantity',1,'uom','kg'))));
    raise exception 'Zero yield accepted';
  exception when check_violation then null; end;
  if (select yield_qty from public.recipes where id=v_recipe)<>20 then raise exception 'Failed edit changed saved recipe'; end if;
  select jsonb_build_array(jsonb_build_object('itemId',id,'quantity',2,'uom','kg','itemUpdatedAt',updated_at,'received_conversion',999,'quantity_base',999)) into v_lines from public.items where id=v_item;
  perform public.submit_receiving(v_receipt,v_store,'Chandra','qa-units',v_lines);
  set constraints all immediate; set constraints all deferred;
  if not exists(select 1 from public.receiving_lines where receiving_id=v_receipt and received_uom='kg' and quantity=2 and received_conversion=1000 and quantity_base=2000 and purchase_unit_name='pack') then raise exception 'Standard conversion or snapshot incorrect'; end if;
  v_result:=public.submit_receiving(v_receipt,v_store,'Chandra','qa-units',v_lines);
  if v_result->>'replayed'<>'true' then raise exception 'Exact retry failed'; end if;
  begin
    perform public.submit_receiving(v_receipt,v_store,'Chandra','qa-units',jsonb_set(v_lines,'{0,uom}','"g"')); raise exception 'Retry changed unit';
  exception when unique_violation then null; end;
  begin
    perform public.submit_receiving(v_bad,v_store,'Chandra','qa-units',jsonb_set(v_lines,'{0,uom}','"l"')); raise exception 'Mass/volume conversion invented';
  exception when check_violation then null; end;
  begin
    perform public.submit_receiving(v_bad,v_store,'Chandra','qa-units',jsonb_set(v_lines,'{0,uom}','"unknown-pack"')); raise exception 'Unknown pack accepted';
  exception when check_violation then null; end;
  if exists(select 1 from public.receivings where id=v_bad) then raise exception 'Invalid receipt left partial data'; end if;
  perform public.submit_receiving(v_bad,v_store,'Chandra','qa-units',jsonb_set(v_lines,'{0,uom}','"pack"'));
  if not exists(select 1 from public.receiving_lines where receiving_id=v_bad and received_uom='pack' and received_conversion=500 and quantity_base=1000) then raise exception 'Item pack conversion incorrect'; end if;
end;
$$;
rollback;
