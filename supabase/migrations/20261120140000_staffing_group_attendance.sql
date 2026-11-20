begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local search_path=public;

-- Correction: new attendance attempts stay in the registered store group.
-- Keep destination binding so an already-started private attempt can finish in
-- its original private chat until expiry. Manager review notifications remain
-- private through the existing staffing_notify_personal_result trigger.
create or replace function public.staffing_attendance_update_v13(p_update jsonb)
returns void language plpgsql set search_path = public as $$
declare
  v_user bigint := (p_update->>'userId')::bigint;
  v_chat bigint := (p_update->>'chatId')::bigint;
  v_kind text := p_update->>'kind';
  v_response_chat bigint := (p_update->>'chatId')::bigint;
  v_private boolean := p_update->>'chatType'='private';
  v_reporter staffing_staff; v_flow_deleted boolean:=false; v_subject uuid; v_staff staffing_staff; v_attempt staffing_attempts; v_shift staffing_shifts;
  v_session staffing_sessions; v_link staffing_link_tokens;
  v_store uuid; v_count integer; v_id uuid; v_text text; v_payload jsonb;
  v_effective timestamptz := coalesce((p_update->>'sentAt')::timestamptz,now());
begin
  insert into staffing_inbox(update_id) values((p_update->>'updateId')::bigint) on conflict do nothing;
  if not found then return; end if;
  if v_effective > now()+interval '1 minute' or v_effective < now()-interval '24 hours' then return; end if;
  if v_private then
    if v_kind not in('confirm','cancel','location','photo')then return;end if;
    select a.chat_id into v_chat from staffing_attempts a join staffing_staff r on r.id=coalesce(a.submitted_by_staff_id,a.staff_id)
    where r.telegram_user_id=v_user and r.active and a.verification_chat_id=(p_update->>'chatId')::bigint and a.state in('confirmation','location','photo')
     and(case when v_kind in('confirm','cancel')then a.id=(p_update->>'attemptId')::uuid else a.prompt_message_id=(p_update->>'replyTo')::bigint end)order by a.received_at desc limit 1;
    if v_chat is null then return;end if;perform staffing_lock_group(v_chat);v_private:=false;
  end if;

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
      insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_response_chat,'text','Hanya staf store ini / staf yang sedang ditugaskan di sini dapat mewakili absen.'));return;
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
      insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_response_chat,'text','Akun belum ditautkan atau staf tidak aktif. Hubungi manager.'));
    end if; return;
  end if;
  if v_kind in ('check_in','check_out') then
    if exists(select 1 from staffing_attempts where staff_id=v_staff.id and state in('confirmation','location','photo')and expires_at>now()and coalesce(submitted_by_staff_id,staff_id)<>v_reporter.id)then
      insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_response_chat,'text','Absensi staf ini sedang diverifikasi oleh pelapor lain. Selesaikan atau batalkan proses tersebut dahulu.'));return;
    end if;
    if v_kind='check_in' then
      if exists(select 1 from staffing_sessions where staff_id=v_staff.id and coalesce(corrected_out_at,check_out_at) is null) then
        insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_response_chat,'text','Masih ada sesi kerja terbuka. Gunakan /pulang atau hubungi manager.')); return;
      end if;
      select count(*) into v_count from staffing_shifts sh where staff_id=v_staff.id and store_id=v_store and starts_at<=v_effective+interval '2 hours' and ends_at>=v_effective and not exists(select 1 from staffing_sessions where shift_id=sh.id);
      if v_count<>1 then
        insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_response_chat,'text','Tidak ditemukan satu shift yang sesuai di store ini. Hubungi manager untuk memeriksa jadwal.')); return;
      end if;
      select * into v_shift from staffing_shifts sh where staff_id=v_staff.id and store_id=v_store and starts_at<=v_effective+interval '2 hours' and ends_at>=v_effective and not exists(select 1 from staffing_sessions where shift_id=sh.id);
    else
      select se.* into v_session from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id where se.staff_id=v_staff.id and sh.store_id=v_store and coalesce(se.corrected_out_at,se.check_out_at) is null;
      if v_session.id is null then
        insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_response_chat,'text','Tidak ada sesi terbuka di store ini. Hubungi manager jika ada absensi yang perlu dikoreksi.')); return;
      end if;
      select * into v_shift from staffing_shifts where id=v_session.shift_id;
    end if;
    if v_kind='check_in'and exists(select 1 from staffing_requests r cross join lateral jsonb_array_elements(r.leave_dates)d join stores so on so.id=v_store where r.staff_id=v_staff.id and r.status='approved'and r.kind<>'cash_advance'and v_shift.starts_at<(((d->>'date')::date+1)::timestamp at time zone so.time_zone)and v_shift.ends_at>((d->>'date')::date::timestamp at time zone so.time_zone))then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_response_chat,'text','Shift ini memiliki izin yang disetujui. Hubungi manager untuk koreksi.'));return;end if;
    update staffing_attempts set state='cancelled' where coalesce(submitted_by_staff_id,staff_id)=v_reporter.id and chat_id=v_chat and state in ('confirmation','location','photo');
    if v_effective < now()-interval '10 minutes' then
      insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_response_chat,'text','Command sudah kedaluwarsa. Ulangi absensi atau hubungi manager untuk koreksi.'));return;
    end if;
    insert into staffing_attempts(staff_id,submitted_by_staff_id,shift_id,chat_id,kind,state,requested_at,request_message_id,expires_at,verification_chat_id) values(v_staff.id,v_reporter.id,v_shift.id,v_chat,v_kind,'confirmation',v_effective,(p_update->>'messageId')::bigint,v_effective+interval '10 minutes',v_chat) returning * into v_attempt;
    select 'Konfirmasi '||case when v_kind='check_in'then 'masuk'else 'pulang'end||': '||v_staff.full_name||' '||staffing_short_range(v_shift.starts_at,v_shift.ends_at,s.time_zone)||E'\n\nLanjutkan dengan lokasi dan foto.'into v_text from stores s where s.id=v_store;
    v_payload := jsonb_build_object('chat_id',v_response_chat,'text',v_text||case when v_reporter.id<>v_staff.id then E'\nDiwakili oleh '||v_reporter.full_name||'. Bukti dikirim pelapor; menunggu review manager.'else ''end,'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Benar, lanjutkan','callback_data','sf:c:'||v_attempt.id),jsonb_build_object('text','Batal','callback_data','sf:x:'||v_attempt.id)))));
    insert into staffing_outbox(payload,attempt_id,expected_state) values(v_payload,v_attempt.id,'confirmation'); return;
  end if;
  if v_kind in ('confirm','cancel') then
    select * into v_attempt from staffing_attempts where coalesce(submitted_by_staff_id,staff_id)=v_reporter.id and chat_id=v_chat and (id=(p_update->>'attemptId')::uuid or (p_update->>'attemptId' is null and state in ('confirmation','location','photo'))) order by received_at desc limit 1 for update;
  else
    select * into v_attempt from staffing_attempts where coalesce(submitted_by_staff_id,staff_id)=v_reporter.id and chat_id=v_chat and prompt_message_id=(p_update->>'replyTo')::bigint and state in ('location','photo') order by received_at desc limit 1 for update;
  end if;
  if v_attempt.id is null or v_attempt.state in ('completed','cancelled')then
    if v_kind='cancel'then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_response_chat,'text',case when v_flow_deleted then 'Pemilihan tukar shift dibatalkan. 'else 'Tidak ada verifikasi absensi aktif milikmu di chat ini. 'end||'Absensi / jadwal yang sudah tercatat tidak dihapus. Batalkan permintaan tukar terkirim lewat tombol pada permintaannya.'));end if;
    return;
  end if;
  if coalesce(v_attempt.verification_chat_id,v_chat)is distinct from v_response_chat then return;end if;
  if v_kind='cancel' then
    update staffing_attempts set state='cancelled' where id=v_attempt.id;
    insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_response_chat,'text','Proses absensi dibatalkan.')); return;
  end if;
  if v_attempt.expires_at<=now() or v_effective>v_attempt.expires_at then
    update staffing_attempts set state='cancelled' where id=v_attempt.id;
    insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_response_chat,'text','Verifikasi kedaluwarsa. Mulai kembali dengan /masuk atau /pulang.')); return;
  end if;
  if v_effective < v_attempt.requested_at then return; end if;
  if v_kind='confirm' and v_attempt.state='confirmation' then
    update staffing_attempts set state='location',prompt_message_id=null where id=v_attempt.id;
    v_text := 'Balas pesan ini dengan lokasi melalui Attachment > Location. Kedaluwarsa dalam '||greatest(1,ceil(extract(epoch from(v_attempt.expires_at-now()))/60))||' menit.';
    insert into staffing_outbox(payload,attempt_id,expected_state) values(jsonb_build_object('chat_id',coalesce(v_attempt.verification_chat_id,v_chat),'text',v_text,'reply_markup',jsonb_build_object('force_reply',true,'selective',true))||case when coalesce(v_attempt.verification_chat_id,v_chat)<0 then jsonb_build_object('reply_parameters',jsonb_build_object('message_id',v_attempt.request_message_id))else '{}'::jsonb end,v_attempt.id,'location'); return;
  end if;
  if v_kind='location' and v_attempt.state='location' then
    update staffing_attempts set state='photo',prompt_message_id=null,latitude=(p_update->>'latitude')::numeric,longitude=(p_update->>'longitude')::numeric,location_sent_at=v_effective where id=v_attempt.id;
    insert into staffing_outbox(payload,attempt_id,expected_state) values(jsonb_build_object('chat_id',coalesce(v_attempt.verification_chat_id,v_chat),'text','Balas pesan ini dengan foto kehadiran di Sarkop. Kedaluwarsa dalam '||greatest(1,ceil(extract(epoch from(v_attempt.expires_at-now()))/60))||' menit.','reply_markup',jsonb_build_object('force_reply',true,'selective',true))||case when coalesce(v_attempt.verification_chat_id,v_chat)<0 then jsonb_build_object('reply_parameters',jsonb_build_object('message_id',v_attempt.request_message_id))else '{}'::jsonb end,v_attempt.id,'photo'); return;
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
    select v_staff.full_name||' waktu '||case when v_attempt.kind='check_in'then 'masuk'else 'pulang'end||' tercatat '||to_char(v_effective at time zone s.time_zone,'DD/MM HH24:MI:SS')||'. Lokasi dan foto diterima.'into v_text from stores s where s.id=v_store;
    insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_chat,'text',v_text||case when v_reporter.id<>v_staff.id then E'\nDiwakili oleh '||v_reporter.full_name||'.'else ''end,'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Laporkan ketidaksesuaian','callback_data','sf:r:'||v_session.id))))));
    if v_reporter.id<>v_staff.id and v_staff.telegram_user_id is not null then
      insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_staff.telegram_user_id,'text','Absensi '||case v_attempt.kind when 'check_in'then 'masuk'else 'pulang'end||' dicatat oleh '||v_reporter.full_name||' untukmu, dengan waktu command awal. Bukti dikirim pelapor dan menunggu review manager. Periksa /absensi atau hubungi manager jika tidak sesuai.'));
    end if;
  end if;
