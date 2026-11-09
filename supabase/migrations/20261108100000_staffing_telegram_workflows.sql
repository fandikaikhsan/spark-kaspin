begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local search_path = public;
alter table staffing_attempts add column photo_message_id bigint;
alter table staffing_attempts add column photo_sent_at timestamptz;
alter table staffing_events drop constraint staffing_events_timestamp_source_check;
alter table staffing_events add constraint staffing_events_timestamp_source_check check(timestamp_source in('telegram_message','server_received','telegram_command'));
create function public.staffing_attendance_update_v3(p_update jsonb)
returns void language plpgsql set search_path = public as $$
declare
  v_user bigint := (p_update->>'userId')::bigint;
  v_chat bigint := (p_update->>'chatId')::bigint;
  v_kind text := p_update->>'kind';
  v_private boolean := p_update->>'chatType'='private';
  v_staff staffing_staff; v_attempt staffing_attempts; v_shift staffing_shifts;
  v_session staffing_sessions; v_link staffing_link_tokens;
  v_store uuid; v_count integer; v_id uuid; v_text text; v_payload jsonb;
  v_effective timestamptz := coalesce((p_update->>'sentAt')::timestamptz,now());
begin
  insert into staffing_inbox(update_id) values((p_update->>'updateId')::bigint) on conflict do nothing;
  if not found then return; end if;
  if v_effective > now()+interval '1 minute' or v_effective < now()-interval '24 hours' then return; end if;
  if v_kind='start' then
    if not v_private then return; end if;
    if p_update->>'tokenHash' is not null then
      select * into v_link from staffing_link_tokens where token_hash=p_update->>'tokenHash' and used_at is null and expires_at>now() for update;
      if v_link.staff_id is not null then
        select * into v_staff from staffing_staff where id=v_link.staff_id for update;
        if v_staff.active and (v_staff.telegram_user_id is null or v_staff.telegram_user_id=v_user) and not exists(select 1 from staffing_staff where telegram_user_id=v_user and id<>v_staff.id) then
          update staffing_staff set telegram_user_id=v_user where id=v_staff.id;
          update staffing_link_tokens set used_at=now() where token_hash=v_link.token_hash;
          insert into staffing_audit(actor,action,entity_id,details) values('telegram:'||v_user,'telegram_link',v_staff.id::text,'{}');
          v_text := 'Akun berhasil ditautkan. Gunakan /masuk, /pulang dan /tukar di grup store. Menu pribadi: /menu.';
        else v_text := 'Akun tidak dapat ditautkan. Hubungi manager untuk pemeriksaan identitas.'; end if;
      else v_text := 'Undangan tidak berlaku atau sudah digunakan. Minta undangan baru dari manager.'; end if;
    else v_text := 'Spark Staffing: tautkan akun melalui undangan manager. Absensi /masuk dan /pulang dilakukan di grup store. Informasi pribadi: /menu atau /jadwal.'; end if;
    insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_chat,'text',v_text)); return;
  end if;
  if not v_private then
    select g.store_id into v_store from staffing_groups g join stores s on s.id=g.store_id where g.chat_id=v_chat and s.active;
    if v_store is null then return; end if;
  end if;
  select * into v_staff from staffing_staff where telegram_user_id=v_user and active for update;
  if v_staff.id is null then
    if v_kind in ('check_in','check_out','schedule') then
      insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_chat,'text','Akun belum ditautkan atau staf tidak aktif. Hubungi manager.'));
    end if; return;
  end if;
  if v_kind='schedule' then
    if v_private then
      select string_agg(q.line,E'\n') into v_text from (select sh.label||' · '||s.name||' · '||to_char(sh.starts_at at time zone s.time_zone,'DD Mon HH24:MI')||'–'||to_char(sh.ends_at at time zone s.time_zone,'DD Mon HH24:MI')||' ('||s.time_zone||')' as line from staffing_shifts sh join stores s on s.id=sh.store_id where sh.staff_id=v_staff.id and sh.ends_at>=now() order by sh.starts_at limit 10) q;
      v_text := coalesce(v_text,'Belum ada jadwal mendatang.');
    else v_text := 'Untuk melihat jadwal pribadi, kirim /jadwal melalui chat pribadi bot.'; end if;
    insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_chat,'text',v_text)); return;
  end if;
  if v_private then return; end if;
  if v_kind='report' then
    select se.* into v_session from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id where se.id=(p_update->>'attemptId')::uuid and sh.store_id=v_store;
    if v_session.id is not null and exists(select 1 from staffing_staff st where st.id=v_staff.id and st.home_store_id=v_store union all select 1 from staffing_shifts where staff_id=v_staff.id and store_id=v_store and ends_at>=now()-interval '1 day' and starts_at<=now()+interval '1 day') then
      insert into staffing_reports(session_id,reporter_staff_id) values(v_session.id,v_staff.id) on conflict do nothing;
    end if; return;
  end if;
  if v_kind in ('check_in','check_out') then
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
    update staffing_attempts set state='cancelled' where staff_id=v_staff.id and state in ('confirmation','location','photo');
    if v_effective < now()-interval '10 minutes' then
      insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_chat,'text','Command sudah kedaluwarsa. Ulangi absensi atau hubungi manager untuk koreksi.'));return;
    end if;
    insert into staffing_attempts(staff_id,shift_id,chat_id,kind,state,requested_at,request_message_id,expires_at) values(v_staff.id,v_shift.id,v_chat,v_kind,'confirmation',v_effective,(p_update->>'messageId')::bigint,v_effective+interval '10 minutes') returning * into v_attempt;
    select v_staff.full_name||' · '||s.name||E'\n'||v_shift.label||' · '||to_char(v_shift.starts_at at time zone s.time_zone,'DD Mon HH24:MI')||'–'||to_char(v_shift.ends_at at time zone s.time_zone,'DD Mon HH24:MI')||E'\nKonfirmasi '||case when v_kind='check_in' then 'check-in' else 'checkout' end||'. Lanjutkan dengan lokasi dan foto; jam command awal menjadi waktu absen jika lokasi dan foto lengkap dalam 10 menit.' into v_text from stores s where s.id=v_store;
    v_payload := jsonb_build_object('chat_id',v_chat,'text',v_text,'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Benar, lanjutkan','callback_data','sf:c:'||v_attempt.id),jsonb_build_object('text','Batal','callback_data','sf:x:'||v_attempt.id)))));
    insert into staffing_outbox(payload,attempt_id,expected_state) values(v_payload,v_attempt.id,'confirmation'); return;
  end if;
  if v_kind in ('confirm','cancel') then
    select * into v_attempt from staffing_attempts where staff_id=v_staff.id and chat_id=v_chat and (id=(p_update->>'attemptId')::uuid or (p_update->>'attemptId' is null and state in ('confirmation','location','photo'))) order by received_at desc limit 1 for update;
  else
    select * into v_attempt from staffing_attempts where staff_id=v_staff.id and chat_id=v_chat and prompt_message_id=(p_update->>'replyTo')::bigint and state in ('location','photo') order by received_at desc limit 1 for update;
  end if;
  if v_attempt.id is null or v_attempt.state in ('completed','cancelled') then return; end if;
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
      insert into staffing_sessions(shift_id,staff_id,check_in_at) values(v_shift.id,v_staff.id,v_effective) returning * into v_session;
    else
      select * into v_session from staffing_sessions where shift_id=v_shift.id and coalesce(corrected_out_at,check_out_at) is null for update;
      if v_session.id is null or v_effective<coalesce(v_session.corrected_in_at,v_session.check_in_at) then return; end if;
      update staffing_sessions set check_out_at=v_effective,verification_state='pending',review_note=null,reviewed_at=null,reviewed_by=null,overtime_from_attendance=false where id=v_session.id;
    end if;
    update staffing_attempts set state='completed',photo_file_id=p_update->>'fileId',photo_unique_id=p_update->>'fileUniqueId',photo_message_id=(p_update->>'messageId')::bigint,photo_sent_at=(p_update->>'sentAt')::timestamptz,completed_at=now() where id=v_attempt.id;
    insert into staffing_events(session_id,attempt_id,kind,effective_at,timestamp_source,message_id,update_id) values(v_session.id,v_attempt.id,v_attempt.kind,v_effective,'telegram_command',v_attempt.request_message_id,(p_update->>'updateId')::bigint);
    insert into staffing_audit(actor,action,entity_id,details) values('telegram:'||v_user,v_attempt.kind,v_session.id::text,jsonb_build_object('attempt_id',v_attempt.id));
    select v_staff.full_name||' · '||s.name||E'\n'||case when v_attempt.kind='check_in' then 'Check-in' else 'Checkout' end||' tercatat: '||to_char(v_effective at time zone s.time_zone,'DD Mon HH24:MI:SS')||' ('||s.time_zone||')'||E'\n'||v_shift.label||case when v_attempt.kind='check_in' then ' · Terlambat '||greatest(0,ceil(extract(epoch from(v_effective-v_shift.starts_at))/60))::text||' menit' else '' end||E'\nLokasi dan foto diterima. Menunggu review manager. Selisih jam akan diperiksa sebelum payroll.' into v_text from stores s where s.id=v_store;
    insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_chat,'text',v_text,'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Laporkan ketidaksesuaian','callback_data','sf:r:'||v_session.id))))));
  end if;
