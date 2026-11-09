begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local search_path=public;

alter table staffing_attempts add column submitted_by_staff_id uuid references staffing_staff(id);
alter table staffing_sessions add column check_in_reporter_id uuid references staffing_staff(id);
alter table staffing_sessions add column check_out_reporter_id uuid references staffing_staff(id);

create table staffing_payroll_deliveries(
 payroll_id uuid primary key references staffing_payrolls(id), staff_id uuid not null references staffing_staff(id),
 telegram_user_id bigint not null check(telegram_user_id>0),recipient_version text not null,
 state text not null check(state in('sending','sent','failed','uncertain')),
 token uuid not null default gen_random_uuid(),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 actor text not null,message_id bigint,error_code text
);
alter table staffing_payroll_deliveries enable row level security;
revoke all on staffing_payroll_deliveries from public,anon,authenticated;
grant all on staffing_payroll_deliveries to service_role;

create function staffing_payroll_document(p_actor uuid,p_bootstrap boolean,p_payroll uuid)
returns jsonb language plpgsql stable set search_path=public as $$
declare p staffing_payrolls;st staffing_staff;store stores;delivery staffing_payroll_deliveries;begin
 select * into p from staffing_payrolls where id=p_payroll;
 if p.id is null then raise exception 'Payroll final tidak ditemukan';end if;
 st:=staffing_require_staff(p_actor,p_bootstrap,p.staff_id);
 select * into store from stores where id=st.home_store_id;
 select * into delivery from staffing_payroll_deliveries where payroll_id=p.id;
 return jsonb_build_object('id',p.id,'staff_id',st.id,'staff_name',st.full_name,'staff_code',st.code,'store_name',store.name,'time_zone',store.time_zone,'period_start',p.period_start,'period_end',p.period_end,'created_at',p.created_at,'result',p.result,'final',true,
 'recipient_linked',st.active and st.telegram_user_id is not null,'recipient_version',md5(jsonb_build_object('id',st.id,'telegram',st.telegram_user_id,'active',st.active)::text),
 'delivery_state',delivery.state);
end $$;

create function staffing_reserve_payroll_delivery(p_actor uuid,p_bootstrap boolean,p_payroll uuid,p_recipient_version text)
returns jsonb language plpgsql set search_path=public as $$
declare p staffing_payrolls;st staffing_staff;delivery staffing_payroll_deliveries;version text;begin
 select * into p from staffing_payrolls where id=p_payroll;
 if p.id is null then raise exception 'Payroll final tidak ditemukan';end if;
 st:=staffing_require_staff(p_actor,p_bootstrap,p.staff_id);
 select * into st from staffing_staff where id=st.id for update;
 perform staffing_require_staff(p_actor,p_bootstrap,st.id);
 if not st.active or st.telegram_user_id is null then raise exception 'Staf tidak aktif atau akun Telegram belum tertaut';end if;
 version:=md5(jsonb_build_object('id',st.id,'telegram',st.telegram_user_id,'active',st.active)::text);
 if p_recipient_version is distinct from version then raise exception 'PAYROLL_RECIPIENT_CHANGED';end if;
 select * into delivery from staffing_payroll_deliveries where payroll_id=p.id for update;
 if delivery.state='sent' then return jsonb_build_object('already_sent',true);end if;
 if delivery.state in('sending','uncertain')then raise exception 'Pengiriman masih berjalan atau belum dapat dipastikan. Periksa chat penerima sebelum mengirim ulang';end if;
 insert into staffing_payroll_deliveries(payroll_id,staff_id,telegram_user_id,recipient_version,state,actor)
 values(p.id,st.id,st.telegram_user_id,version,'sending',coalesce(p_actor::text,'bootstrap-super-admin'))
 on conflict(payroll_id)do update set staff_id=excluded.staff_id,telegram_user_id=excluded.telegram_user_id,recipient_version=excluded.recipient_version,state='sending',token=gen_random_uuid(),actor=excluded.actor,updated_at=now(),message_id=null,error_code=null returning * into delivery;
 insert into staffing_audit(actor,action,entity_id,details)values(delivery.actor,'payroll_document_send_started',p.id::text,jsonb_build_object('staff_id',st.id));
 return jsonb_build_object('already_sent',false,'token',delivery.token,'telegram_user_id',st.telegram_user_id,'document',staffing_payroll_document(p_actor,p_bootstrap,p.id));
end $$;