end $$;

create or replace function staffing_apply_update(p_update jsonb)returns void language plpgsql set search_path=public as $$
declare k text:=p_update->>'kind';uid bigint:=(p_update->>'userId')::bigint;chat bigint:=(p_update->>'chatId')::bigint;f staffing_swap_flows;aid uuid;begin
 if uid is null or uid<=0 or chat is null or(p_update->>'chatType'='private'and uid<>chat)then return;end if;
 perform staffing_lock_group(chat);perform pg_advisory_xact_lock(hashtext('staffing-bot'),hashtext(uid::text));
 if k='cancel'and p_update->>'chatType'='private'and p_update->>'attemptId'is null then select a.id into aid from staffing_attempts a join staffing_staff st on st.id=coalesce(a.submitted_by_staff_id,a.staff_id)where st.telegram_user_id=uid and a.verification_chat_id=chat and a.state in('confirmation','location','photo')order by a.received_at desc limit 1;if aid is not null then p_update:=p_update||jsonb_build_object('attemptId',aid);end if;end if;
 if(p_update->>'chatType'in('group','supergroup')and k in('check_in','check_out','proxy_check_in','proxy_check_out','confirm','cancel','location','photo'))or(p_update->>'chatType'='private'and k in('confirm','cancel','location','photo')and(k='confirm'or p_update->>'attemptId'is not null or exists(select 1 from staffing_attempts a join staffing_staff st on st.id=coalesce(a.submitted_by_staff_id,a.staff_id)where st.telegram_user_id=uid and a.verification_chat_id=chat and a.prompt_message_id=(p_update->>'replyTo')::bigint and a.state in('location','photo'))))then perform staffing_attendance_update_v13(p_update);return;end if;
 if k in('check_in','check_out','proxy_check_in','proxy_check_out')then return;end if;
 if k in('report','start')then perform staffing_attendance_update_v3(p_update);return;end if;
 insert into staffing_inbox(update_id)values((p_update->>'updateId')::bigint)on conflict do nothing;if not found then return;end if;
 if coalesce((p_update->>'sentAt')::timestamptz,now())<now()-interval '24 hours'or coalesce((p_update->>'sentAt')::timestamptz,now())>now()+interval '1 minute'then return;end if;
 if p_update->>'chatType'='private'then
  if k in('request_start','request_pick','request_input','document','photo','cancel')then perform staffing_private_request(p_update);
  elsif k in('swap_start','swap_pick','swap_accept','swap_reject','swap_cancel')then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Gunakan /tukar di grup Sarkop.'));
  else perform staffing_bot_private(uid,chat,k);end if;return;
 end if;
 if not exists(select 1 from staffing_groups g join stores s on s.id=g.store_id where g.chat_id=chat and s.active)or not exists(select 1 from staffing_staff where telegram_user_id=uid and active)then return;end if;
 case k
 when 'swap_start'then insert into staffing_swap_flows(user_id,chat_id,step)values(uid,chat,'person')on conflict(user_id,chat_id)do update set step='person',data='{}',page=0,expires_at=now()+interval '10 minutes';perform staffing_swap_prompt(uid,chat);
 when 'swap_pick'then perform staffing_swap_pick(p_update);
 when 'swap_accept','swap_reject','swap_cancel'then perform staffing_swap_peer(p_update);
 when 'schedule'then perform staffing_bot_group_schedule(uid,chat,nullif(p_update->>'scheduleDate','')::date);
 when 'help'then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Grup: /masuk, /pulang, /jadwal, /tukar, /batal, /bantuan. Konfirmasi shift, lokasi, dan foto dikirim di grup ini. Hasil review manager dikirim ke chat pribadi.'));
 else return;end case;
end $$;

revoke all on function public.staffing_attendance_update_v13(jsonb),public.staffing_apply_update(jsonb)from public,anon,authenticated;
grant execute on function public.staffing_attendance_update_v13(jsonb),public.staffing_apply_update(jsonb)to service_role;
commit;
