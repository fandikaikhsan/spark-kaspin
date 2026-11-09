begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local search_path = public;
alter table staffing_sessions add column overtime_from_attendance boolean not null default false;
alter table staffing_shifts add column replaces_staff_id uuid references staffing_staff(id);

-- Keep the previous owner on a committed reassignment. The weekly commit already
-- checks both scopes, locks staff rows, rejects overlaps and locks attended shifts.
create function staffing_record_replacement()returns trigger language plpgsql set search_path=public as $$begin
 if new.staff_id<>old.staff_id then new.replaces_staff_id:=old.staff_id;end if;return new;
end$$;
create trigger staffing_replacement before update of staff_id on staffing_shifts for each row execute function staffing_record_replacement();

create function staffing_shift_metadata(p_shift uuid)returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object('replaces_staff_id',sh.replaces_staff_id,'replaced_staff_name',st.full_name)from staffing_shifts sh left join staffing_staff st on st.id=sh.replaces_staff_id where sh.id=p_shift;
$$;
create function staffing_attendance_metadata(p_session uuid)returns jsonb language sql stable set search_path=public as $$
 select staffing_shift_metadata(sh.id)||jsonb_build_object(
 'review_version',md5(jsonb_build_object('session',to_jsonb(se),'shift',to_jsonb(sh))::text),
 'overtime_from_attendance',se.overtime_from_attendance,
 'payroll_locked',exists(select 1 from staffing_payrolls p where p.staff_id=se.staff_id and
  (p.period_start::timestamp at time zone home.time_zone)<greatest(sh.ends_at,coalesce(se.corrected_out_at,se.check_out_at,se.check_in_at))and
  ((p.period_end+1)::timestamp at time zone home.time_zone)>least(sh.starts_at,coalesce(se.corrected_in_at,se.check_in_at)))
 )from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id join staffing_staff st on st.id=se.staff_id join stores home on home.id=st.home_store_id where se.id=p_session;
$$;

alter function staffing_staff_detail(uuid,boolean,uuid)rename to staffing_staff_detail_v2;
create function staffing_staff_detail(p_actor uuid,p_bootstrap boolean,p_staff uuid)returns jsonb language plpgsql stable set search_path=public as $$declare v jsonb;begin
 v:=staffing_staff_detail_v2(p_actor,p_bootstrap,p_staff);
 v:=jsonb_set(v,'{sessions}',coalesce((select jsonb_agg(r||staffing_attendance_metadata((r->>'id')::uuid)order by r->>'check_in_at' desc)from jsonb_array_elements(v->'sessions')r),'[]'));
 return jsonb_set(v,'{shifts}',coalesce((select jsonb_agg(r||staffing_shift_metadata((r->>'id')::uuid)order by r->>'starts_at' desc)from jsonb_array_elements(v->'shifts')r),'[]'));
end$$;
alter function staffing_schedule_week(uuid,boolean,uuid,date)rename to staffing_schedule_week_v2;
create function staffing_schedule_week(p_actor uuid,p_bootstrap boolean,p_store uuid,p_week date)returns jsonb language plpgsql stable set search_path=public as $$declare v jsonb;begin
 v:=staffing_schedule_week_v2(p_actor,p_bootstrap,p_store,p_week);
 return jsonb_set(v,'{shifts}',coalesce((select jsonb_agg(r||staffing_shift_metadata((r->>'id')::uuid)order by r->>'starts_at')from jsonb_array_elements(v->'shifts')r),'[]'));
end$$;
alter function staffing_activity(uuid,boolean,uuid,date)rename to staffing_activity_v2;
create function staffing_activity(p_actor uuid,p_bootstrap boolean,p_store uuid default null,p_day date default null)returns jsonb language plpgsql stable set search_path=public as $$declare v jsonb;begin
 v:=staffing_activity_v2(p_actor,p_bootstrap,p_store,p_day);
 return jsonb_set(v,'{rows}',coalesce((select jsonb_agg(r||staffing_shift_metadata((r->>'id')::uuid)||case when r->>'session_id'is not null then staffing_attendance_metadata((r->>'session_id')::uuid)else '{}'end order by r->>'starts_at')from jsonb_array_elements(v->'rows')r),'[]'));
