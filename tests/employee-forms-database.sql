-- Local, rollback-only checks. No test stock counts remain afterwards.
begin;
do $$
declare v_store uuid; v_zone text; v_id uuid:=gen_random_uuid(); v_lines jsonb; v_result jsonb;
  v_time timestamptz; v_date date; v_submitted timestamptz;
begin
  select id,time_zone into v_store,v_zone from public.stores where active order by is_default desc,id limit 1;
  if v_store is null then raise exception 'Active local store required'; end if;
  select jsonb_agg(jsonb_build_object('field_key',k,'section',public.stock_opname_field_section(k),'name',k,
    'quantity',case when public.stock_opname_field_section(k)<>'restock' then 0 end,
    'needs_restock',case when public.stock_opname_field_section(k)='restock' then false end,
    'uom',case when public.stock_opname_field_section(k)<>'restock' then 'Pack' end)) into v_lines
  from unnest(array['prep-bayam-krispi','prep-sambal','prep-ayam-suwir','prep-base-nasgor','prep-base-carbonara','prep-ayam-sous-vide',
    'beef-shortplate','dada-ayam-fillet','paha-ayam-fillet','sosis','nugget','kentang','kornet','roti-kadet','beras','telur','minyak-goreng','kaldu-jamur','lada-hitam','bawang-goreng','saus-tiram','saus-teriyaki','kecap-manis','saus-sambal','susu','stevia','mi-telur','chatramue',
    'bawang-merah','bawang-putih','tomat','cabe-besar','cabe-rawit','bayam','daun-bawang','garam','gula','jinten','kencur','kemiri']) as f(k);
  v_result:=public.submit_stock_opname_now(v_id,v_store,'Andi Salsa','employee-form',v_lines);
  if (v_result->>'replayed')::boolean then raise exception 'First submission should not be replayed'; end if;
  select counted_at,count_date,submitted_at into v_time,v_date,v_submitted from public.stock_opnames where id=v_id;
  if v_time is null or v_time<>v_submitted or v_date<>(v_time at time zone v_zone)::date then
    raise exception 'Automatic date/time must equal server submission time in the store timezone';
  end if;
  if abs(extract(epoch from clock_timestamp()-v_time))>60 then raise exception 'Unexpected automatic timestamp'; end if;
  perform pg_sleep(0.01);
  v_result:=public.submit_stock_opname_now(v_id,v_store,'Andi Salsa','employee-form',v_lines);
  if not (v_result->>'replayed')::boolean then raise exception 'Retry did not replay'; end if;
  if (select counted_at from public.stock_opnames where id=v_id)<>v_time then raise exception 'Retry altered the count timestamp'; end if;
  if (select count(*) from public.stock_opname_lines where stock_opname_id=v_id)<>40 then raise exception 'Expected exactly 40 lines'; end if;
  begin
    perform public.submit_stock_opname_now(v_id,v_store,'Chandra','employee-form',v_lines);
    raise exception 'Retry overwrote employee identity';
  exception when unique_violation then null; end;
  begin
    perform public.submit_stock_opname_now(gen_random_uuid(),v_store,'Andi Salsa','employee-form','[]'::jsonb);
    raise exception 'Incomplete stock form accepted';
  exception when check_violation then null; end;
  if has_function_privilege('anon','public.submit_stock_opname_now(uuid,uuid,text,text,jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.submit_stock_opname_now(uuid,uuid,text,text,jsonb)','EXECUTE')
    or has_table_privilege('anon','public.stock_opnames','SELECT') or has_table_privilege('anon','public.receivings','INSERT') then
    raise exception 'Public HTTP forms must not open direct database access';
  end if;
  set constraints all immediate;
end $$;
rollback;
