begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local search_path=public;

alter table staffing_requests add column revision integer not null default 0 check(revision>=0);
alter table staffing_requests add column original_values jsonb;
alter table staffing_requests add column amended_at timestamptz;
alter table staffing_requests add column amendment_note text;

-- Pending applications may be corrected before approval. Original evidence,
-- identity, kind, reason and submission date remain intact.
create function staffing_amend_request(p_actor uuid,p_bootstrap boolean,p_data jsonb)
returns jsonb language plpgsql set search_path=public as $$
declare r staffing_requests; st staffing_staff; before_value jsonb; after_value jsonb;
 actor text:=coalesce(p_actor::text,'bootstrap-super-admin'); stores_allowed uuid[];
 cache staffing_operation_keys; key_id uuid:=(p_data->>'client_id')::uuid;
 money jsonb; amount_value bigint; total numeric:=0; item jsonb; dates jsonb; start_day date; end_day date;
 v_result jsonb; note text:=trim(p_data->>'note');
begin
 stores_allowed:=staffing_actor_stores(p_actor,p_bootstrap);
 select * into r from staffing_requests where id=(p_data->>'request_id')::uuid;
 st:=staffing_require_staff(p_actor,p_bootstrap,r.staff_id);
 select * into st from staffing_staff where id=st.id for update;
 if not st.home_store_id=any(stores_allowed) then raise exception 'FORBIDDEN'; end if;
 select * into r from staffing_requests where id=r.id for update;
 if key_id is null then raise exception 'Identitas perubahan wajib diisi'; end if;
 insert into staffing_operation_keys(key,actor,action,data_hash)values(key_id,actor,'amend_request',md5((p_data-'client_id')::text))on conflict do nothing;
 if not found then
  select * into cache from staffing_operation_keys where key=key_id;
  if cache.actor<>actor or cache.action<>'amend_request' or cache.data_hash<>md5((p_data-'client_id')::text) then raise exception 'Perubahan sudah tercatat dengan data lain; muat ulang'; end if;
  return cache.result;
 end if;
 if not st.active then raise exception 'Staff tidak aktif'; end if;
 if r.status<>'pending' then raise exception 'Pengajuan sudah diproses. Hanya pengajuan menunggu review yang dapat diedit'; end if;
 if p_data->>'revision' is null or (p_data->>'revision')::integer<>r.revision then raise exception 'REQUEST_STALE'; end if;
 if length(coalesce(note,''))not between 5 and 1000 then raise exception 'Alasan perubahan wajib 5 sampai 1000 karakter'; end if;
 before_value:=to_jsonb(r);
 money:=staffing_staff_money(st.id);
 if r.kind='cash_advance' then
  if coalesce(p_data->>'amount','')!~'^[0-9]{1,13}$' then raise exception 'Nominal kasbon harus berupa rupiah bulat'; end if;
  amount_value:=(p_data->>'amount')::bigint;
  if amount_value<=0 or amount_value>greatest(coalesce((money->>'available')::numeric,0)-coalesce((select sum(amount) from staffing_requests where staff_id=st.id and kind='cash_advance' and status='pending' and id<>r.id),0),0) then
   raise exception 'Nominal melebihi jatah kasbon tersedia setelah pengajuan pending lain';
  end if;
  if amount_value=r.amount then raise exception 'Belum ada perubahan nominal'; end if;
  update staffing_requests set amount=amount_value where id=r.id;
 else
  start_day:=(p_data->>'start_date')::date;end_day:=(p_data->>'end_date')::date;
  if start_day is null or end_day is null or end_day<start_day or end_day-start_day>61
    or jsonb_typeof(p_data->'leave_dates')is distinct from 'array' then raise exception 'Pilih periode izin valid, maksimal 62 hari'; end if;
  if jsonb_array_length(p_data->'leave_dates')not between 1 and 62 then raise exception 'Pilih tanggal yang dihitung sebagai izin'; end if;
  for item in select * from jsonb_array_elements(p_data->'leave_dates') loop
   if item->>'date' is null or (item->>'date')::date not between start_day and end_day
     or coalesce((item->>'units')::numeric,0)not in(0.5,1) then raise exception 'Tanggal atau unit izin tidak valid'; end if;
   total:=total+(item->>'units')::numeric;
  end loop;
  if (select count(distinct (d->>'date')::date) from jsonb_array_elements(p_data->'leave_dates')d)<>jsonb_array_length(p_data->'leave_dates') then raise exception 'Tanggal izin duplikat'; end if;
  select jsonb_agg(jsonb_build_object('date',(d->>'date')::date,'units',(d->>'units')::numeric)order by(d->>'date')::date) into dates from jsonb_array_elements(p_data->'leave_dates')d;
  if start_day=r.start_date and end_day=r.end_date and dates=(select jsonb_agg(d order by d->>'date')from jsonb_array_elements(r.leave_dates)d) then raise exception 'Belum ada perubahan tanggal atau jumlah hari'; end if;
  -- Both old and proposed dates must stay outside immutable payroll periods.
  if exists(select 1 from staffing_payrolls p,jsonb_array_elements(r.leave_dates||dates)d where p.staff_id=st.id and(d->>'date')::date between p.period_start and p.period_end) then raise exception 'Periode payroll sudah final; pengajuan tidak dapat diubah'; end if;
  if exists(select 1 from staffing_shifts sh join stores so on so.id=sh.store_id,jsonb_array_elements(r.leave_dates||dates)d where sh.staff_id=st.id and not sh.store_id=any(stores_allowed) and(sh.starts_at at time zone so.time_zone)::date=(d->>'date')::date) then raise exception 'FORBIDDEN'; end if;
  if exists(select 1 from staffing_requests other,jsonb_array_elements(other.leave_dates)a,jsonb_array_elements(dates)b where other.staff_id=st.id and other.id<>r.id and other.kind<>'cash_advance' and other.status in('pending','approved') and(a->>'date')::date=(b->>'date')::date) then raise exception 'Tanggal izin bertabrakan dengan pengajuan lain'; end if;
  if r.payment_mode='leave' and total>coalesce((money->>'leave_balance')::numeric,0)-coalesce((select sum(days)from staffing_requests where staff_id=st.id and id<>r.id and payment_mode='leave' and status='pending'),0) then raise exception 'Saldo izin berbayar tidak mencukupi setelah pengajuan pending lain'; end if;
  update staffing_requests set start_date=start_day,end_date=end_day,leave_dates=dates,days=total where id=r.id;
 end if;
 update staffing_requests set original_values=coalesce(original_values,jsonb_build_object('start_date',r.start_date,'end_date',r.end_date,'days',r.days,'leave_dates',r.leave_dates,'amount',r.amount)),revision=revision+1,amended_at=now(),amendment_note=note where id=r.id returning to_jsonb(staffing_requests.*)into after_value;
 insert into staffing_audit(actor,action,entity_id,details)values(actor,'amend_request',r.id::text,jsonb_build_object('before',before_value,'after',after_value,'note',note));
 v_result:=jsonb_build_object('id',r.id,'request',after_value);
 update staffing_operation_keys set result=v_result where key=key_id;
 return v_result;