end$$;

create function staffing_review_attendance(p_actor uuid,p_bootstrap boolean,p_data jsonb)returns jsonb language plpgsql set search_path=public as $$
declare
 se staffing_sessions;sh staffing_shifts;v_stores uuid[];v_meta jsonb;v_in timestamptz;v_out timestamptz;
 v_state text;v_note text;v_key uuid;v_cached staffing_operation_keys;v_actor text;v_result jsonb;v_zone text;
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
 v_state:=p_data->>'state';v_note:=trim(p_data->>'note');
 if v_state is null or v_state not in('pending','confirmed','rejected')or v_note is null or length(v_note)not between 5 and 1000 then raise exception 'Pilih status review dan isi catatan, minimal 5 karakter';end if;
 if v_out is null and se.check_out_at is not null then raise exception 'Checkout asli tidak dapat dikosongkan; koreksi waktunya';end if;
 if v_in is null or v_in>now()or(v_out is not null and(v_out<v_in or v_out>v_in+interval '48 hours'or v_out>now()))then raise exception 'Periksa waktu aktual; durasi maksimal 48 jam dan tidak boleh di masa depan';end if;
 select s.time_zone into v_zone from staffing_staff st join stores s on s.id=st.home_store_id where st.id=se.staff_id;
 if(v_meta->>'payroll_locked')::boolean or exists(select 1 from staffing_payrolls p where p.staff_id=se.staff_id and
 (p.period_start::timestamp at time zone v_zone)<coalesce(v_out,v_in+interval '1 second')and((p.period_end+1)::timestamp at time zone v_zone)>v_in)then raise exception 'Absensi sudah masuk payroll final dan tidak dapat diubah';end if;
 if v_in is distinct from coalesce(se.corrected_in_at,se.check_in_at)or v_out is distinct from coalesce(se.corrected_out_at,se.check_out_at)or v_state<>se.verification_state or v_note is distinct from se.review_note then
  update staffing_sessions set
   corrected_in_at=case when v_in is distinct from coalesce(se.corrected_in_at,se.check_in_at)then v_in else corrected_in_at end,
   corrected_out_at=case when v_out is distinct from coalesce(se.corrected_out_at,se.check_out_at)then v_out else corrected_out_at end,
   verification_state=v_state,review_note=v_note,reviewed_at=now(),reviewed_by=v_actor,overtime_from_attendance=(v_state='confirmed')
  where id=se.id;
  insert into staffing_audit(actor,action,entity_id,details)values(v_actor,'review_attendance',se.id::text,jsonb_build_object('before',to_jsonb(se),'after',(select to_jsonb(s)from staffing_sessions s where s.id=se.id)));
 end if;
 v_result:=jsonb_build_object('id',se.id)||staffing_attendance_metadata(se.id);
 update staffing_operation_keys set result=v_result where key=v_key;
 return v_result;
end$$;
revoke all on function staffing_record_replacement(),staffing_shift_metadata(uuid),staffing_attendance_metadata(uuid),staffing_staff_detail(uuid,boolean,uuid),staffing_schedule_week(uuid,boolean,uuid,date),staffing_activity(uuid,boolean,uuid,date),staffing_review_attendance(uuid,boolean,jsonb)from public,anon,authenticated;
grant execute on function staffing_record_replacement(),staffing_shift_metadata(uuid),staffing_attendance_metadata(uuid),staffing_staff_detail(uuid,boolean,uuid),staffing_schedule_week(uuid,boolean,uuid,date),staffing_activity(uuid,boolean,uuid,date),staffing_review_attendance(uuid,boolean,jsonb)to service_role;
commit;