end $$;


create table staffing_shift_requests(
 id uuid primary key default gen_random_uuid(),requester_id uuid not null references staffing_staff(id),target_staff_id uuid not null references staffing_staff(id),
 requester_telegram_id bigint not null,target_telegram_id bigint not null,
 shift_id uuid references staffing_shifts(id)on delete set null,other_shift_id uuid references staffing_shifts(id)on delete set null,
 store_id uuid not null references stores(id),chat_id bigint not null,mode text not null check(mode in('replace','swap')),
 status text not null default 'pending_peer' check(status in('pending_peer','pending_manager','approved','rejected','cancelled','expired','stale')),
 shift_snapshot jsonb not null,other_snapshot jsonb,created_at timestamptz not null default now(),expires_at timestamptz not null,
 peer_decided_at timestamptz,decided_at timestamptz,decided_by text,decision_note text,
 check(requester_id<>target_staff_id),check((mode='replace'and other_snapshot is null)or(mode='swap'and other_snapshot is not null))
);
create index on staffing_shift_requests(store_id,status,created_at);
create unique index staffing_one_shift_request on staffing_shift_requests(shift_id)where status in('pending_peer','pending_manager');
create table staffing_swap_flows(
 user_id bigint not null,chat_id bigint not null,token text not null default substr(replace(gen_random_uuid()::text,'-',''),1,12),
 step text not null check(step in('mode','shift','person','other')),data jsonb not null default '{}',page integer not null default 0 check(page>=0),
 expires_at timestamptz not null default now()+interval '10 minutes',primary key(user_id,chat_id)
);
alter table staffing_shift_requests enable row level security;
alter table staffing_swap_flows enable row level security;
revoke all on staffing_shift_requests,staffing_swap_flows from public,anon,authenticated;
grant all on staffing_shift_requests,staffing_swap_flows to service_role;

create function staffing_shift_request_text(p_request uuid)returns text language sql stable set search_path=public as $$
 select case r.mode when 'swap'then 'Pertukaran dua shift'else 'Permintaan penggantian shift'end||E'\n'||a.full_name||' → '||b.full_name||E'\n'||s.name||' · '||to_char((r.shift_snapshot->>'starts_at')::timestamptz at time zone s.time_zone,'DD/MM/YYYY HH24:MI')||' – '||to_char((r.shift_snapshot->>'ends_at')::timestamptz at time zone s.time_zone,'DD/MM/YYYY HH24:MI')||
 case when r.mode='swap'then E'\nShift balasan: '||b.full_name||' → '||a.full_name||' · '||to_char((r.other_snapshot->>'starts_at')::timestamptz at time zone s.time_zone,'DD/MM/YYYY HH24:MI')||' – '||to_char((r.other_snapshot->>'ends_at')::timestamptz at time zone s.time_zone,'DD/MM/YYYY HH24:MI')else ''end
 from staffing_shift_requests r join staffing_staff a on a.id=r.requester_id join staffing_staff b on b.id=r.target_staff_id join stores s on s.id=r.store_id where r.id=p_request;