end $$;

create function staffing_notify_request_amendment()returns trigger language plpgsql set search_path=public as $$
declare uid bigint;body text;begin
 if new.revision=old.revision then return new;end if;
 select telegram_user_id into uid from staffing_staff where id=new.staff_id and active;
 if uid is null then return new;end if;
 body:='Manager memperbarui pengajuanmu.'||E'\n'||case new.kind when 'cash_advance' then 'Kasbon: Rp'||old.amount||' → Rp'||new.amount else 'Periode: '||to_char(old.start_date,'DD/MM/YYYY')||' – '||to_char(old.end_date,'DD/MM/YYYY')||' ('||old.days||' hari) → '||to_char(new.start_date,'DD/MM/YYYY')||' – '||to_char(new.end_date,'DD/MM/YYYY')||' ('||new.days||' hari)' end||E'\nAlasan: '||new.amendment_note||E'\nStatus tetap menunggu review. Hubungi manager jika perlu klarifikasi.';
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',uid,'text',body));return new;
end $$;
create trigger staffing_request_amendment_notification after update of revision on staffing_requests for each row execute function staffing_notify_request_amendment();
revoke all on function staffing_amend_request(uuid,boolean,jsonb),staffing_notify_request_amendment()from public,anon,authenticated;
grant execute on function staffing_amend_request(uuid,boolean,jsonb),staffing_notify_request_amendment()to service_role;
commit;