-- A live/uncertain send pins the account mapping. No relink can redirect it.
create function staffing_guard_payroll_recipient()returns trigger language plpgsql set search_path=public as $$begin
 if (new.telegram_user_id is distinct from old.telegram_user_id or new.active is distinct from old.active or new.home_store_id is distinct from old.home_store_id)
 and exists(select 1 from staffing_payroll_deliveries where staff_id=old.id and state in('sending','uncertain'))then raise exception 'Verifikasi pengiriman slip payroll yang masih berjalan sebelum mengubah akun / status staf';end if;
 return new;
end $$;
create trigger staffing_payroll_recipient_guard before update of telegram_user_id,active,home_store_id on staffing_staff for each row execute function staffing_guard_payroll_recipient();

create function staffing_finish_payroll_delivery(p_payroll uuid,p_token uuid,p_state text,p_message bigint default null)
returns void language plpgsql set search_path=public as $$declare d staffing_payroll_deliveries;begin
 if p_state not in('sent','failed','uncertain') or(p_state='sent'and(p_message is null or p_message<=0))then raise exception 'Status pengiriman tidak valid';end if;
 update staffing_payroll_deliveries set state=p_state,message_id=p_message,updated_at=now() where payroll_id=p_payroll and token=p_token and state='sending' returning * into d;
 if d.payroll_id is not null then insert into staffing_audit(actor,action,entity_id,details)values(d.actor,'payroll_document_delivery',p_payroll::text,jsonb_build_object('state',p_state,'staff_id',d.staff_id));end if;
end $$;



alter function staffing_attendance_metadata(uuid)rename to staffing_attendance_metadata_v7;
create function staffing_attendance_metadata(p_session uuid)returns jsonb language sql stable set search_path=public as $$
 select staffing_attendance_metadata_v7(p_session)||jsonb_build_object(
 'check_in_reporter_name',case when se.check_in_reporter_id<>se.staff_id then a.full_name end,
 'check_out_reporter_name',case when se.check_out_reporter_id<>se.staff_id then b.full_name end)
 from staffing_sessions se left join staffing_staff a on a.id=se.check_in_reporter_id left join staffing_staff b on b.id=se.check_out_reporter_id where se.id=p_session;
$$;

create or replace function staffing_review_attendance(p_actor uuid,p_bootstrap boolean,p_data jsonb)returns jsonb language plpgsql set search_path=public as $$
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
 v_state:=p_data->>'state';v_note:=coalesce(trim(p_data->>'note'),'');
 if v_state is null or v_state not in('pending','confirmed','rejected')or length(v_note)>1000 then raise exception 'Pilih status review yang valid; catatan opsional maksimal 1000 karakter';end if;
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

create function public.staffing_attendance_update_v7(p_update jsonb)
returns void language plpgsql set search_path = public as $$
declare
  v_user bigint := (p_update->>'userId')::bigint;
  v_chat bigint := (p_update->>'chatId')::bigint;
  v_kind text := p_update->>'kind';
  v_private boolean := p_update->>'chatType'='private';
  v_reporter staffing_staff; v_flow_deleted boolean:=false; v_subject uuid; v_staff staffing_staff; v_attempt staffing_attempts; v_shift staffing_shifts;
  v_session staffing_sessions; v_link staffing_link_tokens;
  v_store uuid; v_count integer; v_id uuid; v_text text; v_payload jsonb;
  v_effective timestamptz := coalesce((p_update->>'sentAt')::timestamptz,now());