$$;

-- Snapshot comparison protects both peer consent and final manager approval.
create function staffing_shift_request_valid(p_request uuid)returns boolean language sql stable set search_path=public as $$
 select coalesce(r.expires_at>now()and s.active and a.active and b.active and a.telegram_user_id=r.requester_telegram_id and b.telegram_user_id=r.target_telegram_id and
 sh.staff_id=r.requester_id and sh.store_id=r.store_id and sh.starts_at>now()and to_jsonb(sh)=r.shift_snapshot and
 not exists(select 1 from staffing_attempts where shift_id=sh.id)and not exists(select 1 from staffing_sessions where shift_id=sh.id)and
 (r.mode='replace'or(other.id is not null and other.id<>sh.id and other.staff_id=r.target_staff_id and other.store_id=r.store_id and other.starts_at>now()and to_jsonb(other)=r.other_snapshot and not exists(select 1 from staffing_attempts where shift_id=other.id)and not exists(select 1 from staffing_sessions where shift_id=other.id))),false)
 from staffing_shift_requests r join staffing_staff a on a.id=r.requester_id join staffing_staff b on b.id=r.target_staff_id join stores s on s.id=r.store_id left join staffing_shifts sh on sh.id=r.shift_id left join staffing_shifts other on other.id=r.other_shift_id where r.id=p_request;
$$;

create function staffing_shift_request_notify(p_request uuid,p_text text)returns void language plpgsql set search_path=public as $$declare r staffing_shift_requests;u bigint;begin
 select * into r from staffing_shift_requests where id=p_request;
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',r.chat_id,'text',staffing_shift_request_text(r.id)||E'\n'||p_text));
 for u in select telegram_user_id from staffing_staff where id in(r.requester_id,r.target_staff_id)and telegram_user_id is not null loop
  insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',u,'text',staffing_shift_request_text(r.id)||E'\n'||p_text));
 end loop;
end$$;

create function staffing_shift_queue(p_actor uuid,p_bootstrap boolean,p_store uuid default null)returns jsonb language plpgsql stable set search_path=public as $$declare scope uuid[];begin
 scope:=staffing_actor_stores(p_actor,p_bootstrap);if p_store is not null and not p_store=any(scope)then raise exception 'FORBIDDEN';end if;
 return coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('requester_name',a.full_name,'target_name',b.full_name,'store_name',s.name,'time_zone',s.time_zone,'valid',staffing_shift_request_valid(r.id))order by r.created_at)
 from staffing_shift_requests r join staffing_staff a on a.id=r.requester_id join staffing_staff b on b.id=r.target_staff_id join stores s on s.id=r.store_id
 where r.store_id=any(scope)and a.home_store_id=any(scope)and b.home_store_id=any(scope)and(p_store is null or r.store_id=p_store)and r.status='pending_manager'and r.expires_at>now()),'[]');
end$$;

create function staffing_decide_shift(p_actor uuid,p_bootstrap boolean,p_request uuid,p_decision text,p_note text)returns jsonb language plpgsql set search_path=public as $$
declare r staffing_shift_requests;scope uuid[];v_before jsonb;v_state text;begin
 scope:=staffing_actor_stores(p_actor,p_bootstrap);
 select * into r from staffing_shift_requests where id=p_request;
 if r.id is null or not r.store_id=any(scope)or exists(select 1 from staffing_staff where id in(r.requester_id,r.target_staff_id)and not home_store_id=any(scope))then raise exception 'FORBIDDEN';end if;
 -- Same stable ordering as the timetable commit and attendance staff locks.
 perform id from staffing_staff where id in(r.requester_id,r.target_staff_id)order by id for update;
 select * into r from staffing_shift_requests where id=p_request for update;
 if p_decision is null or p_decision not in('approved','rejected')or p_note is null or length(trim(p_note))not between 5 and 1000 then raise exception 'Pilih keputusan dan isi catatan minimal 5 karakter';end if;
 if r.status=p_decision then return jsonb_build_object('id',r.id,'status',r.status);end if;
 if r.status<>'pending_manager'then raise exception 'Permintaan sudah selesai atau belum disetujui pihak kedua';end if;
 if p_decision='approved'then
  perform id from staffing_shifts where id in(r.shift_id,r.other_shift_id)order by id for update;
  if not staffing_shift_request_valid(r.id)then
   update staffing_shift_requests set status=case when expires_at<=now()then 'expired'else 'stale'end,decided_at=now(),decided_by=coalesce(p_actor::text,'bootstrap-super-admin'),decision_note='Jadwal berubah atau terkunci; buat permintaan baru'where id=r.id;
   perform staffing_shift_request_notify(r.id,'Permintaan tidak berlaku. Jadwal berubah, kedaluwarsa, atau sudah memiliki proses absensi. Buat permintaan baru.');
   return jsonb_build_object('id',r.id,'status','stale');
  end if;
  select jsonb_agg(to_jsonb(sh)order by sh.id)into v_before from staffing_shifts sh where id in(r.shift_id,r.other_shift_id);
  update staffing_shifts set staff_id=r.target_staff_id where id=r.shift_id;
  if r.mode='swap'then update staffing_shifts set staff_id=r.requester_id where id=r.other_shift_id;end if;
  if exists(select 1 from staffing_shifts sh join stores so on so.id=sh.store_id join staffing_requests req on req.staff_id=sh.staff_id cross join lateral jsonb_array_elements(req.leave_dates)d
   where sh.id in(r.shift_id,r.other_shift_id)and req.status='approved'and req.kind<>'cash_advance'and sh.starts_at<(((d->>'date')::date+1)::timestamp at time zone so.time_zone)and sh.ends_at>((d->>'date')::date::timestamp at time zone so.time_zone))then raise exception 'Staff memiliki izin disetujui pada hari penugasan';end if;
  if exists(select 1 from staffing_shifts a join staffing_shifts b on a.staff_id=b.staff_id and a.id<>b.id and a.starts_at<b.ends_at and a.ends_at>b.starts_at where a.id in(r.shift_id,r.other_shift_id))then raise exception 'Jadwal bertabrakan dengan penugasan lain';end if;
 end if;
 update staffing_shift_requests set status=p_decision,decided_at=now(),decided_by=coalesce(p_actor::text,'bootstrap-super-admin'),decision_note=trim(p_note)where id=r.id;
 insert into staffing_audit(actor,action,entity_id,details)values(coalesce(p_actor::text,'bootstrap-super-admin'),'decide_shift_request',r.id::text,jsonb_build_object('decision',p_decision,'note',trim(p_note),'before',v_before,'after',(select jsonb_agg(to_jsonb(sh)order by sh.id)from staffing_shifts sh where id in(r.shift_id,r.other_shift_id))));
 perform staffing_shift_request_notify(r.id,case p_decision when 'approved'then 'Disetujui manager. Jadwal sudah diperbarui.'else 'Ditolak manager. Jadwal tetap.'end);
 return jsonb_build_object('id',r.id,'status',p_decision);
