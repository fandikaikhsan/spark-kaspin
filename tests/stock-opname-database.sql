-- Local integration checks; every fixture is rolled back.
begin;
create temporary table stock_fixture(field_key text,section text,name text,uom text);
insert into stock_fixture values
('prep-bayam-krispi','prep','Bayam Krispi','Box Medium'),
('prep-sambal','prep','Sambal','Box Kecil'),
('prep-ayam-suwir','prep','Ayam Suwir','Porsi'),
('prep-base-nasgor','prep','Base Nasgor','Box Kecil'),
('prep-base-carbonara','prep','Base Carbonara','Box Kecil'),
('prep-ayam-sous-vide','prep','Ayam Sous Vide','Vacuum Pack'),
('beef-shortplate','inventory','Beef Shortplate','Pack'),
('dada-ayam-fillet','inventory','Dada Ayam Fillet','Pack'),
('paha-ayam-fillet','inventory','Paha Ayam Fillet','Pack'),
('sosis','inventory','Sosis','Pack'),
('nugget','inventory','Nugget','Pack'),
('kentang','inventory','Kentang','Pack'),
('kornet','inventory','Kornet','Kaleng'),
('roti-kadet','inventory','Roti Kadet','Pack'),
('beras','inventory','Beras','Karung'),
('telur','inventory','Telur','Tray'),
('minyak-goreng','inventory','Minyak Goreng','Pack'),
('kaldu-jamur','inventory','Kaldu Jamur','Pack'),
('lada-hitam','inventory','Lada Hitam','Pack'),
('bawang-goreng','inventory','Bawang Goreng','Pack'),
('saus-tiram','inventory','Saus Tiram','Pack'),
('saus-teriyaki','inventory','Saus Teriyaki','Pack'),
('kecap-manis','inventory','Kecap Manis','Pack'),
('saus-sambal','inventory','Saus Sambal','Pack'),
('susu','inventory','Susu','Pack'),
('stevia','inventory','Stevia','Botol'),
('mi-telur','inventory','Mi Telur','Pack'),
('chatramue','inventory','Chatramue','Pack'),
('bawang-merah','restock','Bawang Merah',null),
('bawang-putih','restock','Bawang Putih',null),
('tomat','restock','Tomat',null),
('cabe-besar','restock','Cabe Besar',null),
('cabe-rawit','restock','Cabe Rawit',null),
('bayam','restock','Bayam',null),
('daun-bawang','restock','Daun Bawang',null),
('garam','restock','Garam',null),
('gula','restock','Gula',null),
('jinten','restock','Jinten',null),
('kencur','restock','Kencur',null),
('kemiri','restock','Kemiri',null);

do $$
declare v_store uuid; v_id uuid:=gen_random_uuid(); v_bad uuid:=gen_random_uuid(); v_lines jsonb; v_result jsonb;
begin
  select id into v_store from public.stores where active order by is_default desc,id limit 1;
  if v_store is null then raise exception 'An active local store is required'; end if;
  select jsonb_agg(jsonb_build_object('field_key',field_key,'section',section,'name',name,'uom',uom,'note','',
    'quantity',case when section<>'restock' then 0.5 end,'needs_restock',case when section='restock' then false end) order by field_key) into v_lines from stock_fixture;
  v_result:=public.submit_stock_opname(v_id,v_store,'2026-10-22','Andi Salsa','qa-stock-opname',v_lines);
  set constraints all immediate; set constraints all deferred;
  if v_result->>'replayed'<>'false' or (select count(*) from public.stock_opname_lines where stock_opname_id=v_id)<>40 then raise exception 'Incomplete submission'; end if;
  if (select count(*) from public.stock_opname_lines where stock_opname_id=v_id and section='prep')<>6 then raise exception 'Prep section changed'; end if;
  if (select quantity from public.stock_opname_lines where stock_opname_id=v_id and field_key='sosis')<>0.5 then raise exception 'Fraction lost'; end if;
  if (select needs_restock from public.stock_opname_lines where stock_opname_id=v_id and field_key='bayam') is distinct from false then raise exception 'Explicit Tidak lost'; end if;
  v_result:=public.submit_stock_opname(v_id,v_store,'2026-10-22','Andi Salsa','qa-stock-opname',v_lines);
  if v_result->>'replayed'<>'true' or (select count(*) from public.stock_opnames where id=v_id)<>1 then raise exception 'Retry created a duplicate'; end if;
  begin
    perform public.submit_stock_opname(v_id,v_store,'2026-10-22','Chandra','qa-stock-opname',v_lines);
    raise exception 'Retry overwrote counter';
  exception when unique_violation then null; end;
  begin
    perform public.submit_stock_opname(v_id,v_store,'2026-10-22','Andi Salsa','qa-stock-opname',jsonb_set(v_lines,'{0,needs_restock}','true'));
    raise exception 'Retry overwrote answer';
  exception when unique_violation then null; end;
  begin
    perform public.submit_stock_opname(v_bad,v_store,'2026-10-22','Andi Salsa','qa-stock-opname',v_lines-0);
    raise exception 'Missing answer accepted';
  exception when check_violation then null; end;
  begin
    perform public.submit_stock_opname(v_bad,v_store,'2026-10-22','Andi Salsa','qa-stock-opname',jsonb_set(v_lines,'{0,field_key}','"unknown"'));
    raise exception 'Unknown answer accepted';
  exception when check_violation then null; end;
  begin
    perform public.submit_stock_opname(v_bad,v_store,'2026-10-22','Andi Salsa','qa-stock-opname',jsonb_set(v_lines,'{0}',v_lines->1));
    raise exception 'Duplicate field accepted';
  exception when unique_violation then null; end;
  begin
    perform public.submit_stock_opname(v_bad,v_store,'2026-10-22','Unknown','qa-stock-opname',v_lines);
    raise exception 'Unknown counter accepted';
  exception when check_violation then null; end;
  begin
    perform public.submit_stock_opname(v_bad,gen_random_uuid(),'2026-10-22','Andi Salsa','qa-stock-opname',v_lines);
    raise exception 'Unknown store accepted';
  exception when check_violation then null; end;
  update public.stores set active=false where id=v_store;
  begin
    perform public.submit_stock_opname(v_bad,v_store,'2026-10-22','Andi Salsa','qa-stock-opname',v_lines);
    raise exception 'Inactive store accepted';
  exception when check_violation then null; end;
  update public.stores set active=true where id=v_store;
  -- Fail late in the line insert, after a header was attempted: everything must roll back.
  begin
    perform public.submit_stock_opname(v_bad,v_store,'2026-10-22','Andi Salsa','qa-stock-opname',jsonb_set(v_lines,'{39,quantity}','-1'));
    raise exception 'Negative count accepted';
  exception when check_violation then null; end;
  if exists(select 1 from public.stock_opnames where id=v_bad) then raise exception 'Failed submission left a header behind'; end if;
  begin
    delete from public.stock_opname_lines where stock_opname_id=v_id and field_key='sosis';
    set constraints all immediate; raise exception 'Incomplete saved submission accepted';
  exception when check_violation then null; end;
  set constraints all deferred;
  if has_table_privilege('anon','public.stock_opnames','select') or has_table_privilege('authenticated','public.stock_opname_lines','insert')
    or has_function_privilege('anon','public.submit_stock_opname(uuid,uuid,date,text,text,jsonb)','execute') then raise exception 'Public access was granted'; end if;
  delete from public.stock_opnames where id=v_id;
  set constraints all immediate;
  if exists(select 1 from public.stock_opname_lines where stock_opname_id=v_id) then raise exception 'Orphaned lines'; end if;
end;
$$;
rollback;