begin
  insert into staffing_inbox(update_id) values((p_update->>'updateId')::bigint) on conflict do nothing;
  if not found then return; end if;
  if v_effective > now()+interval '1 minute' or v_effective < now()-interval '24 hours' then return; end if;
  if v_private then return;end if;

  if not v_private then
    select g.store_id into v_store from staffing_groups g join stores s on s.id=g.store_id where g.chat_id=v_chat and s.active;
    if v_store is null then return; end if;
  end if;
  select * into v_reporter from staffing_staff where telegram_user_id=v_user and active;
  if v_reporter.id is null then return;end if;
  v_subject:=v_reporter.id;
  if v_kind in('proxy_check_in','proxy_check_out')then
    if not exists(select 1 from staffing_staff where id=v_reporter.id and home_store_id=v_store)
      and not exists(select 1 from staffing_shifts where staff_id=v_reporter.id and store_id=v_store and starts_at<=now()+interval '1 day' and ends_at>=now()-interval '1 day')then
      insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_chat,'text','Hanya staf store ini / staf yang sedang ditugaskan di sini dapat mewakili absen.'));return;
    end if;
    select id into v_subject from staffing_staff where code=p_update->>'attendeeCode' and active;
    v_kind:=case v_kind when 'proxy_check_in'then 'check_in'else 'check_out'end;
  elsif v_kind in('confirm','cancel','location','photo')then
    if v_kind in('confirm','cancel')then
      select * into v_attempt from staffing_attempts where coalesce(submitted_by_staff_id,staff_id)=v_reporter.id and chat_id=v_chat
       and(id=(p_update->>'attemptId')::uuid or(p_update->>'attemptId'is null and state in('confirmation','location','photo')))order by received_at desc limit 1;
    else
      select * into v_attempt from staffing_attempts where coalesce(submitted_by_staff_id,staff_id)=v_reporter.id and chat_id=v_chat and prompt_message_id=(p_update->>'replyTo')::bigint and state in('location','photo')order by received_at desc limit 1;
    end if;
    v_subject:=coalesce(v_attempt.staff_id,v_reporter.id);
  end if;
  perform id from staffing_staff where id in(v_reporter.id,v_subject)order by id for update;
  select * into v_reporter from staffing_staff where id=v_reporter.id and telegram_user_id=v_user and active;
  select * into v_staff from staffing_staff where id=v_subject and active;
  if v_reporter.id is null then return;end if;
  if v_kind='cancel'and p_update->>'attemptId'is null then
    delete from staffing_swap_flows where user_id=v_user and chat_id=v_chat;v_flow_deleted:=found;
  end if;
  if v_staff.id is null then
    if v_kind in ('check_in','check_out','schedule') then
      insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_chat,'text','Akun belum ditautkan atau staf tidak aktif. Hubungi manager.'));
    end if; return;
  end if;
  if v_kind in ('check_in','check_out') then
    if exists(select 1 from staffing_attempts where staff_id=v_staff.id and state in('confirmation','location','photo')and expires_at>now()and coalesce(submitted_by_staff_id,staff_id)<>v_reporter.id)then
      insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_chat,'text','Absensi staf ini sedang diverifikasi oleh pelapor lain. Selesaikan atau batalkan proses tersebut dahulu.'));return;
    end if;
    if v_kind='check_in' then
      if exists(select 1 from staffing_sessions where staff_id=v_staff.id and coalesce(corrected_out_at,check_out_at) is null) then
        insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_chat,'text','Masih ada sesi kerja terbuka. Gunakan /pulang atau hubungi manager.')); return;
      end if;
      select count(*) into v_count from staffing_shifts sh where staff_id=v_staff.id and store_id=v_store and starts_at<=now()+interval '2 hours' and ends_at>=now() and not exists(select 1 from staffing_sessions where shift_id=sh.id);
      if v_count<>1 then
        insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_chat,'text','Tidak ditemukan satu shift yang sesuai di store ini. Hubungi manager untuk memeriksa jadwal.')); return;
      end if;
      select * into v_shift from staffing_shifts sh where staff_id=v_staff.id and store_id=v_store and starts_at<=now()+interval '2 hours' and ends_at>=now() and not exists(select 1 from staffing_sessions where shift_id=sh.id);
    else
      select se.* into v_session from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id where se.staff_id=v_staff.id and sh.store_id=v_store and coalesce(se.corrected_out_at,se.check_out_at) is null;
      if v_session.id is null then
        insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_chat,'text','Tidak ada sesi terbuka di store ini. Hubungi manager jika ada absensi yang perlu dikoreksi.')); return;
      end if;
      select * into v_shift from staffing_shifts where id=v_session.shift_id;
    end if;
    update staffing_attempts set state='cancelled' where coalesce(submitted_by_staff_id,staff_id)=v_reporter.id and chat_id=v_chat and state in ('confirmation','location','photo');
    if v_effective < now()-interval '10 minutes' then
      insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_chat,'text','Command sudah kedaluwarsa. Ulangi absensi atau hubungi manager untuk koreksi.'));return;
    end if;
    insert into staffing_attempts(staff_id,submitted_by_staff_id,shift_id,chat_id,kind,state,requested_at,request_message_id,expires_at) values(v_staff.id,v_reporter.id,v_shift.id,v_chat,v_kind,'confirmation',v_effective,(p_update->>'messageId')::bigint,v_effective+interval '10 minutes') returning * into v_attempt;
    select v_staff.full_name||' · '||s.name||E'\n'||v_shift.label||' · '||to_char(v_shift.starts_at at time zone s.time_zone,'DD Mon HH24:MI')||'–'||to_char(v_shift.ends_at at time zone s.time_zone,'DD Mon HH24:MI')||E'\nKonfirmasi '||case when v_kind='check_in' then 'check-in' else 'checkout' end||'. Lanjutkan dengan lokasi dan foto; jam command awal menjadi waktu absen jika lokasi dan foto lengkap dalam 10 menit.' into v_text from stores s where s.id=v_store;
    v_payload := jsonb_build_object('chat_id',v_chat,'text',v_text||case when v_reporter.id<>v_staff.id then E'\nDiwakili oleh '||v_reporter.full_name||'. Bukti dikirim pelapor; menunggu review manager.'else ''end,'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Benar, lanjutkan','callback_data','sf:c:'||v_attempt.id),jsonb_build_object('text','Batal','callback_data','sf:x:'||v_attempt.id)))));
    insert into staffing_outbox(payload,attempt_id,expected_state) values(v_payload,v_attempt.id,'confirmation'); return;
  end if;
  if v_kind in ('confirm','cancel') then
    select * into v_attempt from staffing_attempts where coalesce(submitted_by_staff_id,staff_id)=v_reporter.id and chat_id=v_chat and (id=(p_update->>'attemptId')::uuid or (p_update->>'attemptId' is null and state in ('confirmation','location','photo'))) order by received_at desc limit 1 for update;
  else
    select * into v_attempt from staffing_attempts where coalesce(submitted_by_staff_id,staff_id)=v_reporter.id and chat_id=v_chat and prompt_message_id=(p_update->>'replyTo')::bigint and state in ('location','photo') order by received_at desc limit 1 for update;
  end if;
  if v_attempt.id is null or v_attempt.state in ('completed','cancelled')then
    if v_kind='cancel'then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_chat,'text',case when v_flow_deleted then 'Pemilihan tukar shift dibatalkan. 'else 'Tidak ada verifikasi absensi aktif milikmu di chat ini. 'end||'Absensi / jadwal yang sudah tercatat tidak dihapus. Batalkan permintaan tukar terkirim lewat tombol pada permintaannya.'));end if;
    return;
  end if;
  if v_kind='cancel' then
    update staffing_attempts set state='cancelled' where id=v_attempt.id;
    insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_chat,'text','Proses absensi dibatalkan.')); return;
  end if;
  if v_attempt.expires_at<=now() or v_effective>v_attempt.expires_at then
    update staffing_attempts set state='cancelled' where id=v_attempt.id;
    insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_chat,'text','Verifikasi kedaluwarsa. Mulai kembali dengan /masuk atau /pulang.')); return;
  end if;
  if v_effective < v_attempt.requested_at then return; end if;
  if v_kind='confirm' and v_attempt.state='confirmation' then
    update staffing_attempts set state='location',prompt_message_id=null where id=v_attempt.id;
    v_text := 'Balas pesan ini dengan lokasi melalui Attachment > Location. Lokasi merupakan bukti pendukung untuk pemeriksaan manager.';
    insert into staffing_outbox(payload,attempt_id,expected_state) values(jsonb_build_object('chat_id',v_chat,'text',v_text,'reply_parameters',jsonb_build_object('message_id',v_attempt.request_message_id),'reply_markup',jsonb_build_object('force_reply',true,'selective',true)),v_attempt.id,'location'); return;
  end if;
  if v_kind='location' and v_attempt.state='location' then
    update staffing_attempts set state='photo',prompt_message_id=null,latitude=(p_update->>'latitude')::numeric,longitude=(p_update->>'longitude')::numeric,location_sent_at=v_effective where id=v_attempt.id;
    insert into staffing_outbox(payload,attempt_id,expected_state) values(jsonb_build_object('chat_id',v_chat,'text','Balas pesan ini dengan foto kehadiran di store. Selesaikan sebelum verifikasi kedaluwarsa.','reply_parameters',jsonb_build_object('message_id',v_attempt.request_message_id),'reply_markup',jsonb_build_object('force_reply',true,'selective',true)),v_attempt.id,'photo'); return;
  end if;
  if v_kind='photo' and v_attempt.state='photo' then
    if v_effective < v_attempt.location_sent_at then return; end if;
    v_effective:=v_attempt.requested_at;
    select * into v_shift from staffing_shifts where id=v_attempt.shift_id for update;
    if v_shift.staff_id<>v_staff.id then return;end if;
    if v_attempt.kind='check_in' then
      if exists(select 1 from staffing_sessions where staff_id=v_staff.id and coalesce(corrected_out_at,check_out_at) is null) then return; end if;
      insert into staffing_sessions(shift_id,staff_id,check_in_at,check_in_reporter_id) values(v_shift.id,v_staff.id,v_effective,v_reporter.id) returning * into v_session;
    else
      select * into v_session from staffing_sessions where shift_id=v_shift.id and coalesce(corrected_out_at,check_out_at) is null for update;
      if v_session.id is null or v_effective<coalesce(v_session.corrected_in_at,v_session.check_in_at) then return; end if;
      update staffing_sessions set check_out_at=v_effective,check_out_reporter_id=v_reporter.id,verification_state='pending',review_note=null,reviewed_at=null,reviewed_by=null,overtime_from_attendance=false where id=v_session.id;
    end if;
    update staffing_attempts set state='completed',photo_file_id=p_update->>'fileId',photo_unique_id=p_update->>'fileUniqueId',photo_message_id=(p_update->>'messageId')::bigint,photo_sent_at=(p_update->>'sentAt')::timestamptz,completed_at=now() where id=v_attempt.id;
    insert into staffing_events(session_id,attempt_id,kind,effective_at,timestamp_source,message_id,update_id) values(v_session.id,v_attempt.id,v_attempt.kind,v_effective,'telegram_command',v_attempt.request_message_id,(p_update->>'updateId')::bigint);
    insert into staffing_audit(actor,action,entity_id,details) values('telegram:'||v_user,v_attempt.kind,v_session.id::text,jsonb_build_object('attempt_id',v_attempt.id,'subject_staff_id',v_staff.id,'reported_by_staff_id',v_reporter.id));
    select v_staff.full_name||' · '||s.name||E'\n'||case when v_attempt.kind='check_in' then 'Check-in' else 'Checkout' end||' tercatat: '||to_char(v_effective at time zone s.time_zone,'DD Mon HH24:MI:SS')||' ('||s.time_zone||')'||E'\n'||v_shift.label||case when v_attempt.kind='check_in' then ' · Terlambat '||greatest(0,ceil(extract(epoch from(v_effective-v_shift.starts_at))/60))::text||' menit' else '' end||E'\nLokasi dan foto diterima. Menunggu review manager. Selisih jam akan diperiksa sebelum payroll.' into v_text from stores s where s.id=v_store;
    insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_chat,'text',v_text||case when v_reporter.id<>v_staff.id then E'\nDiwakili oleh '||v_reporter.full_name||'. Bukti dikirim pelapor; menunggu review manager.'else ''end,'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Laporkan ketidaksesuaian','callback_data','sf:r:'||v_session.id))))));
    if v_reporter.id<>v_staff.id and v_staff.telegram_user_id is not null then
      insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_staff.telegram_user_id,'text','Absensi '||case v_attempt.kind when 'check_in'then 'masuk'else 'pulang'end||' dicatat oleh '||v_reporter.full_name||' untukmu, dengan waktu command awal. Bukti dikirim pelapor dan menunggu review manager. Periksa /absensi atau hubungi manager jika tidak sesuai.'));
    end if;
  end if;