end$$;

create function staffing_swap_prompt(p_user bigint,p_chat bigint)returns void language plpgsql set search_path=public as $$
declare f staffing_swap_flows;st staffing_staff;g uuid;items jsonb;buttons jsonb:='[]';row jsonb;total integer;title text;nav jsonb:='[]';begin
 select * into f from staffing_swap_flows where user_id=p_user and chat_id=p_chat;
 select * into st from staffing_staff where telegram_user_id=p_user and active;
 select store_id into g from staffing_groups where chat_id=p_chat;
 if f.user_id is null or st.id is null or g is null or f.expires_at<=now()then return;end if;
 update staffing_swap_flows set token=substr(replace(gen_random_uuid()::text,'-',''),1,12)where user_id=p_user and chat_id=p_chat returning * into f;
 if f.step='mode'then
  items:='[{"id":"replace","label":"Minta pengganti"},{"id":"swap","label":"Tukar dua shift"}]';title:='Pilih jenis perubahan jadwal. Jadwal baru berlaku setelah pihak kedua dan manager menyetujui.';
 elsif f.step='shift'then
  select coalesce(jsonb_agg(to_jsonb(q)order by q.starts_at),'[]')into items from(select sh.id,sh.starts_at,sh.label||' · '||to_char(sh.starts_at at time zone so.time_zone,'DD/MM HH24:MI')||'–'||to_char(sh.ends_at at time zone so.time_zone,'HH24:MI')as label
   from staffing_shifts sh join stores so on so.id=sh.store_id where sh.staff_id=st.id and sh.store_id=g and sh.starts_at>now()and sh.starts_at<now()+interval '90 days'and not exists(select 1 from staffing_attempts where shift_id=sh.id)and not exists(select 1 from staffing_sessions where shift_id=sh.id)and not exists(select 1 from staffing_shift_requests r where r.shift_id=sh.id and r.status in('pending_peer','pending_manager')and r.expires_at>now()and staffing_shift_request_valid(r.id))order by sh.starts_at offset f.page*8 limit 9)q;
  title:='Pilih shift milikmu yang ingin diganti / ditukar (maksimal 90 hari ke depan).';
 elsif f.step='person'then
  select coalesce(jsonb_agg(to_jsonb(q)order by q.label,q.id),'[]')into items from(select s.id,s.full_name as label from staffing_staff s
   join staffing_store_regions sr on sr.store_id=s.home_store_id join staffing_store_regions dest on dest.store_id=g and dest.region_id=sr.region_id
   where s.active and s.telegram_user_id is not null and s.id<>st.id order by s.full_name,s.id offset f.page*8 limit 9)q;
  title:='Pilih pihak kedua. Daftar menampilkan staff aktif yang sudah menautkan Telegram di region store ini.';
 else
  select coalesce(jsonb_agg(to_jsonb(q)order by q.starts_at),'[]')into items from(select sh.id,sh.starts_at,sh.label||' · '||to_char(sh.starts_at at time zone so.time_zone,'DD/MM HH24:MI')||'–'||to_char(sh.ends_at at time zone so.time_zone,'HH24:MI')as label
   from staffing_shifts sh join stores so on so.id=sh.store_id where sh.staff_id=(f.data->>'target')::uuid and sh.store_id=g and sh.starts_at>now()and sh.starts_at<now()+interval '90 days'and not exists(select 1 from staffing_attempts where shift_id=sh.id)and not exists(select 1 from staffing_sessions where shift_id=sh.id)order by sh.starts_at offset f.page*8 limit 9)q;
  title:='Pilih shift pihak kedua yang akan menjadi shift balasan untukmu.';
 end if;
 total:=jsonb_array_length(items);
 items:=coalesce((select jsonb_agg(value order by ordinality)from jsonb_array_elements(items)with ordinality where ordinality<=8),'[]');
 update staffing_swap_flows set data=data||jsonb_build_object('options',items,'more',total>8)where user_id=p_user and chat_id=p_chat;
 for row in select * from jsonb_array_elements(items)loop
  buttons:=buttons||jsonb_build_array(jsonb_build_array(jsonb_build_object('text',row->>'label','callback_data','sx:'||f.step||':'||f.token||':'||(row->>'id'))));
 end loop;
 if f.page>0 then nav:=nav||jsonb_build_array(jsonb_build_object('text','← Sebelumnya','callback_data','sx:page:'||f.token||':prev'));end if;
 if total>8 then nav:=nav||jsonb_build_array(jsonb_build_object('text','Berikutnya →','callback_data','sx:page:'||f.token||':next'));end if;
 if jsonb_array_length(nav)>0 then buttons:=buttons||jsonb_build_array(nav);end if;
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',p_chat,'text',st.full_name||E'\n'||title||case when total=0 then E'\nTidak ada pilihan yang tersedia. Periksa jadwal / akun tertaut, atau hubungi manager.'else E'\nHanya pengaju yang dapat memilih. /batal untuk membatalkan proses.'end,'reply_markup',jsonb_build_object('inline_keyboard',buttons)));
end$$;

