begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local search_path=public;

-- Preserve anomalous timestamps as evidence during a manager review. Unreviewed
-- writes still require chronological order. Acceptance is guarded in the RPC,
-- with explicit acknowledgement, authenticated region scope and an audit entry.
alter table staffing_sessions drop constraint staffing_sessions_check;
alter table staffing_sessions add constraint staffing_sessions_reviewed_time_order check (
 coalesce(corrected_out_at,check_out_at)is null
 or coalesce(corrected_out_at,check_out_at)>=coalesce(corrected_in_at,check_in_at)
 or (reviewed_at is not null and reviewed_by is not null)
);

create function staffing_attendance_time_warnings(p_in timestamptz,p_out timestamptz)
returns jsonb language sql stable set search_path=public as $$
 select coalesce(jsonb_agg(message order by position),'[]'::jsonb)from(values
  (1,p_out<p_in,'Waktu salah. Jam pulang lebih awal daripada jam masuk.'),
  (2,p_out>p_in+interval '48 hours','Periksa waktu aktual. Durasi melebihi 48 jam.'),
  (3,p_in>now(),'Waktu salah. Jam masuk berada di masa depan.'),
  (4,p_out>now(),'Waktu salah. Jam pulang berada di masa depan.')
 )as warnings(position,applies,message)where applies;
$$;

create or replace function staffing_review_attendance(p_actor uuid,p_bootstrap boolean,p_data jsonb)returns jsonb language plpgsql set search_path=public as $$
declare
 se staffing_sessions;sh staffing_shifts;v_stores uuid[];v_meta jsonb;v_in timestamptz;v_out timestamptz;
 v_state text;v_note text;v_key uuid;v_cached staffing_operation_keys;v_actor text;v_result jsonb;v_zone text;v_anomalies jsonb;v_acknowledged boolean;
begin
 v_stores:=staffing_actor_stores(p_actor,p_bootstrap);
 select * into se from staffing_sessions where id=(p_data->>'session_id')::uuid;
 select * into sh from staffing_shifts where id=se.shift_id;
 if se.id is null or not sh.store_id=any(v_stores)then raise exception 'FORBIDDEN';end if;
 perform id from staffing_staff where id=se.staff_id for update;
 select * into se from staffing_sessions where id=se.id for update;
 v_actor:=coalesce(p_actor::text,'bootstrap-super-admin');v_key:=(p_data->>'client_id')::uuid;
 if v_key is null then raise exception 'Identitas pengajuan wajib diisi';end if;
 insert into staffing_operation_keys(key,actor,action,data_hash)values(v_key,v_actor,'review_attendance',md5((p_data-'client_id')::text))on conflict do nothing;
 if not found then
  select * into v_cached from staffing_operation_keys where key=v_key;
  if v_cached.actor<>v_actor or v_cached.action<>'review_attendance'or v_cached.data_hash<>md5((p_data-'client_id')::text)then raise exception 'Pengajuan sudah tercatat dengan data lain; muat ulang';end if;
  return v_cached.result;
 end if;
 v_meta:=staffing_attendance_metadata(se.id);
 if p_data->>'version'is null or p_data->>'version'<>v_meta->>'review_version'then raise exception 'ATTENDANCE_STALE';end if;
 v_in:=coalesce(se.corrected_in_at,se.check_in_at);v_out:=coalesce(se.corrected_out_at,se.check_out_at);
 if coalesce((p_data->>'correct_times')::boolean,false)then v_in:=(p_data->>'check_in_at')::timestamptz;v_out:=nullif(p_data->>'check_out_at','')::timestamptz;end if;
 v_state:=p_data->>'state';v_note:=coalesce(trim(p_data->>'note'),'');
 if v_state is null or v_state not in('pending','confirmed','rejected')or length(v_note)>1000 then raise exception 'Pilih status review yang valid; catatan opsional maksimal 1000 karakter';end if;
 if v_out is null and se.check_out_at is not null then raise exception 'Checkout asli tidak dapat dikosongkan; koreksi waktunya';end if;
 if v_in is null then raise exception 'Waktu masuk wajib diisi';end if;
 v_anomalies:=staffing_attendance_time_warnings(v_in,v_out);
 v_acknowledged:=p_data->'acknowledge_time_anomalies'='true'::jsonb;
 if v_state='confirmed'and jsonb_array_length(v_anomalies)>0 and v_acknowledged is not true then
  raise exception 'ATTENDANCE_ANOMALY_CONFIRMATION_REQUIRED: %',v_anomalies;
 end if;
 select s.time_zone into v_zone from staffing_staff st join stores s on s.id=st.home_store_id where st.id=se.staff_id;
 if(v_meta->>'payroll_locked')::boolean or exists(select 1 from staffing_payrolls p where p.staff_id=se.staff_id and
 (p.period_start::timestamp at time zone v_zone)<greatest(v_in+interval '1 second',coalesce(v_out,v_in))and((p.period_end+1)::timestamp at time zone v_zone)>least(v_in,coalesce(v_out,v_in)))then raise exception 'Absensi sudah masuk payroll final dan tidak dapat diubah';end if;
 if v_in is distinct from coalesce(se.corrected_in_at,se.check_in_at)or v_out is distinct from coalesce(se.corrected_out_at,se.check_out_at)or v_state<>se.verification_state or v_note is distinct from se.review_note then
  update staffing_sessions set
   corrected_in_at=case when v_in is distinct from coalesce(se.corrected_in_at,se.check_in_at)then v_in else corrected_in_at end,
   corrected_out_at=case when v_out is distinct from coalesce(se.corrected_out_at,se.check_out_at)then v_out else corrected_out_at end,
   verification_state=v_state,review_note=v_note,reviewed_at=now(),reviewed_by=v_actor,overtime_from_attendance=false
  where id=se.id;
  insert into staffing_audit(actor,action,entity_id,details)values(v_actor,'review_attendance',se.id::text,jsonb_build_object('before',to_jsonb(se),'after',(select to_jsonb(s)from staffing_sessions s where s.id=se.id),'time_anomalies',v_anomalies,'time_anomalies_acknowledged',v_state='confirmed'and jsonb_array_length(v_anomalies)>0 and v_acknowledged is true));
 end if;
 v_result:=jsonb_build_object('id',se.id)||staffing_attendance_metadata(se.id);
 update staffing_operation_keys set result=v_result where key=v_key;
 return v_result;
end$$;

revoke all on function staffing_attendance_time_warnings(timestamptz,timestamptz),staffing_review_attendance(uuid,boolean,jsonb)from public,anon,authenticated;
grant execute on function staffing_attendance_time_warnings(timestamptz,timestamptz),staffing_review_attendance(uuid,boolean,jsonb)to service_role;
commit;