end $$;
create or replace function staffing_bot_group_schedule(p_user bigint,p_chat bigint,p_day date default null)returns void language plpgsql set search_path=public as $$
declare g stores;st staffing_staff;day date;today date;body text;line text;row record;buttons jsonb:='[]';i integer;begin
 select s.* into g from stores s join staffing_groups gr on gr.store_id=s.id where gr.chat_id=p_chat and s.active;
 select * into st from staffing_staff where telegram_user_id=p_user and active;
 if g.id is null or st.id is null then return;end if;
 today:=(now()at time zone g.time_zone)::date;day:=coalesce(p_day,today);
 if day<today-7 or day>today+90 then return;end if;
 body:='Jadwal committed · '||g.name||' · '||to_char(day,'DD/MM/YYYY');
 for row in select sh.*,s.full_name,s.code from staffing_shifts sh join staffing_staff s on s.id=sh.staff_id where sh.store_id=g.id and sh.starts_at<((day+1)::timestamp at time zone g.time_zone)and sh.ends_at>(day::timestamp at time zone g.time_zone)order by sh.starts_at,s.full_name loop
  line:=E'\n'||row.full_name||' ['||row.code||'] · '||row.label||' · '||to_char(row.starts_at at time zone g.time_zone,'DD/MM HH24:MI')||' – '||to_char(row.ends_at at time zone g.time_zone,'DD/MM HH24:MI');
  if length(body)+length(line)>3500 then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',p_chat,'text',body));body:='Jadwal committed (lanjutan)';end if;
  body:=body||line;
 end loop;
 if body='Jadwal committed · '||g.name||' · '||to_char(day,'DD/MM/YYYY')then body:=body||E'\nBelum ada shift pada tanggal ini.';end if;
 for i in 0..6 loop buttons:=buttons||jsonb_build_array(jsonb_build_object('text',to_char(today+i,'DD/MM'),'callback_data','sg:'||(today+i)));end loop;
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',p_chat,'text',body,'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(buttons))));
end$$;