create function staffing_swap_pick(p_update jsonb)returns void language plpgsql set search_path=public as $$
declare f staffing_swap_flows;st staffing_staff;target staffing_staff;sh staffing_shifts;other staffing_shifts;r staffing_shift_requests;g uuid;v_user bigint:=(p_update->>'userId')::bigint;v_chat bigint:=(p_update->>'chatId')::bigint;v_entity text:=p_update->>'entityId';begin
 select * into f from staffing_swap_flows where user_id=v_user and chat_id=v_chat and token=p_update->>'flowToken'and expires_at>now()for update;
 if f.user_id is null then return;end if;
 select * into st from staffing_staff where telegram_user_id=v_user and active;
 select store_id into g from staffing_groups where chat_id=v_chat;
 if st.id is null or g is null then return;end if;
 if p_update->>'choice'='page'then
  if(v_entity='next'and(f.data->>'more')::boolean)or(v_entity='prev'and f.page>0)then
   update staffing_swap_flows set page=page+case v_entity when 'next'then 1 else -1 end where user_id=v_user and chat_id=v_chat;perform staffing_swap_prompt(v_user,v_chat);
  end if;return;
 end if;
 if f.step<>p_update->>'choice'or not exists(select 1 from jsonb_array_elements(f.data->'options')o where o->>'id'=v_entity)then return;end if;
 if f.step='mode'then update staffing_swap_flows set step='shift',page=0,data=jsonb_build_object('mode',v_entity)where user_id=v_user and chat_id=v_chat;perform staffing_swap_prompt(v_user,v_chat);return;end if;
 if f.step='shift'then
  select * into sh from staffing_shifts where id=v_entity::uuid and staff_id=st.id and store_id=g and starts_at>now();
  if sh.id is null then return;end if;
  update staffing_swap_flows set step='person',page=0,data=jsonb_build_object('mode',f.data->>'mode','shift',to_jsonb(sh))where user_id=v_user and chat_id=v_chat;perform staffing_swap_prompt(v_user,v_chat);return;
 end if;
 if f.step='person'then
  select * into target from staffing_staff where id=v_entity::uuid and active and telegram_user_id is not null and id<>st.id;
  if target.id is null or not exists(select 1 from staffing_store_regions home join staffing_store_regions dest on dest.region_id=home.region_id where home.store_id=target.home_store_id and dest.store_id=g)then return;end if;
  if f.data->>'mode'='swap'then
   update staffing_swap_flows set step='other',page=0,data=jsonb_build_object('mode','swap','shift',f.data->'shift','target',target.id)where user_id=v_user and chat_id=v_chat;perform staffing_swap_prompt(v_user,v_chat);return;
  end if;
 else
  select * into target from staffing_staff where id=(f.data->>'target')::uuid and active and telegram_user_id is not null;
  select * into other from staffing_shifts where id=v_entity::uuid and staff_id=target.id and store_id=g and starts_at>now();if other.id is null then return;end if;
 end if;
 if target.id is null then return;end if;
 perform id from staffing_staff where id in(st.id,target.id)order by id for update;
 if exists(select 1 from staffing_staff where id in(st.id,target.id)and(not active or telegram_user_id is null))then return;end if;
 select * into st from staffing_staff where id=st.id and telegram_user_id=v_user;
 select * into target from staffing_staff where id=target.id;
 if st.id is null then return;end if;
 select * into sh from staffing_shifts where id=(f.data->'shift'->>'id')::uuid and staff_id=st.id and store_id=g for update;
 if sh.id is null or to_jsonb(sh)<>f.data->'shift'or sh.starts_at<=now()or exists(select 1 from staffing_attempts where shift_id in(sh.id,other.id))or exists(select 1 from staffing_sessions where shift_id in(sh.id,other.id))then
  delete from staffing_swap_flows where user_id=v_user and chat_id=v_chat;
  insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_chat,'text','Jadwal berubah atau sudah memiliki absensi. Ulangi /tukar.'));return;
 end if;
 update staffing_shift_requests expired_req set status=case when expires_at<=now()then 'expired'else 'stale'end where shift_id=sh.id and status in('pending_peer','pending_manager')and not staffing_shift_request_valid(expired_req.id);
 if exists(select 1 from staffing_shift_requests where shift_id=sh.id and status in('pending_peer','pending_manager'))then return;end if;
 insert into staffing_shift_requests(requester_id,target_staff_id,requester_telegram_id,target_telegram_id,shift_id,other_shift_id,store_id,chat_id,mode,shift_snapshot,other_snapshot,expires_at)
 values(st.id,target.id,st.telegram_user_id,target.telegram_user_id,sh.id,other.id,g,v_chat,f.data->>'mode',to_jsonb(sh),case when other.id is not null then to_jsonb(other)end,least(now()+interval '24 hours',sh.starts_at,coalesce(other.starts_at,sh.starts_at)))returning * into r;
 delete from staffing_swap_flows where user_id=v_user and chat_id=v_chat;
 insert into staffing_audit(actor,action,entity_id,details)values('telegram:'||v_user,'request_shift_change',r.id::text,jsonb_build_object('request',to_jsonb(r)));
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_chat,'text',staffing_shift_request_text(r.id)||E'\n'||target.full_name||', apakah bersedia? Hanya akun pihak kedua yang dapat menyetujui / menolak. Setelah itu perlu persetujuan manager. Berlaku sampai '||to_char(r.expires_at at time zone(select time_zone from stores where id=g),'DD/MM HH24:MI')||E'\nAlasan pribadi cukup dibicarakan melalui chat pribadi.','reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Saya bersedia','callback_data','sr:y:'||r.id),jsonb_build_object('text','Tolak','callback_data','sr:n:'||r.id)),jsonb_build_array(jsonb_build_object('text','Batalkan permintaan','callback_data','sr:x:'||r.id))))));
end$$;

