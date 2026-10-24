-- Local-only verification. All fixture records are rolled back.
begin;
do $$
declare v_store uuid; v_count uuid:=gen_random_uuid(); v_item text; v_product text; v_sync bigint;
  v_time timestamptz:=date_trunc('minute',clock_timestamp()-interval '10 minutes'); v_date date; v_zone text; v_lines jsonb; v_result jsonb;
begin
  select id,time_zone into v_store,v_zone from public.stores where active order by is_default desc,id limit 1;
  if v_store is null then raise exception 'Active local store required'; end if;
  v_date:=(v_time at time zone v_zone)::date;
  v_item:=public.save_inventory_item(null,'{"id":"QA-COGS-RAW","name":"QA COGS Raw","baseUom":"g","purchasePrice":0,"purchaseQuantity":1,"purchaseUnitName":"pack","purchaseConversion":500}'::jsonb);
  v_product:=public.save_catalog_product(null,'{"id":"QA-COGS-MENU","name":"QA COGS Menu","type":"menu","salesPrice":0,"baseUom":"porsi","yieldQuantity":2,"ingredients":[{"kind":"item","ingredientId":"QA-COGS-RAW","quantity":500,"uom":"g"}]}'::jsonb);
  insert into public.cogs_count_mappings(store_id,field_key,item_id,conversion,base_uom) values(v_store,'beef-shortplate',v_item,500,'g');
  insert into public.cogs_pos_mappings(store_id,item_code,product_id,output_quantity,output_uom) values(v_store,'QA-POS',v_product,1,'porsi');
  begin
    insert into public.cogs_count_mappings(store_id,field_key,item_id,conversion,base_uom) values(v_store,'sosis',v_item,500,'g');
    raise exception 'Duplicate raw-material count link was accepted';
  exception when unique_violation then null; end;
  begin
    insert into public.cogs_count_mappings(store_id,field_key,item_id,conversion,base_uom) values(v_store,'unknown',v_item,500,'g');
    raise exception 'Non-inventory count field was accepted';
  exception when check_violation then null; end;
  begin
    insert into public.cogs_pos_mappings(store_id,item_code,product_id,output_quantity,output_uom) values(v_store,'unknown-0',v_product,1,'porsi');
    raise exception 'Unstable synthetic POS code was accepted';
  exception when check_violation then null; end;
  begin
    delete from public.products where id=v_product;
    raise exception 'Linked product was deleted';
  exception when foreign_key_violation then null; end;
  select jsonb_agg(jsonb_build_object('field_key',k,'section',public.stock_opname_field_section(k),'name',k,
    'quantity',case when public.stock_opname_field_section(k)<>'restock' then 0 end,
    'needs_restock',case when public.stock_opname_field_section(k)='restock' then false end,
    'uom',case when public.stock_opname_field_section(k)<>'restock' then 'Pack' end)) into v_lines
  from unnest(array['prep-bayam-krispi','prep-sambal','prep-ayam-suwir','prep-base-nasgor','prep-base-carbonara','prep-ayam-sous-vide',
    'beef-shortplate','dada-ayam-fillet','paha-ayam-fillet','sosis','nugget','kentang','kornet','roti-kadet','beras','telur','minyak-goreng','kaldu-jamur','lada-hitam','bawang-goreng','saus-tiram','saus-teriyaki','kecap-manis','saus-sambal','susu','stevia','mi-telur','chatramue',
    'bawang-merah','bawang-putih','tomat','cabe-besar','cabe-rawit','bayam','daun-bawang','garam','gula','jinten','kencur','kemiri']) as f(k);
  v_result:=public.submit_stock_opname_at(v_count,v_store,v_date,'Andi Salsa','qa',v_lines,v_time);
  if (select counted_at from public.stock_opnames where id=v_count) is distinct from v_time then raise exception 'Physical count time was not saved'; end if;
  if (public.submit_stock_opname_at(v_count,v_store,v_date,'Andi Salsa','qa',v_lines,v_time)->>'replayed')::boolean is not true then raise exception 'Retry was not idempotent'; end if;
  begin
    perform public.submit_stock_opname_at(v_count,v_store,v_date,'Andi Salsa','qa',v_lines,v_time-interval '1 minute');
    raise exception 'Retry altered the original count time';
  exception when unique_violation then null; end;
  begin
    perform public.submit_stock_opname_at(gen_random_uuid(),v_store,v_date+1,'Andi Salsa','qa',v_lines,v_time);
    raise exception 'Different store date and count timestamp accepted';
  exception when check_violation then null; end;
  begin
    perform public.submit_stock_opname_at(gen_random_uuid(),v_store,v_date,'Andi Salsa','qa',v_lines,clock_timestamp()+interval '1 hour');
    raise exception 'Future count timestamp accepted';
  exception when check_violation then null; end;
  insert into public.sync_runs(store_id,business_date,trigger,status,successful_cycles,failed_cycles,transaction_count,item_count,started_at,completed_at)
    values(v_store,'1900-01-01','qa-cogs','success',1,0,0,0,v_time,v_time+interval '1 minute') returning id into v_sync;
  if (select confirmed_through from public.cogs_sales_coverage where store_id=v_store and business_date='1900-01-01') is distinct from v_time then
    raise exception 'Coverage should use the conservative fetch-run start, not its completion';
  end if;
  delete from public.sync_runs where id=v_sync;
  if not exists(select 1 from public.cogs_sales_coverage where store_id=v_store and business_date='1900-01-01') then raise exception 'Audit retention removed durable coverage'; end if;
  insert into public.sync_runs(store_id,business_date,trigger,status,successful_cycles,failed_cycles,transaction_count,item_count,started_at,completed_at)
    values(v_store,'1900-01-01','qa-cogs','success',1,0,0,0,v_time-interval '1 hour',v_time+interval '2 minutes');
  if (select confirmed_through from public.cogs_sales_coverage where store_id=v_store and business_date='1900-01-01') is distinct from v_time then raise exception 'Coverage regressed'; end if;
  if has_table_privilege('anon','public.cogs_pos_mappings','SELECT') or has_table_privilege('authenticated','public.cogs_count_mappings','INSERT')
    or has_table_privilege('anon','public.cogs_sales_coverage','SELECT')
    or has_function_privilege('anon','public.submit_stock_opname_at(uuid,uuid,date,text,text,jsonb,timestamptz)','EXECUTE') then
    raise exception 'COGS data accessible outside server role';
  end if;
  set constraints all immediate;
end $$;
rollback;