create or replace function staffing_apply_update(p_update jsonb) returns void language plpgsql set search_path=public as $$
declare k text:=p_update->>'kind'; uid bigint:=(p_update->>'userId')::bigint; chat bigint:=(p_update->>'chatId')::bigint;
 st staffing_staff; g uuid; swap_deleted boolean; attendance_cancelled boolean;
begin
 if uid is null or uid<=0 or chat is null or (p_update->>'chatType'='private' and uid<>chat) then return; end if;
 perform staffing_lock_group(chat);
 if p_update->>'chatType'in('group','supergroup')and k in('check_in','check_out','proxy_check_in','proxy_check_out','confirm','cancel','location','photo')then
  perform pg_advisory_xact_lock(hashtext('staffing-bot'),hashtext(uid::text));
  perform staffing_attendance_update_v7(p_update);return;
 end if;
 if (p_update->>'chatType'='private' and k in('request_start','request_pick','request_input','document','photo','cancel') and p_update->>'attemptId' is null)
   or (p_update->>'chatType' in('group','supergroup') and (k='swap_start' or (k='cancel' and p_update->>'attemptId' is null))) then
  perform pg_advisory_xact_lock(hashtext('staffing-bot'),hashtext(uid::text));
  insert into staffing_inbox(update_id)values((p_update->>'updateId')::bigint)on conflict do nothing;
  if not found then return; end if;
  if p_update->>'chatType'='private' then perform staffing_private_request(p_update); return; end if;
  select * into st from staffing_staff where telegram_user_id=uid and active;
  select gr.store_id into g from staffing_groups gr join stores s on s.id=gr.store_id where gr.chat_id=chat and s.active;
  if st.id is null or g is null then return; end if;
  if k='swap_start' then
   insert into staffing_swap_flows(user_id,chat_id,step)values(uid,chat,'person')on conflict(user_id,chat_id)do update set step='person',data='{}',page=0,expires_at=now()+interval '10 minutes';
   perform staffing_swap_prompt(uid,chat);
  else
   delete from staffing_swap_flows where user_id=uid and chat_id=chat; swap_deleted:=found;
   update staffing_attempts set state='cancelled' where staff_id=st.id and chat_id=chat and state in('confirmation','location','photo'); attendance_cancelled:=found;
   insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text',case when attendance_cancelled then 'Proses verifikasi absensi dibatalkan. ' else '' end||case when swap_deleted then 'Pemilihan tukar shift dibatalkan. ' else '' end||case when not swap_deleted and not attendance_cancelled then 'Tidak ada proses aktif di chat ini. ' else '' end||'/batal tidak menghapus absensi atau jadwal yang sudah tercatat. Untuk permintaan tukar yang sudah dikirim, gunakan tombol Batalkan permintaan pada pesan permintaan.'));
  end if;
  return;
 end if;
 perform staffing_apply_update_v4(p_update);
end $$;


revoke all on function staffing_payroll_document(uuid,boolean,uuid),staffing_reserve_payroll_delivery(uuid,boolean,uuid,text),staffing_finish_payroll_delivery(uuid,uuid,text,bigint),staffing_guard_payroll_recipient(),staffing_attendance_metadata_v7(uuid),staffing_attendance_metadata(uuid),staffing_attendance_update_v7(jsonb),staffing_review_attendance(uuid,boolean,jsonb)from public,anon,authenticated;
grant execute on function staffing_payroll_document(uuid,boolean,uuid),staffing_reserve_payroll_delivery(uuid,boolean,uuid,text),staffing_finish_payroll_delivery(uuid,uuid,text,bigint),staffing_guard_payroll_recipient(),staffing_attendance_metadata_v7(uuid),staffing_attendance_metadata(uuid),staffing_attendance_update_v7(jsonb),staffing_review_attendance(uuid,boolean,jsonb)to service_role;
commit;