create function staffing_swap_peer(p_update jsonb)returns void language plpgsql set search_path=public as $$
declare r staffing_shift_requests;st staffing_staff;v_state text;begin
 select * into r from staffing_shift_requests where id=(p_update->>'requestId')::uuid and chat_id=(p_update->>'chatId')::bigint;
 select * into st from staffing_staff where telegram_user_id=(p_update->>'userId')::bigint and active;
 if r.id is null or st.id is null then return;end if;
 if(p_update->>'kind'='swap_cancel'and st.id<>r.requester_id)or(p_update->>'kind'<>'swap_cancel'and st.id<>r.target_staff_id)then return;end if;
 perform id from staffing_staff where id in(r.requester_id,r.target_staff_id)order by id for update;
 select * into r from staffing_shift_requests where id=r.id for update;
 if r.status not in('pending_peer','pending_manager')then return;end if;
 if p_update->>'kind'<>'swap_cancel'and r.status<>'pending_peer'then return;end if;
 if not staffing_shift_request_valid(r.id)then
  update staffing_shift_requests set status=case when expires_at<=now()then 'expired'else 'stale'end where id=r.id;
  perform staffing_shift_request_notify(r.id,'Permintaan tidak berlaku. Buat permintaan baru dari jadwal terbaru.');return;
 end if;
 v_state:=case p_update->>'kind'when 'swap_accept'then 'pending_manager'when 'swap_reject'then 'rejected'else 'cancelled'end;
 update staffing_shift_requests set status=v_state,peer_decided_at=now()where id=r.id;
 insert into staffing_audit(actor,action,entity_id,details)values('telegram:'||st.telegram_user_id,'peer_shift_decision',r.id::text,jsonb_build_object('status',v_state));
 perform staffing_shift_request_notify(r.id,case v_state when 'pending_manager'then 'Pihak kedua sudah bersedia. Menunggu persetujuan manager melalui Activities → Permintaan shift. Jadwal belum berubah.'when 'rejected'then 'Pihak kedua menolak. Jadwal tetap.'else 'Pengaju membatalkan permintaan. Jadwal tetap.'end);
end$$;

create function staffing_bot_private(p_user bigint,p_chat bigint,p_kind text)returns void language plpgsql set search_path=public as $$
declare st staffing_staff;money jsonb;body text;lines text;zone text;buttons jsonb;begin
 if p_user<>p_chat then return;end if;
 select * into st from staffing_staff where telegram_user_id=p_user and active;
 if st.id is null then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',p_chat,'text','Akun belum tertaut atau tidak aktif. Minta undangan pribadi dari manager.'));return;end if;
 select time_zone into zone from stores where id=st.home_store_id;
 money:=staffing_staff_money(st.id);
 case p_kind
 when 'balance'then body:='Saldo pribadi · '||st.full_name||E'\nIzin berbayar: '||coalesce(money->>'leave_balance','Belum dicatat')||E'\nPlafon kasbon: Rp'||coalesce(money->>'ceiling','Belum diatur')||E'\nKasbon belum lunas: Rp'||(money->>'outstanding')||E'\nDicadangkan untuk pencairan: Rp'||(money->>'reserved')||E'\nKasbon tersedia: Rp'||coalesce(money->>'available','Belum diatur');
 when 'history'then
  select string_agg(q.line,E'\n\n')into lines from(select so.name||' · '||to_char(sh.starts_at at time zone so.time_zone,'DD/MM/YYYY')||E'\nMasuk '||to_char(coalesce(se.corrected_in_at,se.check_in_at)at time zone so.time_zone,'HH24:MI')||' / Pulang '||coalesce(to_char(coalesce(se.corrected_out_at,se.check_out_at)at time zone so.time_zone,'HH24:MI'),'belum checkout')||' · '||case se.verification_state when 'pending'then 'Menunggu review'when 'confirmed'then 'Dikonfirmasi'else 'Ditolak'end||case when sh.replaces_staff_id is not null then ' · Menggantikan '||(select full_name from staffing_staff where id=sh.replaces_staff_id)else ''end as line
   from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id join stores so on so.id=sh.store_id where se.staff_id=st.id order by se.check_in_at desc limit 10)q;
  body:='Absensi saya · 10 sesi terakhir'||E'\n\n'||coalesce(lines,'Belum ada absensi.');
 when 'income'then
  select string_agg(q.line,E'\n\n')into lines from(select period_start||' – '||period_end||E'\nPayroll FINAL · Net Rp'||(result->>'net_pay')||' · Pengembalian kasbon Rp'||(result->>'loan_repayment')as line from staffing_payrolls where staff_id=st.id order by created_at desc limit 3)q;
  body:='Penghasilan saya'||E'\n\n'||coalesce(lines,'Belum ada payroll final.')||E'\nBonus belum masuk payroll: Rp'||coalesce((select sum(amount)::text from staffing_bonuses where staff_id=st.id and payroll_id is null),'0')||E'\nPoin SP tercatat: '||coalesce((select sum(points)::text from staffing_discipline where staff_id=st.id),'0');
 when 'leave_status'then
  select string_agg(q.line,E'\n')into lines from(select start_date||' – '||end_date||' · '||days||' hari · '||case status when 'pending'then 'Menunggu review'when 'approved'then 'Disetujui'when 'rejected'then 'Ditolak'else 'Dibatalkan'end as line from staffing_requests where staff_id=st.id and kind<>'cash_advance'order by created_at desc limit 10)q;
  body:='Izin & sakit saya'||E'\nSaldo izin: '||coalesce(money->>'leave_balance','Belum dicatat')||E'\n'||coalesce(lines,'Belum ada pengajuan.')||E'\nPengajuan baru / koreksi dicatat manager melalui dashboard pada tahap ini.';
 when 'cash_status'then
  select string_agg(q.line,E'\n')into lines from(select to_char(created_at at time zone zone,'DD/MM/YYYY')||' · Rp'||amount||' · '||case status when 'pending'then 'Menunggu review'when 'approved'then 'Menunggu pencairan'when 'disbursed'then 'Dicairkan'when 'rejected'then 'Ditolak'else 'Dibatalkan'end as line from staffing_requests where staff_id=st.id and kind='cash_advance'order by created_at desc limit 10)q;
  body:='Kasbon saya'||E'\nPlafon: Rp'||coalesce(money->>'ceiling','Belum diatur')||E'\nTersedia: Rp'||coalesce(money->>'available','Belum diatur')||E'\nBelum lunas: Rp'||(money->>'outstanding')||E'\n'||coalesce(lines,'Belum ada pengajuan kasbon.')||E'\nPengajuan baru dicatat manager melalui dashboard pada tahap ini.';
 else body:='Menu pribadi · '||st.full_name||E'\nPilih informasi milikmu. Perubahan plafon, saldo, tarif dan koreksi waktu hanya dilakukan manager melalui dashboard.';
 end case;
 buttons:='[[{"text":"Jadwal saya","callback_data":"sm:schedule"},{"text":"Absensi saya","callback_data":"sm:history"}],[{"text":"Saldo saya","callback_data":"sm:balance"},{"text":"Izin & sakit","callback_data":"sm:leave"}],[{"text":"Kasbon saya","callback_data":"sm:cash"},{"text":"Penghasilan saya","callback_data":"sm:income"}]]';
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',p_chat,'text',body,'reply_markup',jsonb_build_object('inline_keyboard',buttons)));
end$$;

