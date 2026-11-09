begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local search_path = public;
alter table staffing_staff add column leave_initialized boolean not null default false;
create sequence staffing_staff_code_sequence;
revoke all on sequence staffing_staff_code_sequence from public,anon,authenticated;
grant usage on sequence staffing_staff_code_sequence to service_role;

create or replace function staffing_staff_money(p_staff uuid) returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object(
  'ceiling',st.cash_advance_ceiling,
  'outstanding',greatest(coalesce((select sum(amount)from staffing_cash_ledger where staff_id=st.id),0),0),
  'reserved',coalesce((select sum(amount)from staffing_requests where staff_id=st.id and kind='cash_advance'and status='approved'),0),
  'available',case when st.cash_advance_ceiling is null then null else greatest(st.cash_advance_ceiling-coalesce((select sum(amount)from staffing_cash_ledger where staff_id=st.id),0)-coalesce((select sum(amount)from staffing_requests where staff_id=st.id and kind='cash_advance'and status='approved'),0),0)end,
  'leave_balance',case when st.leave_initialized or exists(select 1 from staffing_leave_entries where staff_id=st.id)then coalesce((select sum(days)from staffing_leave_entries where staff_id=st.id),0)else null end
 )from staffing_staff st where st.id=p_staff;
$$;

create function staffing_create_staff(p_actor uuid,p_bootstrap boolean,p_data jsonb)returns jsonb language plpgsql set search_path=public as $$
declare
 v_stores uuid[];v_store uuid;v_name text;v_leave numeric;v_ceiling numeric;
 v_key uuid;v_actor text;v_cached staffing_operation_keys;v_id uuid;v_code text;v_result jsonb;v_number text;
begin
 v_stores:=staffing_actor_stores(p_actor,p_bootstrap);
 v_store:=(p_data->>'home_store_id')::uuid;
 if v_store is null or not v_store=any(v_stores)or not exists(select 1 from stores s join staffing_store_regions sr on sr.store_id=s.id where s.id=v_store and s.active)then raise exception 'FORBIDDEN';end if;
 v_name:=trim(p_data->>'full_name');
 v_leave:=coalesce(nullif(p_data->>'initial_leave','')::numeric,0);
 v_ceiling:=coalesce(nullif(p_data->>'ceiling','')::numeric,0);
 if v_name is null or length(v_name)not between 1 and 120 then raise exception 'Isi nama staff, maksimal 120 karakter';end if;
 if v_leave<0 or v_leave>1000 or v_leave*2<>trunc(v_leave*2)then raise exception 'Saldo izin awal harus kelipatan setengah hari, antara 0 dan 1000';end if;
 if v_ceiling<0 or v_ceiling>1000000000000 or v_ceiling<>trunc(v_ceiling)then raise exception 'Plafon kasbon harus berupa rupiah bulat yang valid';end if;
 v_key:=(p_data->>'client_id')::uuid;if v_key is null then raise exception 'Identitas pengajuan wajib diisi';end if;
 v_actor:=coalesce(p_actor::text,'bootstrap-super-admin');
 insert into staffing_operation_keys(key,actor,action,data_hash)values(v_key,v_actor,'create_staff',md5((p_data-'client_id')::text))on conflict do nothing;
 if not found then
  select * into v_cached from staffing_operation_keys where key=v_key;
  if v_cached.actor<>v_actor or v_cached.action<>'create_staff'or v_cached.data_hash<>md5((p_data-'client_id')::text)then raise exception 'Pengajuan sudah tercatat dengan data lain; muat ulang';end if;
  return v_cached.result;
 end if;
 for attempt in 1..128 loop
  v_number:=nextval('staffing_staff_code_sequence')::text;
  v_code:='STAF-'||lpad(v_number,greatest(6,length(v_number)),'0');
  insert into staffing_staff(code,full_name,home_store_id,cash_advance_ceiling,leave_initialized)
  values(v_code,v_name,v_store,v_ceiling::bigint,true)on conflict(code)do nothing returning id into v_id;
  exit when v_id is not null;
 end loop;
 if v_id is null then raise exception 'Kode staff belum dapat dibuat; coba kembali';end if;
 if v_leave>0 then insert into staffing_leave_entries(staff_id,days,reason,entry_kind)values(v_id,v_leave,'Saldo awal saat pendaftaran staff','adjustment');end if;
 v_result:=jsonb_build_object('id',v_id,'code',v_code);
 insert into staffing_audit(actor,action,entity_id,details)values(v_actor,'create_staff',v_id::text,p_data-'client_id'||jsonb_build_object('code',v_code));
 update staffing_operation_keys set result=v_result where key=v_key;
 return v_result;
end$$;
revoke all on function staffing_create_staff(uuid,boolean,jsonb)from public,anon,authenticated;
grant execute on function staffing_create_staff(uuid,boolean,jsonb)to service_role;
commit;
