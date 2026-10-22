-- Local integration checks. All receiving/catalog fixtures are rolled back.
begin;
do $$
declare v_store uuid; v_id uuid:=gen_random_uuid(); v_bad uuid:=gen_random_uuid(); v_lines jsonb; v_result jsonb;
  v_revision timestamptz; v_before bigint; v_received timestamptz;
begin
  select id into v_store from public.stores where active order by is_default desc,id limit 1;
  if v_store is null then raise exception 'Active local store required'; end if;
  select count(*) into v_before from public.stock_opnames;
  perform public.save_inventory_item(null,'{"id":"QA-RECEIVING-BEEF","name":"QA Receiving Beef","baseUom":"g","purchasePrice":50000,"purchaseQuantity":1,"purchaseUnitName":"pack","purchaseConversion":500}');
  perform public.save_inventory_item(null,'{"id":"QA-RECEIVING-WATER","name":"QA Receiving Water","baseUom":"pcs","purchasePrice":5000,"purchaseQuantity":1,"purchaseUnitName":"bottle","purchaseConversion":1}');
  set constraints all immediate; set constraints all deferred;
  select jsonb_agg(jsonb_build_object('itemId',id,'quantity',case when id='QA-RECEIVING-BEEF' then 10 else 1.5 end,'itemUpdatedAt',updated_at) order by id) into v_lines
    from public.items where id in ('QA-RECEIVING-BEEF','QA-RECEIVING-WATER');
  v_result:=public.submit_receiving(v_id,v_store,'Andi Salsa','qa-receiving',v_lines);
  set constraints all immediate; set constraints all deferred;
  if v_result->>'replayed'<>'false' or (select count(*) from public.receiving_lines where receiving_id=v_id)<>2 then raise exception 'Delivery not fully saved'; end if;
  if (select quantity from public.receiving_lines where receiving_id=v_id and item_id='QA-RECEIVING-WATER')<>1.5 then raise exception 'Fraction lost'; end if;
  if not exists(select 1 from public.receiving_lines where receiving_id=v_id and item_id='QA-RECEIVING-BEEF' and purchase_unit_name='pack' and purchase_conversion=500 and quantity=10) then raise exception 'Wrong catalog unit'; end if;
  select received_at into v_received from public.receivings where id=v_id;
  if v_received is null then raise exception 'Server receipt time missing'; end if;
  if (select count(*) from public.stock_opnames)<>v_before then raise exception 'Physical counts were overwritten'; end if;
  v_result:=public.submit_receiving(v_id,v_store,'Andi Salsa','qa-receiving',v_lines);
  if v_result->>'replayed'<>'true' then raise exception 'Retry created another delivery'; end if;
  begin
    perform public.submit_receiving(v_id,v_store,'Chandra','qa-receiving',v_lines); raise exception 'Conflicting retry accepted';
  exception when unique_violation then null; end;
  begin
    perform public.submit_receiving(v_bad,v_store,'Andi Salsa','qa-receiving','[]'); raise exception 'Empty delivery accepted';
  exception when check_violation then null; end;
  begin
    perform public.submit_receiving(v_bad,v_store,'Unknown','qa-receiving',v_lines); raise exception 'Unknown receiver accepted';
  exception when check_violation then null; end;
  begin
    perform public.submit_receiving(v_bad,v_store,'Andi Salsa','qa-receiving',jsonb_set(v_lines,'{1,itemId}','"QA-RECEIVING-NONEXISTENT"')); raise exception 'Unknown item accepted';
  exception when no_data_found then null; end;
  begin
    perform public.submit_receiving(v_bad,v_store,'Andi Salsa','qa-receiving',jsonb_set(v_lines,'{1,quantity}','0')); raise exception 'Zero received quantity accepted';
  exception when check_violation then null; end;
  begin
    perform public.submit_receiving(v_bad,v_store,'Andi Salsa','qa-receiving',jsonb_set(v_lines,'{1}',v_lines->0)); raise exception 'Duplicate item accepted';
  exception when unique_violation then null; end;
  if exists(select 1 from public.receivings where id=v_bad) then raise exception 'Failed receipt left partial data'; end if;
  update public.stores set active=false where id=v_store;
  begin
    perform public.submit_receiving(v_bad,v_store,'Andi Salsa','qa-receiving',v_lines); raise exception 'Inactive store accepted';
  exception when check_violation then null; end;
  update public.stores set active=true where id=v_store;
  -- Edit the catalog unit after saving: historical receipts and exact retries stay unchanged.
  perform public.save_inventory_item('QA-RECEIVING-BEEF','{"name":"QA Renamed Beef","baseUom":"g","purchasePrice":70000,"purchaseQuantity":1,"purchaseUnitName":"carton","purchaseConversion":1000}');
  begin
    perform public.submit_receiving(v_bad,v_store,'Andi Salsa','qa-receiving',v_lines); raise exception 'Stale unit accepted';
  exception when serialization_failure then null; end;
  v_result:=public.submit_receiving(v_id,v_store,'Andi Salsa','qa-receiving',v_lines);
  if v_result->>'replayed'<>'true' or (select received_at from public.receivings where id=v_id)<>v_received then raise exception 'Retry rewrote history'; end if;
  if not exists(select 1 from public.receiving_lines where receiving_id=v_id and item_id='QA-RECEIVING-BEEF' and item_name='QA Receiving Beef' and purchase_unit_name='pack' and purchase_conversion=500) then raise exception 'Catalog edit rewrote received unit'; end if;
  begin
    perform public.delete_inventory_item('QA-RECEIVING-BEEF'); raise exception 'Used item deleted';
  exception when foreign_key_violation then null; end;
  begin
    delete from public.receiving_lines where receiving_id=v_id;
    set constraints all immediate; raise exception 'Empty saved receiving accepted';
  exception when check_violation then null; end;
  set constraints all deferred;
  if has_table_privilege('anon','public.receivings','select') or has_table_privilege('authenticated','public.receiving_lines','insert')
    or has_function_privilege('anon','public.submit_receiving(uuid,uuid,text,text,jsonb)','execute') then raise exception 'Public receiving access granted'; end if;
  delete from public.receivings where id=v_id;
  set constraints all immediate;
  if exists(select 1 from public.receiving_lines where receiving_id=v_id) then raise exception 'Orphaned receipt lines'; end if;
end;
$$;
rollback;