create function staffing_bot_group_schedule(p_user bigint,p_chat bigint,p_day date default null)returns void language plpgsql set search_path=public as $$
declare g stores;st staffing_staff;day date;today date;body text;line text;row record;buttons jsonb:='[]';i integer;begin
 select s.* into g from stores s join staffing_groups gr on gr.store_id=s.id where gr.chat_id=p_chat and s.active;
 select * into st from staffing_staff where telegram_user_id=p_user and active;
 if g.id is null or st.id is null then return;end if;
 today:=(now()at time zone g.time_zone)::date;day:=coalesce(p_day,today);
 if day<today-7 or day>today+90 then return;end if;
 body:='Jadwal committed · '||g.name||' · '||to_char(day,'DD/MM/YYYY');
 for row in select sh.*,s.full_name from staffing_shifts sh join staffing_staff s on s.id=sh.staff_id where sh.store_id=g.id and sh.starts_at<((day+1)::timestamp at time zone g.time_zone)and sh.ends_at>(day::timestamp at time zone g.time_zone)order by sh.starts_at,s.full_name loop
  line:=E'\n'||row.full_name||' · '||row.label||' · '||to_char(row.starts_at at time zone g.time_zone,'DD/MM HH24:MI')||' – '||to_char(row.ends_at at time zone g.time_zone,'DD/MM HH24:MI');
  if length(body)+length(line)>3500 then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',p_chat,'text',body));body:='Jadwal committed (lanjutan)';end if;
  body:=body||line;
 end loop;
 if body='Jadwal committed · '||g.name||' · '||to_char(day,'DD/MM/YYYY')then body:=body||E'\nBelum ada shift pada tanggal ini.';end if;
 for i in 0..6 loop buttons:=buttons||jsonb_build_array(jsonb_build_object('text',to_char(today+i,'DD/MM'),'callback_data','sg:'||(today+i)));end loop;
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',p_chat,'text',body,'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(buttons))));
end$$;

-- This dispatcher accepts only normalized operations from the verified webhook.
-- Staff identity comes exclusively from the event sender; no staff/actor/amount
-- from command text or callback data reaches a manager mutation RPC.
create or replace function staffing_apply_update(p_update jsonb)returns void language plpgsql set search_path=public as $$
declare kind text:=p_update->>'kind';uid bigint:=(p_update->>'userId')::bigint;chat bigint:=(p_update->>'chatId')::bigint;st staffing_staff;g uuid;f staffing_swap_flows;begin
 if uid is null or uid<=0 or chat is null or(p_update->>'chatType'='private'and chat<>uid)then return;end if;
 perform pg_advisory_xact_lock(hashtext('staffing-bot'),hashtext(uid::text));
 if kind in('start','check_in','check_out','confirm','report','location','photo')or(kind='schedule'and p_update->>'chatType'='private')then
  perform staffing_attendance_update_v3(p_update);return;
 end if;
 if kind='cancel'then
  delete from staffing_swap_flows where user_id=uid and chat_id=chat;
  if not found then perform staffing_attendance_update_v3(p_update);return;end if;
 end if;
 if kind not in('menu','balance','history','income','leave_status','cash_status','help','swap_start','swap_pick','swap_accept','swap_reject','swap_cancel','schedule','cancel')then return;end if;
 insert into staffing_inbox(update_id)values((p_update->>'updateId')::bigint)on conflict do nothing;if not found then return;end if;
 if p_update->>'chatType'='private'then
  if kind in('swap_start','swap_pick','swap_accept','swap_reject','swap_cancel')then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Pergantian / pertukaran shift dilakukan dari /tukar di grup store.'));return;end if;
  if kind='cancel'then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Proses dibatalkan.'));return;end if;
  perform staffing_bot_private(uid,chat,kind);return;
 end if;
 select gr.store_id into g from staffing_groups gr join stores s on s.id=gr.store_id where gr.chat_id=chat and s.active;
 select * into st from staffing_staff where telegram_user_id=uid and active;
 if g is null or st.id is null then return;end if;
 case kind
 when 'swap_start'then
  insert into staffing_swap_flows(user_id,chat_id,step)values(uid,chat,'mode')on conflict(user_id,chat_id)do update set step='mode',data='{}',page=0,expires_at=now()+interval '10 minutes';perform staffing_swap_prompt(uid,chat);
 when 'swap_pick'then perform staffing_swap_pick(p_update);
 when 'swap_accept','swap_reject','swap_cancel'then perform staffing_swap_peer(p_update);
 when 'schedule'then perform staffing_bot_group_schedule(uid,chat,nullif(p_update->>'scheduleDate','')::date);
 when 'cancel'then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Proses pemilihan shift dibatalkan. Permintaan yang sudah dikirim dapat dibatalkan lewat tombol pada permintaannya.'));
 when 'help'then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Grup: /masuk, /pulang, /jadwal, /tukar, /batal. Gunakan @username bot pada command jika ada beberapa bot. Balas langsung pesan bot untuk mengirim lokasi dan foto. Informasi pribadi tersedia lewat /menu di chat pribadi.'));
 else insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Informasi pribadi hanya tersedia melalui /menu di chat pribadi bot.'));
 end case;
end$$;

create function staffing_notify_personal_result()returns trigger language plpgsql set search_path=public as $$declare uid bigint;body text;begin
 select telegram_user_id into uid from staffing_staff where id=new.staff_id and active;
 if uid is null then return new;end if;
 if tg_table_name='staffing_sessions'then
  if new.verification_state='pending'or(new.verification_state=old.verification_state and new.corrected_in_at is not distinct from old.corrected_in_at and new.corrected_out_at is not distinct from old.corrected_out_at)then return new;end if;
  body:='Review absensi '||case new.verification_state when 'confirmed'then 'dikonfirmasi'else 'ditolak'end||'. Lihat /absensi untuk waktu terbaru. Catatan manager: '||coalesce(new.review_note,'—');
 else
  if new.status=old.status then return new;end if;
  body:='Pengajuan '||case new.kind when 'cash_advance'then 'kasbon Rp'||new.amount else 'izin / sakit '||new.start_date||' – '||new.end_date end||' · '||case new.status when 'approved'then case when new.kind='cash_advance'then 'Disetujui, menunggu pencairan'else 'Disetujui'end when 'disbursed'then 'Pencairan dikonfirmasi'when 'rejected'then 'Ditolak'else 'Dibatalkan'end||E'\nLihat /menu untuk rincian pribadi.';
 end if;
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',uid,'text',body));return new;
end$$;
create trigger staffing_attendance_review_notification after update on staffing_sessions for each row execute function staffing_notify_personal_result();
create trigger staffing_request_decision_notification after update on staffing_requests for each row execute function staffing_notify_personal_result();

revoke all on function staffing_attendance_update_v3(jsonb),staffing_shift_request_text(uuid),staffing_shift_request_valid(uuid),staffing_shift_request_notify(uuid,text),staffing_shift_queue(uuid,boolean,uuid),staffing_decide_shift(uuid,boolean,uuid,text,text),staffing_swap_prompt(bigint,bigint),staffing_swap_pick(jsonb),staffing_swap_peer(jsonb),staffing_bot_private(bigint,bigint,text),staffing_bot_group_schedule(bigint,bigint,date),staffing_notify_personal_result()from public,anon,authenticated;
grant execute on function staffing_attendance_update_v3(jsonb),staffing_shift_request_text(uuid),staffing_shift_request_valid(uuid),staffing_shift_request_notify(uuid,text),staffing_shift_queue(uuid,boolean,uuid),staffing_decide_shift(uuid,boolean,uuid,text,text),staffing_swap_prompt(bigint,bigint),staffing_swap_pick(jsonb),staffing_swap_peer(jsonb),staffing_bot_private(bigint,bigint,text),staffing_bot_group_schedule(bigint,bigint,date),staffing_notify_personal_result()to service_role;
create function staffing_audit_shift_status()returns trigger language plpgsql set search_path=public as $$begin
 if new.status is distinct from old.status then insert into staffing_audit(actor,action,entity_id,details)values(coalesce(new.decided_by,'system:telegram'),'shift_request_status',new.id::text,jsonb_build_object('before',old.status,'after',new.status));end if;return new;
end$$;
create trigger staffing_shift_status_audit after update of status on staffing_shift_requests for each row execute function staffing_audit_shift_status();
revoke all on function staffing_audit_shift_status()from public,anon,authenticated;
grant execute on function staffing_audit_shift_status()to service_role;

-- Extend existing read models; the existing attendance and request scopes remain intact.
alter function staffing_activity(uuid,boolean,uuid,date)rename to staffing_activity_v3;
create function staffing_activity(p_actor uuid,p_bootstrap boolean,p_store uuid default null,p_day date default null)returns jsonb language sql stable set search_path=public as $$
 select staffing_activity_v3(p_actor,p_bootstrap,p_store,p_day)||jsonb_build_object('shift_requests',staffing_shift_queue(p_actor,p_bootstrap,p_store));
$$;
alter function staffing_home(uuid,boolean)rename to staffing_home_v3;
create function staffing_home(p_actor uuid,p_bootstrap boolean)returns jsonb language plpgsql stable set search_path=public as $$declare v jsonb;begin
 v:=staffing_home_v3(p_actor,p_bootstrap);return jsonb_set(v,'{pending_requests}',to_jsonb((v->>'pending_requests')::integer+jsonb_array_length(staffing_shift_queue(p_actor,p_bootstrap,null))));
end$$;
revoke all on function staffing_activity(uuid,boolean,uuid,date),staffing_home(uuid,boolean)from public,anon,authenticated;
grant execute on function staffing_activity(uuid,boolean,uuid,date),staffing_home(uuid,boolean)to service_role;
commit;
