begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local search_path=public;

alter table staffing_attempts add column verification_chat_id bigint;
-- Final payroll snapshots are immutable. Unposted excess time now requires explicit approval.
alter table staffing_sessions add column overtime_request_required boolean not null default true;
alter table staffing_private_flows drop constraint staffing_private_flows_step_check;
alter table staffing_private_flows add constraint staffing_private_flows_step_check check(step in('type','amount','start','end','reason','evidence','confirm','overtime_date','overtime_reason','overtime_confirm','overtime_session'));
create table staffing_overtime_requests(
 id uuid primary key default gen_random_uuid(),staff_id uuid not null references staffing_staff(id),session_id uuid not null references staffing_sessions(id),store_id uuid not null references stores(id),
 reason text not null check(length(trim(reason))between 5 and 2000),intervals jsonb not null,snapshot_version text not null,
 status text not null default 'pending'check(status in('pending','approved','rejected','stale')),created_at timestamptz not null default now(),decided_at timestamptz,decided_by text,decision_note text
);
create unique index staffing_one_overtime_request on staffing_overtime_requests(session_id)where status in('pending','approved');
create index on staffing_overtime_requests(store_id,status,created_at);
alter table staffing_overtime_requests enable row level security;
revoke all on staffing_overtime_requests from public,anon,authenticated;
grant all on staffing_overtime_requests to service_role;

create function staffing_short_range(p_start timestamptz,p_end timestamptz,p_zone text,p_date boolean default true)returns text language sql stable set search_path=public as $$
 select case when p_date then to_char(p_start at time zone p_zone,'DD/MM ')else ''end||to_char(p_start at time zone p_zone,'HH24:MI')||' - '||case when(p_start at time zone p_zone)::date<>(p_end at time zone p_zone)::date then to_char(p_end at time zone p_zone,'DD/MM ')else ''end||coalesce(to_char(p_end at time zone p_zone,'HH24:MI'),'belum pulang');
$$;
create function staffing_bot_escape(p_text text)returns text language sql immutable set search_path=public as $$ select replace(replace(replace(coalesce(p_text,''),'&','&amp;'),'<','&lt;'),'>','&gt;'); $$;
create function staffing_bot_mention(p_name text,p_user bigint)returns text language sql immutable set search_path=public as $$ select case when p_user>0 then '<a href="tg://user?id='||p_user||'">'||staffing_bot_escape(p_name)||'</a>'else staffing_bot_escape(p_name)end; $$;


alter function staffing_bot_private(bigint,bigint,text)rename to staffing_bot_private_legacy_v13;

create function staffing_bot_private(p_user bigint,p_chat bigint,p_kind text)returns void language plpgsql set search_path=public as $$
declare st staffing_staff;body text;lines text;keys jsonb:='[[{"text":"Jadwal saya","callback_data":"sm:schedule"},{"text":"Absensi saya","callback_data":"sm:history"}],[{"text":"Izin / sakit","callback_data":"sm:leave"},{"text":"Ajukan lembur","callback_data":"rq:overtime"}]]';begin
 if p_user<>p_chat then return;end if;select * into st from staffing_staff where telegram_user_id=p_user and active;
 if st.id is null then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',p_chat,'text','Akun belum tertaut. Hubungi manager.'));return;end if;
 case p_kind
 when 'schedule'then
  select string_agg(line,E'\n\n'order by starts_at)into lines from(select sh.starts_at,staffing_short_range(sh.starts_at,sh.ends_at,s.time_zone)as line from staffing_shifts sh join stores s on s.id=sh.store_id where sh.staff_id=st.id and sh.ends_at>=now()order by sh.starts_at limit 10)q;body:=coalesce(lines,'Belum ada jadwal.');
 when 'history'then
  select string_agg(line,E'\n\n'order by check_in_at desc)into lines from(select se.check_in_at,staffing_short_range(coalesce(se.corrected_in_at,se.check_in_at),coalesce(se.corrected_out_at,se.check_out_at),s.time_zone)||' ('||case se.verification_state when 'pending'then 'menunggu review'when 'confirmed'then 'dikonfirmasi'else 'ditolak'end||')'as line from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id join stores s on s.id=sh.store_id where se.staff_id=st.id order by se.check_in_at desc limit 10)q;
  body:='Absensi 10 sesi terakhir'||E'\n\n'||coalesce(lines,'Belum ada absensi.');
 when 'leave_status'then
  select string_agg(line,E'\n'order by created_at desc)into lines from(select created_at,to_char(start_date,'DD/MM')||case when end_date<>start_date then ' - '||to_char(end_date,'DD/MM')else ''end||' ('||case status when 'pending'then 'menunggu review'when 'approved'then 'disetujui'when 'rejected'then 'ditolak'else 'dibatalkan'end||')'as line from staffing_requests where staff_id=st.id and kind<>'cash_advance'order by created_at desc limit 10)q;
  body:='Saldo izin: '||coalesce(staffing_staff_money(st.id)->>'leave_balance','0')||E'\n\n'||coalesce(lines,'Belum ada pengajuan.')||E'\n\nPilih Ajukan izin / sakit untuk membuat pengajuan';
  keys:=jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Ajukan izin / sakit','callback_data','rq:leave')));
 when 'help'then body:='Pribadi: /menu, /jadwal, /absen, /izin, /lembur. Gunakan tombol Batal untuk membatalkan pengisian.';
 else body:='Menu Pribadi'||E'\n\nSilahkan pilih fitur di bawah ini';
 end case;
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',p_chat,'text',body,'reply_markup',jsonb_build_object('inline_keyboard',keys)));
end $$;


create or replace function staffing_bot_group_schedule(p_user bigint,p_chat bigint,p_day date default null)returns void language plpgsql set search_path=public as $$
declare g stores;day date;today date;body text;title text;line text;r record;last_band integer:=-1;keys jsonb:='[]';i integer;n integer:=0;begin
 select s.* into g from stores s join staffing_groups gr on gr.store_id=s.id where gr.chat_id=p_chat and s.active;
 if g.id is null or not exists(select 1 from staffing_staff where telegram_user_id=p_user and active)then return;end if;
 today:=(now()at time zone g.time_zone)::date;day:=coalesce(p_day,today);if day<today-7 or day>today+90 then return;end if;
 title:='Jadwal '||case when g.name ilike 'Sarkop %'then g.name else 'Sarkop '||g.name end||' '||to_char(day,'DD/MM/YYYY');body:=title;
 for r in select sh.*,st.full_name,floor(extract(hour from sh.starts_at at time zone g.time_zone)/6)::integer as band from staffing_shifts sh join staffing_staff st on st.id=sh.staff_id where sh.store_id=g.id and sh.starts_at<((day+1)::timestamp at time zone g.time_zone)and sh.ends_at>(day::timestamp at time zone g.time_zone)order by band,sh.starts_at,st.full_name,sh.id loop
  line:=case when last_band<>r.band then E'\n\n'else E'\n'end||r.full_name||' '||staffing_short_range(r.starts_at,r.ends_at,g.time_zone,(r.starts_at at time zone g.time_zone)::date<>day);
  if length(body)+length(line)>3500 then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',p_chat,'text',body));body:=title;end if;
  body:=body||line;last_band:=r.band;n:=n+1;
 end loop;
 if n=0 then body:=body||E'\n\nBelum ada jadwal.';end if;
 for i in 0..6 loop keys:=keys||jsonb_build_array(jsonb_build_object('text',to_char(today+i,'DD/MM'),'callback_data','sg:'||(today+i)));end loop;
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',p_chat,'text',body,'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(keys))));
end $$;


create or replace function public.staffing_attendance_update_v13(p_update jsonb)
returns void language plpgsql set search_path = public as $$
declare
  v_user bigint := (p_update->>'userId')::bigint;
  v_chat bigint := (p_update->>'chatId')::bigint;
  v_kind text := p_update->>'kind';
  v_was_private boolean := p_update->>'chatType'='private';
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
      insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_user,'text','Hanya staf store ini / staf yang sedang ditugaskan di sini dapat mewakili absen.'));return;
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
      insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_user,'text','Akun belum ditautkan atau staf tidak aktif. Hubungi manager.'));
    end if; return;
  end if;
  if v_kind in ('check_in','check_out') then
    if exists(select 1 from staffing_attempts where staff_id=v_staff.id and state in('confirmation','location','photo')and expires_at>now()and coalesce(submitted_by_staff_id,staff_id)<>v_reporter.id)then
      insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_user,'text','Absensi staf ini sedang diverifikasi oleh pelapor lain. Selesaikan atau batalkan proses tersebut dahulu.'));return;
    end if;
    if v_kind='check_in' then
      if exists(select 1 from staffing_sessions where staff_id=v_staff.id and coalesce(corrected_out_at,check_out_at) is null) then
        insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_user,'text','Masih ada sesi kerja terbuka. Gunakan /pulang atau hubungi manager.')); return;
      end if;
      select count(*) into v_count from staffing_shifts sh where staff_id=v_staff.id and store_id=v_store and starts_at<=v_effective+interval '2 hours' and ends_at>=v_effective and not exists(select 1 from staffing_sessions where shift_id=sh.id);
      if v_count<>1 then
        insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_user,'text','Tidak ditemukan satu shift yang sesuai di store ini. Hubungi manager untuk memeriksa jadwal.')); return;
      end if;
      select * into v_shift from staffing_shifts sh where staff_id=v_staff.id and store_id=v_store and starts_at<=v_effective+interval '2 hours' and ends_at>=v_effective and not exists(select 1 from staffing_sessions where shift_id=sh.id);
    else
      select se.* into v_session from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id where se.staff_id=v_staff.id and sh.store_id=v_store and coalesce(se.corrected_out_at,se.check_out_at) is null;
      if v_session.id is null then
        insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_user,'text','Tidak ada sesi terbuka di store ini. Hubungi manager jika ada absensi yang perlu dikoreksi.')); return;
      end if;
      select * into v_shift from staffing_shifts where id=v_session.shift_id;
    end if;
    if v_kind='check_in'and exists(select 1 from staffing_requests r cross join lateral jsonb_array_elements(r.leave_dates)d join stores so on so.id=v_store where r.staff_id=v_staff.id and r.status='approved'and r.kind<>'cash_advance'and v_shift.starts_at<(((d->>'date')::date+1)::timestamp at time zone so.time_zone)and v_shift.ends_at>((d->>'date')::date::timestamp at time zone so.time_zone))then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_user,'text','Shift ini memiliki izin yang disetujui. Hubungi manager untuk koreksi.'));return;end if;
    update staffing_attempts set state='cancelled' where coalesce(submitted_by_staff_id,staff_id)=v_reporter.id and chat_id=v_chat and state in ('confirmation','location','photo');
    if v_effective < now()-interval '10 minutes' then
      insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_user,'text','Command sudah kedaluwarsa. Ulangi absensi atau hubungi manager untuk koreksi.'));return;
    end if;
    insert into staffing_attempts(staff_id,submitted_by_staff_id,shift_id,chat_id,kind,state,requested_at,request_message_id,expires_at,verification_chat_id) values(v_staff.id,v_reporter.id,v_shift.id,v_chat,v_kind,'confirmation',v_effective,(p_update->>'messageId')::bigint,v_effective+interval '10 minutes',v_user) returning * into v_attempt;
    select 'Konfirmasi '||case when v_kind='check_in'then 'masuk'else 'pulang'end||': '||v_staff.full_name||' '||staffing_short_range(v_shift.starts_at,v_shift.ends_at,s.time_zone)||E'\n\nLanjutkan dengan lokasi dan foto.'into v_text from stores s where s.id=v_store;
    v_payload := jsonb_build_object('chat_id',v_user,'text',v_text||case when v_reporter.id<>v_staff.id then E'\nDiwakili oleh '||v_reporter.full_name||'. Bukti dikirim pelapor; menunggu review manager.'else ''end,'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Benar, lanjutkan','callback_data','sf:c:'||v_attempt.id),jsonb_build_object('text','Batal','callback_data','sf:x:'||v_attempt.id)))));
    insert into staffing_outbox(payload,attempt_id,expected_state) values(v_payload,v_attempt.id,'confirmation'); return;
  end if;
  if v_kind in ('confirm','cancel') then
    select * into v_attempt from staffing_attempts where coalesce(submitted_by_staff_id,staff_id)=v_reporter.id and chat_id=v_chat and (id=(p_update->>'attemptId')::uuid or (p_update->>'attemptId' is null and state in ('confirmation','location','photo'))) order by received_at desc limit 1 for update;
  else
    select * into v_attempt from staffing_attempts where coalesce(submitted_by_staff_id,staff_id)=v_reporter.id and chat_id=v_chat and prompt_message_id=(p_update->>'replyTo')::bigint and state in ('location','photo') order by received_at desc limit 1 for update;
  end if;
  if v_attempt.id is null or v_attempt.state in ('completed','cancelled')then
    if v_kind='cancel'then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',v_user,'text',case when v_flow_deleted then 'Pemilihan tukar shift dibatalkan. 'else 'Tidak ada verifikasi absensi aktif milikmu di chat ini. 'end||'Absensi / jadwal yang sudah tercatat tidak dihapus. Batalkan permintaan tukar terkirim lewat tombol pada permintaannya.'));end if;
    return;
  end if;
  if not v_was_private and v_attempt.verification_chat_id is not null and v_kind<>'cancel'then return;end if;
  if v_kind='cancel' then
    update staffing_attempts set state='cancelled' where id=v_attempt.id;
    insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_user,'text','Proses absensi dibatalkan.')); return;
  end if;
  if v_attempt.expires_at<=now() or v_effective>v_attempt.expires_at then
    update staffing_attempts set state='cancelled' where id=v_attempt.id;
    insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_user,'text','Verifikasi kedaluwarsa. Mulai kembali dengan /masuk atau /pulang.')); return;
  end if;
  if v_effective < v_attempt.requested_at then return; end if;
  if v_kind='confirm' and v_attempt.state='confirmation' then
    update staffing_attempts set state='location',prompt_message_id=null where id=v_attempt.id;
    v_text := 'Balas pesan ini dengan lokasi melalui Attachment > Location. Kedaluwarsa dalam '||greatest(1,ceil(extract(epoch from(v_attempt.expires_at-now()))/60))||' menit.';
    insert into staffing_outbox(payload,attempt_id,expected_state) values(jsonb_build_object('chat_id',coalesce(v_attempt.verification_chat_id,v_chat),'text',v_text,'reply_markup',jsonb_build_object('force_reply',true,'selective',true)),v_attempt.id,'location'); return;
  end if;
  if v_kind='location' and v_attempt.state='location' then
    update staffing_attempts set state='photo',prompt_message_id=null,latitude=(p_update->>'latitude')::numeric,longitude=(p_update->>'longitude')::numeric,location_sent_at=v_effective where id=v_attempt.id;
    insert into staffing_outbox(payload,attempt_id,expected_state) values(jsonb_build_object('chat_id',coalesce(v_attempt.verification_chat_id,v_chat),'text','Balas pesan ini dengan foto kehadiran di Sarkop. Kedaluwarsa dalam '||greatest(1,ceil(extract(epoch from(v_attempt.expires_at-now()))/60))||' menit.','reply_markup',jsonb_build_object('force_reply',true,'selective',true)),v_attempt.id,'photo'); return;
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
   verification_state=v_state,review_note=v_note,reviewed_at=now(),reviewed_by=v_actor,overtime_from_attendance=false
  where id=se.id;
  insert into staffing_audit(actor,action,entity_id,details)values(v_actor,'review_attendance',se.id::text,jsonb_build_object('before',to_jsonb(se),'after',(select to_jsonb(s)from staffing_sessions s where s.id=se.id)));
 end if;
 v_result:=jsonb_build_object('id',se.id)||staffing_attendance_metadata(se.id);
 update staffing_operation_keys set result=v_result where key=v_key;
 return v_result;
end$$;

create or replace function staffing_swap_prompt(p_user bigint,p_chat bigint)returns void language plpgsql set search_path=public as $$
declare f staffing_swap_flows;st staffing_staff;g uuid;items jsonb;buttons jsonb:='[]';row jsonb;total integer;title text;nav jsonb:='[]';begin
 select * into f from staffing_swap_flows where user_id=p_user and chat_id=p_chat;
 select * into st from staffing_staff where telegram_user_id=p_user and active;
 select store_id into g from staffing_groups where chat_id=p_chat;
 if f.user_id is null or st.id is null or g is null or f.expires_at<=now()then return;end if;
 update staffing_swap_flows set token=substr(replace(gen_random_uuid()::text,'-',''),1,12)where user_id=p_user and chat_id=p_chat returning * into f;
 if f.step='mode'then
  items:='[{"id":"replace","label":"Minta pengganti"},{"id":"swap","label":"Tukar dua shift"}]';title:='Pilih minta pengganti atau tukar dua shift.';
 elsif f.step='shift'then
  select coalesce(jsonb_agg(to_jsonb(q)order by q.starts_at),'[]')into items from(select sh.id,sh.starts_at,staffing_short_range(sh.starts_at,sh.ends_at,so.time_zone)as label
   from staffing_shifts sh join stores so on so.id=sh.store_id where sh.staff_id=st.id and sh.store_id=g and sh.starts_at>now()and sh.starts_at<now()+interval '90 days'and not exists(select 1 from staffing_attempts where shift_id=sh.id)and not exists(select 1 from staffing_sessions where shift_id=sh.id)and not exists(select 1 from staffing_shift_requests r where r.shift_id=sh.id and r.status in('pending_peer','pending_manager')and r.expires_at>now()and staffing_shift_request_valid(r.id))order by sh.starts_at offset f.page*8 limit 9)q;
  title:='Pilih shift milikmu yang ingin diganti / ditukar.';
 elsif f.step='person'then
  select coalesce(jsonb_agg(to_jsonb(q)order by q.label,q.id),'[]')into items from(select s.id,s.full_name as label from staffing_staff s
   join staffing_store_regions sr on sr.store_id=s.home_store_id join staffing_store_regions dest on dest.store_id=g and dest.region_id=sr.region_id
   where s.active and s.telegram_user_id is not null and s.id<>st.id order by s.full_name,s.id offset f.page*8 limit 9)q;
  title:='Pilih nama rekan. Hanya pengaju yang dapat memilih.';
 else
  select coalesce(jsonb_agg(to_jsonb(q)order by q.starts_at),'[]')into items from(select sh.id,sh.starts_at,staffing_short_range(sh.starts_at,sh.ends_at,so.time_zone)as label
   from staffing_shifts sh join stores so on so.id=sh.store_id where sh.staff_id=(f.data->>'target')::uuid and sh.store_id=g and sh.starts_at>now()and sh.starts_at<now()+interval '90 days'and not exists(select 1 from staffing_attempts where shift_id=sh.id)and not exists(select 1 from staffing_sessions where shift_id=sh.id)order by sh.starts_at offset f.page*8 limit 9)q;
  title:='Pilih shift '||(select full_name from staffing_staff where id=(f.data->>'target')::uuid)||' yang ingin ditukar.';
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
 buttons:=buttons||jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Batal','callback_data','sx:cancel:'||f.token||':yes')));
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',p_chat,'text',st.full_name||E'\n\n'||title||case when total=0 then E'\nTidak ada pilihan yang tersedia.'else ''end,'reply_markup',jsonb_build_object('inline_keyboard',buttons)));
end$$;

create or replace function staffing_swap_pick(p_update jsonb) returns void language plpgsql set search_path=public as $$
declare f staffing_swap_flows; st staffing_staff; target staffing_staff; sh staffing_shifts; other staffing_shifts; r staffing_shift_requests;
 g uuid; uid bigint:=(p_update->>'userId')::bigint; chat bigint:=(p_update->>'chatId')::bigint; entity text:=p_update->>'entityId';
begin
 select * into f from staffing_swap_flows where user_id=uid and chat_id=chat and token=p_update->>'flowToken' and expires_at>now() for update;
 select * into st from staffing_staff where telegram_user_id=uid and active;
 select store_id into g from staffing_groups where chat_id=chat;
 if f.user_id is null or st.id is null or g is null then return; end if;
 if p_update->>'choice'='cancel'then delete from staffing_swap_flows where user_id=uid and chat_id=chat;insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Pemilihan dibatalkan.'));return;end if;
 if p_update->>'choice'='page' then
  if(entity='next' and (f.data->>'more')::boolean) or(entity='prev' and f.page>0) then
   update staffing_swap_flows set page=page+case entity when 'next' then 1 else -1 end where user_id=uid and chat_id=chat;
   perform staffing_swap_prompt(uid,chat);
  end if; return;
 end if;
 if f.step<>p_update->>'choice' or not exists(select 1 from jsonb_array_elements(f.data->'options')o where o->>'id'=entity) then return; end if;
 if f.step='person' then
  select * into target from staffing_staff where id=entity::uuid and active and telegram_user_id is not null and id<>st.id;
  if target.id is null or not exists(select 1 from staffing_store_regions a join staffing_store_regions b using(region_id) where a.store_id=target.home_store_id and b.store_id=g) then return; end if;
  update staffing_swap_flows set step='mode',page=0,data=jsonb_build_object('target',target.id) where user_id=uid and chat_id=chat;
  perform staffing_swap_prompt(uid,chat); return;
 end if;
 if f.step='mode' then
  update staffing_swap_flows set step=case entity when 'swap' then 'other' else 'shift' end,page=0,data=jsonb_build_object('target',f.data->>'target','mode',entity) where user_id=uid and chat_id=chat;
  perform staffing_swap_prompt(uid,chat); return;
 end if;
 if f.step='other' then
  select * into other from staffing_shifts where id=entity::uuid and staff_id=(f.data->>'target')::uuid and store_id=g and starts_at>now();
  if other.id is null then return; end if;
  update staffing_swap_flows set step='shift',page=0,data=jsonb_build_object('target',f.data->>'target','mode','swap','other',to_jsonb(other)) where user_id=uid and chat_id=chat;
  perform staffing_swap_prompt(uid,chat); return;
 end if;
 select * into target from staffing_staff where id=(f.data->>'target')::uuid and active and telegram_user_id is not null;
 if target.id is null or not exists(select 1 from staffing_store_regions a join staffing_store_regions b using(region_id) where a.store_id=target.home_store_id and b.store_id=g) then return; end if;
 perform id from staffing_staff where id in(st.id,target.id) order by id for update;
 select * into st from staffing_staff where id=st.id and active and telegram_user_id=uid;
 select * into target from staffing_staff where id=target.id and active and telegram_user_id is not null;
 if st.id is null or target.id is null then return; end if;
 -- Lock both selected shifts in the same order used by manager approval.
 perform id from staffing_shifts where id in(entity::uuid,(f.data->'other'->>'id')::uuid) order by id for update;
 select * into sh from staffing_shifts where id=entity::uuid and staff_id=st.id and store_id=g and starts_at>now();
 if f.data->>'mode'='swap' then
  select * into other from staffing_shifts where id=(f.data->'other'->>'id')::uuid and staff_id=target.id and store_id=g and starts_at>now();
 end if;
 if sh.id is null or (f.data->>'mode'='swap' and (other.id is null or to_jsonb(other)<>f.data->'other'))
  or exists(select 1 from staffing_attempts where shift_id in(sh.id,other.id))
  or exists(select 1 from staffing_sessions where shift_id in(sh.id,other.id)) then
  delete from staffing_swap_flows where user_id=uid and chat_id=chat;
  insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Jadwal berubah atau sudah memiliki absensi. Ulangi /tukar.')); return;
 end if;
 update staffing_shift_requests q set status=case when expires_at<=now() then 'expired' else 'stale' end where shift_id=sh.id and status in('pending_peer','pending_manager') and not staffing_shift_request_valid(q.id);
 if exists(select 1 from staffing_shift_requests where (shift_id in(sh.id,other.id) or other_shift_id in(sh.id,other.id)) and status in('pending_peer','pending_manager') and expires_at>now()) then
  insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Salah satu shift masih memiliki permintaan aktif. /batal dan pilih jadwal lain.')); return;
 end if;
 insert into staffing_shift_requests(requester_id,target_staff_id,requester_telegram_id,target_telegram_id,shift_id,other_shift_id,store_id,chat_id,mode,shift_snapshot,other_snapshot,expires_at)
 values(st.id,target.id,st.telegram_user_id,target.telegram_user_id,sh.id,other.id,g,chat,f.data->>'mode',to_jsonb(sh),case when other.id is not null then to_jsonb(other) end,least(now()+interval '24 hours',sh.starts_at,coalesce(other.starts_at,sh.starts_at)))returning * into r;
 delete from staffing_swap_flows where user_id=uid and chat_id=chat;
 insert into staffing_audit(actor,action,entity_id,details)values('telegram:'||uid,'request_shift_change',r.id::text,jsonb_build_object('request',to_jsonb(r)));
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text',staffing_shift_request_text(r.id)||E'\n\n'||staffing_bot_mention(target.full_name,target.telegram_user_id)||', apakah bersedia?','parse_mode','HTML','reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Saya bersedia','callback_data','sr:y:'||r.id),jsonb_build_object('text','Tolak','callback_data','sr:n:'||r.id)),jsonb_build_array(jsonb_build_object('text','Batalkan permintaan','callback_data','sr:x:'||r.id))))));
end $$;

create or replace function staffing_shift_request_text(p_request uuid)returns text language sql stable set search_path=public as $$
 select case when r.status='approved'then ''when r.status='pending_peer'then 'Permintaan '||case r.mode when 'swap'then 'tukar jadwal'else 'pergantian'end||E'\n\n'else case r.mode when 'swap'then 'Tukar jadwal'else 'Pergantian'end||E'\n\n'end||staffing_bot_mention(a.full_name,r.requester_telegram_id)||' → '||staffing_bot_mention(b.full_name,r.target_telegram_id)||E'\n'||staffing_short_range((r.shift_snapshot->>'starts_at')::timestamptz,(r.shift_snapshot->>'ends_at')::timestamptz,s.time_zone)||case when r.mode='swap'then E'\n\n'||staffing_bot_mention(b.full_name,r.target_telegram_id)||' → '||staffing_bot_mention(a.full_name,r.requester_telegram_id)||E'\n'||staffing_short_range((r.other_snapshot->>'starts_at')::timestamptz,(r.other_snapshot->>'ends_at')::timestamptz,s.time_zone)else ''end
 from staffing_shift_requests r join staffing_staff a on a.id=r.requester_id join staffing_staff b on b.id=r.target_staff_id join stores s on s.id=r.store_id where r.id=p_request;
$$;
create or replace function staffing_shift_request_notify(p_request uuid,p_text text)returns void language plpgsql set search_path=public as $$
declare r staffing_shift_requests;u bigint;body text;begin
 select * into r from staffing_shift_requests where id=p_request;
 body:=staffing_shift_request_text(r.id)||E'\n\n'||case r.status when 'pending_manager'then 'Pihak kedua sudah bersedia. Menunggu persetujuan manager.'when 'approved'then 'Disetujui manager. Jadwal sudah diperbarui.'when 'rejected'then 'Permintaan ditolak.'when 'cancelled'then 'Permintaan dibatalkan.'else staffing_bot_escape(p_text)end;
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',r.chat_id,'text',body,'parse_mode','HTML'));
 for u in select distinct telegram_user_id from staffing_staff where id in(r.requester_id,r.target_staff_id)and telegram_user_id is not null loop insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',u,'text',body,'parse_mode','HTML'));end loop;
end $$;

alter function staffing_private_request(jsonb)rename to staffing_private_request_legacy_v13;

create or replace function staffing_leave_request_v13(p_update jsonb) returns void language plpgsql set search_path=public as $$
declare uid bigint:=(p_update->>'userId')::bigint; chat bigint:=(p_update->>'chatId')::bigint; k text:=p_update->>'kind';
 st staffing_staff; f staffing_private_flows; money jsonb; available numeric; amount_value bigint; input text:=trim(p_update->>'inputText'); d date; dates jsonb; request_id uuid;
 sent timestamptz:=coalesce((p_update->>'sentAt')::timestamptz,now());
begin
 if p_update->>'chatType'<>'private' or uid<>chat then return; end if;
 select * into st from staffing_staff where telegram_user_id=uid and active for update;
 if st.id is null then
  insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Akun belum tertaut atau tidak aktif. Minta undangan pribadi dari manager.')); return;
 end if;
 if k='cancel' then
  delete from staffing_private_flows where user_id=uid;
  insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text',case when found then 'Draft pengajuan dibatalkan. Pengajuan yang sudah dikirim tetap tersimpan untuk review manager.' else 'Tidak ada draft pengajuan aktif. /batal tidak menghapus pengajuan, jadwal, atau absensi yang sudah tercatat.' end)); return;
 end if;
 if sent>now()+interval '1 minute' or sent<now()-interval '30 minutes' then return; end if;
 money:=staffing_staff_money(st.id);
 available:=greatest(coalesce((money->>'available')::numeric,0)-coalesce((select sum(amount) from staffing_requests where staff_id=st.id and kind='cash_advance' and status='pending'),0),0);
 if k='request_start' then
  if p_update->>'choice' not in('leave') then return; end if;
  if p_update->>'choice'='cash' and available<=0 then
   insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Belum ada jatah kasbon yang bisa diajukan. Periksa plafon, utang, dan pengajuan pending melalui /kasbon.')); return;
  end if;
  insert into staffing_private_flows(user_id,staff_id,chat_id,step,data) values(uid,st.id,chat,case when p_update->>'choice'='cash' then 'amount' else 'type' end,case when p_update->>'choice'='cash' then '{"kind":"cash_advance"}'::jsonb else '{}'::jsonb end)
  on conflict(user_id) do update set staff_id=st.id,step=excluded.step,data=excluded.data,prompt_message_id=null,created_at=now(),expires_at=now()+interval '30 minutes';
  perform staffing_private_prompt(uid); return;
 end if;
 select * into f from staffing_private_flows where user_id=uid and staff_id=st.id for update;
 if f.user_id is null then return; end if;
 if f.expires_at<=now() then
  delete from staffing_private_flows where user_id=uid;
  insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Pengajuan kedaluwarsa. Mulai kembali dari /izin.')); return;
 end if;
 if sent<f.created_at-interval '1 second' then return; end if;
 if k='request_pick' then
  if f.token is distinct from p_update->>'flowToken' then return; end if;
  if f.step='type' and p_update->>'choice'='type' and p_update->>'entityId' in('paid_leave','sick') then
   update staffing_private_flows set step='start',data=jsonb_build_object('kind',p_update->>'entityId') where user_id=uid;
   perform staffing_private_prompt(uid); return;
  end if;
  if f.step<>'confirm' or p_update->>'choice'<>'send' or p_update->>'entityId'<>'yes' then return; end if;
  if f.data->>'kind'='cash_advance' then
   amount_value:=(f.data->>'amount')::bigint;
   if amount_value<=0 or amount_value>available then
    update staffing_private_flows set step='amount',data='{"kind":"cash_advance"}' where user_id=uid;
    perform staffing_private_prompt(uid,'Jatah berubah atau tidak mencukupi. Masukkan ulang nominal.'); return;
   end if;
   insert into staffing_requests(staff_id,kind,amount,reason,created_by) values(st.id,'cash_advance',amount_value,'Pengajuan kasbon melalui Telegram','telegram:'||uid) returning id into request_id;
  else
   if f.data->>'evidence_file_id' is null or length(trim(coalesce(f.data->>'reason','')))<5 then return; end if;
   select jsonb_agg(jsonb_build_object('date',day::date,'units',1) order by day) into dates from generate_series((f.data->>'start_date')::date::timestamp,(f.data->>'end_date')::date::timestamp,interval '1 day')day;
   if f.data->>'kind'='paid_leave' and coalesce((money->>'leave_balance')::numeric,0)-coalesce((select sum(days) from staffing_requests where staff_id=st.id and payment_mode='leave' and status='pending'),0)<jsonb_array_length(dates) then
    perform staffing_private_prompt(uid,'Saldo izin tidak cukup. Hubungi manager atau batalkan pengajuan.'); return;
   end if;
   if exists(select 1 from staffing_requests r where r.staff_id=st.id and r.kind<>'cash_advance' and r.status in('pending','approved') and r.start_date<=(f.data->>'end_date')::date and r.end_date>=(f.data->>'start_date')::date) then
    perform staffing_private_prompt(uid,'Tanggal bertabrakan dengan pengajuan lain. /batal lalu pilih tanggal lain atau hubungi manager.'); return;
   end if;
   insert into staffing_requests(staff_id,kind,payment_mode,start_date,end_date,leave_dates,days,reason,created_by,evidence_file_id,evidence_unique_id,evidence_mime,evidence_chat_id,evidence_message_id,evidence_sent_at)
   values(st.id,f.data->>'kind',case f.data->>'kind' when 'paid_leave' then 'leave' when 'sick' then 'sick' else 'none' end,(f.data->>'start_date')::date,(f.data->>'end_date')::date,dates,jsonb_array_length(dates),f.data->>'reason','telegram:'||uid,f.data->>'evidence_file_id',f.data->>'evidence_unique_id',f.data->>'evidence_mime',chat,(f.data->>'evidence_message_id')::bigint,(f.data->>'evidence_sent_at')::timestamptz) returning id into request_id;
  end if;
  delete from staffing_private_flows where user_id=uid;
  insert into staffing_audit(actor,action,entity_id,details)values('telegram:'||uid,'submit_personal_request',request_id::text,jsonb_build_object('kind',f.data->>'kind'));
  insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Pengajuan terkirim. Menunggu persetujuan manager.')); return;
 end if;
 if f.prompt_message_id is null or (p_update->>'replyTo'is not null and(p_update->>'replyTo')::bigint is distinct from f.prompt_message_id)then return;end if;
 if k='request_input' then
  if f.step='amount' then
   if input is null or input!~'^[0-9]{1,13}$' then perform staffing_private_prompt(uid,'Masukkan rupiah dalam angka bulat saja, tanpa titik, koma, atau instruksi lain.'); return; end if;
   amount_value:=input::bigint;
   if amount_value<=0 or amount_value>available then perform staffing_private_prompt(uid,'Nominal harus lebih dari nol dan tidak melebihi jatah tersedia.'); return; end if;
   update staffing_private_flows set step='confirm',data=data||jsonb_build_object('amount',amount_value) where user_id=uid;
  elsif f.step in('start','end') then
   begin
    if input is null or input!~'^\d{2}/\d{2}/\d{4}$' then raise exception 'Invalid date'; end if;
    d:=to_date(input,'DD/MM/YYYY');
    if to_char(d,'DD/MM/YYYY')<>input then raise exception 'Invalid date'; end if;
   exception when others then perform staffing_private_prompt(uid,'Tanggal tidak valid. Gunakan DD/MM/YYYY, contoh 15/11/2026.'); return; end;
   if d<(now()at time zone(select time_zone from stores where id=st.home_store_id))::date-30 or d>(now()at time zone(select time_zone from stores where id=st.home_store_id))::date+365 then
    perform staffing_private_prompt(uid,'Tanggal harus dalam 30 hari terakhir sampai 1 tahun ke depan menurut zona waktu store.'); return;
   end if;
   if f.step='start' then update staffing_private_flows set step='end',data=data||jsonb_build_object('start_date',d) where user_id=uid;
   else
    if d<(f.data->>'start_date')::date or d-(f.data->>'start_date')::date>61 then perform staffing_private_prompt(uid,'Tanggal akhir harus setelah / sama dengan tanggal mulai, maksimal 62 hari.'); return; end if;
    update staffing_private_flows set step='reason',data=data||jsonb_build_object('end_date',d) where user_id=uid;
   end if;
  elsif f.step='reason' then
   if length(coalesce(input,''))not between 5 and 2000 then perform staffing_private_prompt(uid,'Alasan wajib 5–2000 karakter.'); return; end if;
   update staffing_private_flows set step='evidence',data=data||jsonb_build_object('reason',input) where user_id=uid;
  else return; end if;
 elsif k in('photo','document') and f.step='evidence' then
  if length(coalesce(p_update->>'fileId',''))not between 1 and 1024 or length(coalesce(p_update->>'fileUniqueId',''))not between 1 and 256 then return; end if;
  if k='document' and (coalesce(p_update->>'fileMime','')not in('image/jpeg','image/png','application/pdf') or coalesce((p_update->>'fileSize')::bigint,0)not between 1 and 10485760) then return; end if;
  update staffing_private_flows set step='confirm',data=data||jsonb_build_object('evidence_file_id',p_update->>'fileId','evidence_unique_id',p_update->>'fileUniqueId','evidence_mime',case k when 'photo' then 'image/jpeg' else p_update->>'fileMime' end,'evidence_message_id',(p_update->>'messageId')::bigint,'evidence_sent_at',sent) where user_id=uid;
 else return; end if;
 perform staffing_private_prompt(uid);
end $$;

create or replace function staffing_private_prompt(p_user bigint,p_hint text default '') returns void language plpgsql set search_path=public as $$
declare f staffing_private_flows; body text; keys jsonb:='[]'; row record; money jsonb; available numeric;
begin
 if exists(select 1 from staffing_private_flows where user_id=p_user and data->>'kind'='overtime')then perform staffing_overtime_prompt(p_user,p_hint);return;end if;
 update staffing_private_flows set token=substr(replace(gen_random_uuid()::text,'-',''),1,12),prompt_message_id=null where user_id=p_user and expires_at>now() returning * into f;
 if f.user_id is null then return; end if;
 case f.step
 when 'type' then
  body:='Pilih Izin atau Sakit.';
  for row in select * from(values('paid_leave','Izin'),('sick','Sakit')) as t(id,label) loop
   keys:=keys||jsonb_build_array(jsonb_build_array(jsonb_build_object('text',row.label,'callback_data','rf:type:'||f.token||':'||row.id)));
  end loop;
 when 'amount' then
  money:=staffing_staff_money(f.staff_id);
  available:=greatest(coalesce((money->>'available')::numeric,0)-coalesce((select sum(amount) from staffing_requests where staff_id=f.staff_id and kind='cash_advance' and status='pending'),0),0);
  body:='Masukkan nominal kasbon dalam rupiah, angka saja (contoh 50000).'||E'\nBisa diajukan sekarang: Rp'||available||E'\nPengajuan pending ikut diperhitungkan agar tidak melebihi plafon.';
 when 'start' then body:='Tanggal mulai? Kirim DD/MM/YYYY.';
 when 'end' then body:='Tanggal selesai? Kirim DD/MM/YYYY. Untuk satu hari, isi tanggal yang sama.';
 when 'reason' then body:='Apa alasan izin / sakit?';
 when 'evidence' then body:='Kirim bukti berupa foto atau PDF/JPG/PNG (maksimal 10 MB).';
 when 'confirm' then
  if f.data->>'kind'='cash_advance' then body:='Ajukan kasbon Rp'||(f.data->>'amount')||'?';
  else body:='Pengajuan '||case f.data->>'kind'when 'sick'then 'sakit'else 'izin'end||E'\n\n'||to_char((f.data->>'start_date')::date,'DD/MM')||case when f.data->>'end_date'<>f.data->>'start_date'then ' - '||to_char((f.data->>'end_date')::date,'DD/MM')else ''end||E'\nAlasan: '||(f.data->>'reason')||E'\nBukti terlampir.'; end if;
  keys:=jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Kirim pengajuan','callback_data','rf:send:'||f.token||':yes')));
 end case;
 body:=coalesce(nullif(p_hint,'' )||E'\n\n','')||body;keys:=keys||jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Batal','callback_data','rf:cancel:'||f.token||':yes')));
 insert into staffing_outbox(payload,private_flow_token) values(jsonb_build_object('chat_id',p_user,'text',body,'reply_markup',jsonb_build_object('inline_keyboard',keys)),f.token);
end $$;

-- OVERTIME AND DISPATCHER
create function staffing_overtime_context(p_session uuid)returns jsonb language plpgsql stable set search_path=public as $$
declare se staffing_sessions;sh staffing_shifts;items jsonb:='[]';v_in timestamptz;v_out timestamptz;v_zone text;begin
 select * into se from staffing_sessions where id=p_session;select * into sh from staffing_shifts where id=se.shift_id;
 if se.id is null or se.staff_id<>sh.staff_id then return null;end if;
 select time_zone into v_zone from stores where id=sh.store_id;v_in:=coalesce(se.corrected_in_at,se.check_in_at);v_out:=coalesce(se.corrected_out_at,se.check_out_at);
 if v_out is not null then
  if v_in<sh.starts_at and least(v_out,sh.starts_at)>v_in then items:=items||jsonb_build_array(jsonb_build_object('starts_at',v_in,'ends_at',least(v_out,sh.starts_at)));end if;
  if v_out>sh.ends_at and v_out>greatest(v_in,sh.ends_at)then items:=items||jsonb_build_array(jsonb_build_object('starts_at',greatest(v_in,sh.ends_at),'ends_at',v_out));end if;
 end if;
 return jsonb_build_object('session_id',se.id,'staff_id',se.staff_id,'store_id',sh.store_id,'day',(sh.starts_at at time zone v_zone)::date,'time_zone',v_zone,'intervals',items,'closed',v_out is not null,'verification_state',se.verification_state,
 'version',md5(jsonb_build_object('session',se.id,'staff',se.staff_id,'shift_staff',sh.staff_id,'start',sh.starts_at,'end',sh.ends_at,'actual_in',v_in,'actual_out',v_out)::text),'payroll_locked',(staffing_attendance_metadata(se.id)->>'payroll_locked')::boolean);
end $$;
create function staffing_overtime_prompt(p_user bigint,p_hint text default '')returns void language plpgsql set search_path=public as $$
declare f staffing_private_flows;body text;keys jsonb:='[]';q record;item jsonb;zone text;begin
 update staffing_private_flows set token=substr(replace(gen_random_uuid()::text,'-',''),1,12),prompt_message_id=null where user_id=p_user and data->>'kind'='overtime'and expires_at>now()returning * into f;
 if f.user_id is null then return;end if;
 case f.step
 when 'overtime_date'then body:='Tanggal lembur? Kirim DD/MM/YYYY sesuai tanggal mulai shift.';
 when 'overtime_session'then
  body:='Pilih shift yang ingin diajukan.';
  for q in select se.id,sh.starts_at,sh.ends_at,s.time_zone from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id join stores s on s.id=sh.store_id where se.staff_id=f.staff_id and(sh.starts_at at time zone s.time_zone)::date=(f.data->>'day')::date and coalesce(se.corrected_out_at,se.check_out_at)is not null order by sh.starts_at limit 12 loop
   if jsonb_array_length(staffing_overtime_context(q.id)->'intervals')>0 then keys:=keys||jsonb_build_array(jsonb_build_array(jsonb_build_object('text',staffing_short_range(q.starts_at,q.ends_at,q.time_zone),'callback_data','rf:session:'||f.token||':'||q.id)));end if;
  end loop;
 when 'overtime_reason'then body:='Apa alasan lemburnya?';
 else
  zone:=f.data->'context'->>'time_zone';body:='Anda lembur pada jam';
  for item in select * from jsonb_array_elements(f.data->'context'->'intervals')loop body:=body||E'\n'||staffing_short_range((item->>'starts_at')::timestamptz,(item->>'ends_at')::timestamptz,zone);end loop;
  body:=body||E'\n\nAlasan: '||(f.data->>'reason');keys:=jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Kirim pengajuan','callback_data','rf:send:'||f.token||':yes')));
 end case;
 keys:=keys||jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Batal','callback_data','rf:cancel:'||f.token||':yes')));
 insert into staffing_outbox(payload,private_flow_token)values(jsonb_build_object('chat_id',p_user,'text',coalesce(nullif(p_hint,'')||E'\n\n','')||body,'reply_markup',jsonb_build_object('inline_keyboard',keys)),f.token);
end $$;
create function staffing_overtime_request(p_update jsonb)returns void language plpgsql set search_path=public as $$
declare uid bigint:=(p_update->>'userId')::bigint;st staffing_staff;f staffing_private_flows;context jsonb;d date;sid uuid;amount integer;input text:=trim(p_update->>'inputText');r uuid;begin
 select * into st from staffing_staff where telegram_user_id=uid and active for update;if st.id is null then return;end if;
 if p_update->>'kind'='request_start'then
  insert into staffing_private_flows(user_id,staff_id,chat_id,step,data)values(uid,st.id,uid,'overtime_date','{"kind":"overtime"}')on conflict(user_id)do update set staff_id=st.id,step='overtime_date',data='{"kind":"overtime"}',prompt_message_id=null,created_at=now(),expires_at=now()+interval '30 minutes';perform staffing_overtime_prompt(uid);return;
 end if;
 select * into f from staffing_private_flows where user_id=uid and staff_id=st.id and data->>'kind'='overtime'for update;
 if f.user_id is null then return;end if;
 if f.expires_at<=now()then delete from staffing_private_flows where user_id=uid;insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',uid,'text','Pengajuan kedaluwarsa. Mulai kembali dari /lembur.'));return;end if;
 if coalesce((p_update->>'sentAt')::timestamptz,now())<f.created_at-interval '1 second'then return;end if;
 if p_update->>'kind'='request_pick'then
  if p_update->>'flowToken'is distinct from f.token then return;end if;
  if p_update->>'choice'='session'and f.step='overtime_session'then sid:=(p_update->>'entityId')::uuid;
   select staffing_overtime_context(se.id)into context from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id join stores s on s.id=sh.store_id where se.id=sid and se.staff_id=st.id and(sh.starts_at at time zone s.time_zone)::date=(f.data->>'day')::date;
   if context is null or jsonb_array_length(context->'intervals')=0 or(context->>'payroll_locked')::boolean then perform staffing_overtime_prompt(uid,'Shift tidak tersedia.');return;end if;
   update staffing_private_flows set step='overtime_reason',data=data||jsonb_build_object('context',context)where user_id=uid;perform staffing_overtime_prompt(uid);return;
  end if;
  if p_update->>'choice'<>'send'or f.step<>'overtime_confirm'then return;end if;
  sid:=(f.data->'context'->>'session_id')::uuid;context:=staffing_overtime_context(sid);
  if context is null or context->>'staff_id'<>st.id::text or context->>'version'is distinct from f.data->'context'->>'version'or(context->>'payroll_locked')::boolean or jsonb_array_length(context->'intervals')=0 then
   delete from staffing_private_flows where user_id=uid;insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',uid,'text','Absensi atau jadwal berubah. Ajukan ulang melalui /lembur.'));return;end if;
  if exists(select 1 from staffing_overtime_requests where session_id=sid and status in('pending','approved'))then perform staffing_overtime_prompt(uid,'Lembur untuk shift ini sudah diajukan.');return;end if;
  insert into staffing_overtime_requests(staff_id,session_id,store_id,reason,intervals,snapshot_version)values(st.id,sid,(context->>'store_id')::uuid,f.data->>'reason',context->'intervals',context->>'version')returning id into r;
  insert into staffing_audit(actor,action,entity_id,details)values('telegram:'||uid,'request_overtime',r::text,jsonb_build_object('session_id',sid,'intervals',context->'intervals'));
  delete from staffing_private_flows where user_id=uid;insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',uid,'text','Pengajuan lembur terkirim. Menunggu persetujuan manager.'));return;
 end if;
 if p_update->>'kind'<>'request_input'or f.prompt_message_id is null or(p_update->>'replyTo'is not null and(p_update->>'replyTo')::bigint<>f.prompt_message_id)then return;end if;
 if f.step='overtime_date'then
  begin if input!~'^\d{2}/\d{2}/\d{4}$'then raise exception 'date';end if;d:=to_date(input,'DD/MM/YYYY');if to_char(d,'DD/MM/YYYY')<>input then raise exception 'date';end if;exception when others then perform staffing_overtime_prompt(uid,'Gunakan tanggal DD/MM/YYYY.');return;end;
  select count(*),(array_agg(se.id order by sh.starts_at))[1]into amount,sid from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id join stores s on s.id=sh.store_id where se.staff_id=st.id and(sh.starts_at at time zone s.time_zone)::date=d and coalesce(se.corrected_out_at,se.check_out_at)is not null and jsonb_array_length(staffing_overtime_context(se.id)->'intervals')>0 and not(staffing_overtime_context(se.id)->>'payroll_locked')::boolean and se.verification_state<>'rejected';
  if amount=0 then perform staffing_overtime_prompt(uid,'Belum ada kelebihan waktu dengan absensi pulang pada tanggal itu.');return;end if;
  context:=case when amount=1 then staffing_overtime_context(sid)else null end;
  update staffing_private_flows set step=case when amount=1 then 'overtime_reason'else 'overtime_session'end,data=data||jsonb_build_object('day',d,'context',context)where user_id=uid;
 elsif f.step='overtime_reason'then
  if length(coalesce(input,''))not between 5 and 2000 then perform staffing_overtime_prompt(uid,'Isi alasan minimal 5 karakter.');return;end if;
  update staffing_private_flows set step='overtime_confirm',data=data||jsonb_build_object('reason',input)where user_id=uid;
 else return;end if;
 perform staffing_overtime_prompt(uid);
end $$;
create function staffing_private_request(p_update jsonb)returns void language plpgsql set search_path=public as $$
declare f staffing_private_flows;uid bigint:=(p_update->>'userId')::bigint;begin
 if p_update->>'chatType'<>'private'or uid<>(p_update->>'chatId')::bigint then return;end if;
 select * into f from staffing_private_flows where user_id=uid;
 if f.data->>'kind'='cash_advance'and p_update->>'kind'<>'cancel'then perform staffing_bot_private(uid,uid,'menu');return;end if;
 if p_update->>'kind'='request_pick'and p_update->>'choice'='cancel'then
  if f.token is distinct from p_update->>'flowToken'then return;end if;
  perform staffing_private_request_legacy_v13(p_update||jsonb_build_object('kind','cancel'));return;
 end if;
 if p_update->>'kind'='request_start'and p_update->>'choice'='cash'then perform staffing_bot_private(uid,uid,'menu');return;end if;
 if(p_update->>'kind'='request_start'and p_update->>'choice'='overtime')or(f.data->>'kind'='overtime'and p_update->>'kind'<>'cancel')then perform staffing_overtime_request(p_update);return;end if;
 perform staffing_leave_request_v13(p_update);
end $$;

alter table staffing_time_approvals add column overtime_request_id uuid references staffing_overtime_requests(id);
create function staffing_overtime_queue(p_actor uuid,p_bootstrap boolean,p_store uuid default null)returns jsonb language plpgsql stable set search_path=public as $$
declare scope uuid[];begin scope:=staffing_actor_stores(p_actor,p_bootstrap);if p_store is not null and not p_store=any(scope)then raise exception 'FORBIDDEN';end if;
 return coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('full_name',st.full_name,'store_name',s.name,'time_zone',s.time_zone,'day',c.value->>'day','valid',c.value->>'version'=r.snapshot_version and not(c.value->>'payroll_locked')::boolean,'attendance_confirmed',c.value->>'verification_state'='confirmed')order by r.created_at)from staffing_overtime_requests r join staffing_staff st on st.id=r.staff_id join stores s on s.id=r.store_id cross join lateral(select staffing_overtime_context(r.session_id)as value)c where r.status='pending'and r.store_id=any(scope)and st.home_store_id=any(scope)and(p_store is null or r.store_id=p_store)),'[]');
end $$;
create function staffing_decide_overtime(p_actor uuid,p_bootstrap boolean,p_request uuid,p_decision text,p_note text default '')returns jsonb language plpgsql set search_path=public as $$
declare r staffing_overtime_requests;st staffing_staff;c jsonb;item jsonb;scope uuid[];uid bigint;actor text:=coalesce(p_actor::text,'bootstrap-super-admin');begin
 scope:=staffing_actor_stores(p_actor,p_bootstrap);select * into r from staffing_overtime_requests where id=p_request;
 st:=staffing_require_staff(p_actor,p_bootstrap,r.staff_id);if r.id is null or not r.store_id=any(scope)then raise exception 'FORBIDDEN';end if;
 perform id from staffing_staff where id=st.id for update;select * into r from staffing_overtime_requests where id=r.id for update;
 if p_decision is null or p_decision not in('approved','rejected')or length(coalesce(p_note,''))>1000 then raise exception 'Pilih keputusan lembur yang valid';end if;
 if r.status=p_decision then return jsonb_build_object('id',r.id,'status',r.status);end if;if r.status<>'pending'then raise exception 'Pengajuan sudah selesai';end if;
 c:=staffing_overtime_context(r.session_id);
 if p_decision='approved'then
  if c is null or c->>'version'<>r.snapshot_version or(c->>'payroll_locked')::boolean then raise exception 'Absensi atau jadwal berubah / payroll sudah final. Tolak dan minta pengajuan baru';end if;
  if c->>'verification_state'<>'confirmed'then raise exception 'Konfirmasi review absensi terlebih dahulu';end if;
  for item in select * from jsonb_array_elements(r.intervals)loop
   if exists(select 1 from staffing_time_approvals where session_id=r.session_id and kind='overtime'and starts_at<(item->>'ends_at')::timestamptz and ends_at>(item->>'starts_at')::timestamptz)then raise exception 'Waktu lembur sudah memiliki persetujuan';end if;
   insert into staffing_time_approvals(session_id,kind,starts_at,ends_at,reason,created_by,overtime_request_id)values(r.session_id,'overtime',(item->>'starts_at')::timestamptz,(item->>'ends_at')::timestamptz,r.reason,actor,r.id);
  end loop;
 elsif length(trim(coalesce(p_note,'')))<5 then raise exception 'Isi alasan penolakan minimal 5 karakter';end if;
 update staffing_overtime_requests set status=p_decision,decided_at=now(),decided_by=actor,decision_note=trim(p_note)where id=r.id;
 insert into staffing_audit(actor,action,entity_id,details)values(actor,'decide_overtime',r.id::text,jsonb_build_object('decision',p_decision,'note',p_note,'intervals',r.intervals));
 select telegram_user_id into uid from staffing_staff where id=st.id and active;
 if uid is not null then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',uid,'text','Pengajuan lembur '||case p_decision when 'approved'then 'disetujui'else 'ditolak'end||' manager.'||case when nullif(trim(p_note),'')is not null then E'\n'||p_note else ''end));end if;
 return jsonb_build_object('id',r.id,'status',p_decision);
end $$;
create function staffing_invalidate_overtime()returns trigger language plpgsql set search_path=public as $$
declare r staffing_overtime_requests;begin
 if coalesce(new.corrected_in_at,new.check_in_at)is not distinct from coalesce(old.corrected_in_at,old.check_in_at)and coalesce(new.corrected_out_at,new.check_out_at)is not distinct from coalesce(old.corrected_out_at,old.check_out_at)then return new;end if;
 for r in select * from staffing_overtime_requests where session_id=new.id and status in('pending','approved')for update loop
  delete from staffing_time_approvals where overtime_request_id=r.id;
  update staffing_overtime_requests set status='stale',decided_at=now(),decision_note='Waktu absensi dikoreksi; ajukan kembali'where id=r.id;
  insert into staffing_audit(actor,action,entity_id,details)values(coalesce(new.reviewed_by,'system'),'invalidate_overtime',r.id::text,jsonb_build_object('session_id',new.id));insert into staffing_outbox(payload)select jsonb_build_object('chat_id',telegram_user_id,'text','Waktu absensi dikoreksi. Ajukan ulang lembur melalui /lembur.')from staffing_staff where id=r.staff_id and active and telegram_user_id is not null;
 end loop;return new;
end $$;
create trigger staffing_overtime_time_guard after update on staffing_sessions for each row execute function staffing_invalidate_overtime();

alter function staffing_activity(uuid,boolean,uuid,date)rename to staffing_activity_v13;
create function staffing_activity(p_actor uuid,p_bootstrap boolean,p_store uuid default null,p_day date default null)returns jsonb language sql stable set search_path=public as $$
 select staffing_activity_v13(p_actor,p_bootstrap,p_store,p_day)||jsonb_build_object('overtime_requests',staffing_overtime_queue(p_actor,p_bootstrap,p_store));
$$;
-- Store-side read models expose the new payroll policy flag alongside existing metadata.
alter function staffing_attendance_metadata(uuid)rename to staffing_attendance_metadata_v13;
create function staffing_attendance_metadata(p_session uuid)returns jsonb language sql stable set search_path=public as $$
 select staffing_attendance_metadata_v13(p_session)||jsonb_build_object('overtime_request_required',se.overtime_request_required)from staffing_sessions se where se.id=p_session;
$$;

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
 when 'help'then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Grup: /masuk, /pulang, /jadwal, /tukar, /batal, /bantuan. Verifikasi absen dilanjutkan di chat pribadi bot.'));
 else return;end case;
end $$;

alter function staffing_payroll_source(uuid,boolean,uuid,date,date)rename to staffing_payroll_source_v13;
create function staffing_payroll_source(p_actor uuid,p_bootstrap boolean,p_staff uuid,p_from date,p_to date)returns jsonb language plpgsql stable set search_path=public as $$
declare source jsonb;v_input jsonb;begin
 source:=staffing_payroll_source_v13(p_actor,p_bootstrap,p_staff,p_from,p_to);
 v_input:=source->'input'||jsonb_build_object('pending_leave',coalesce((select jsonb_agg(to_jsonb(r))from staffing_requests r where r.staff_id=p_staff and r.kind<>'cash_advance'and r.status='pending'and r.start_date<=p_to and r.end_date>=p_from),'[]'),'pending_overtime',coalesce((select jsonb_agg(to_jsonb(o))from staffing_overtime_requests o where o.staff_id=p_staff and o.status='pending'and exists(select 1 from jsonb_array_elements(o.intervals)i where(i->>'starts_at')::timestamptz<(source->'input'->>'range_end')::timestamptz and(i->>'ends_at')::timestamptz>(source->'input'->>'range_start')::timestamptz)),'[]'),'absence_fines',coalesce((select jsonb_agg(to_jsonb(f)order by f.id)from staffing_absence_fines f where f.staff_id=p_staff and f.voided_at is null and f.fine_date between p_from and p_to),'[]'));
 return jsonb_build_object('input',v_input,'version',md5(v_input::text));
end $$;
create table staffing_absence_fines(
 id uuid primary key default gen_random_uuid(),staff_id uuid not null references staffing_staff(id),request_id uuid not null references staffing_requests(id),fine_date date not null,
 amount bigint not null check(amount between 1 and 1000000000),reason text not null check(length(trim(reason))between 5 and 2000),created_by text not null,created_at timestamptz not null default now(),
 client_id uuid not null unique,data_hash text not null,voided_at timestamptz,voided_by text,void_reason text
);
create unique index staffing_one_active_absence_fine on staffing_absence_fines(request_id)where voided_at is null;
alter table staffing_absence_fines enable row level security;
revoke all on staffing_absence_fines from public,anon,authenticated;grant all on staffing_absence_fines to service_role;
create function staffing_request_fines(p_actor uuid,p_bootstrap boolean,p_request uuid)returns jsonb language plpgsql stable set search_path=public as $$
declare r staffing_requests;begin select * into r from staffing_requests where id=p_request;perform staffing_require_staff(p_actor,p_bootstrap,r.staff_id);
 return coalesce((select jsonb_agg(to_jsonb(f)||jsonb_build_object('payroll_locked',exists(select 1 from staffing_payrolls p where p.staff_id=f.staff_id and f.fine_date between p.period_start and p.period_end))order by f.created_at desc)from staffing_absence_fines f where f.request_id=r.id),'[]');end $$;
create function staffing_record_absence_fine(p_actor uuid,p_bootstrap boolean,p_data jsonb)returns jsonb language plpgsql set search_path=public as $$
declare r staffing_requests;st staffing_staff;f staffing_absence_fines;scope uuid[];day date;amount bigint;note text;actor text:=coalesce(p_actor::text,'bootstrap-super-admin');key uuid:=(p_data->>'client_id')::uuid;hash text:=md5((p_data-'client_id')::text);begin
 select * into r from staffing_requests where id=(p_data->>'request_id')::uuid;st:=staffing_require_staff(p_actor,p_bootstrap,r.staff_id);scope:=staffing_actor_stores(p_actor,p_bootstrap);
 perform id from staffing_staff where id=st.id for update;select * into r from staffing_requests where id=r.id for update;
 select * into f from staffing_absence_fines where client_id=key;
 if f.id is not null then if f.created_by<>actor or f.data_hash<>hash then raise exception 'Identitas perubahan sudah dipakai';end if;return to_jsonb(f);end if;
 if r.status<>'rejected'or r.kind='cash_advance'then raise exception 'Denda hanya dapat dicatat setelah pengajuan izin / sakit ditolak dan ketidakhadiran diverifikasi';end if;
 if coalesce((p_data->>'verified')::boolean,false)is not true then raise exception 'Konfirmasi verifikasi ketidakhadiran dan dasar denda';end if;
 day:=(p_data->>'fine_date')::date;amount:=(p_data->>'amount')::bigint;note:=trim(p_data->>'reason');
 if key is null or day is null or amount is null or amount not between 1 and 1000000000 or length(coalesce(note,''))not between 5 and 2000 or not exists(select 1 from jsonb_array_elements(r.leave_dates)d where(d->>'date')::date=day and(d->>'units')::numeric>0)then raise exception 'Periksa tanggal kasus, nominal, dan alasan denda';end if;
 if exists(select 1 from staffing_payrolls p where p.staff_id=st.id and day between p.period_start and p.period_end)then raise exception 'Periode payroll sudah final';end if;
 if exists(select 1 from staffing_requests x cross join lateral jsonb_array_elements(x.leave_dates)d where x.staff_id=st.id and x.status='approved'and x.kind<>'cash_advance'and(d->>'date')::date=day)then raise exception 'Tanggal ini memiliki izin / sakit yang disetujui';end if;
 if exists(select 1 from staffing_shifts sh join stores so on so.id=sh.store_id where sh.staff_id=st.id and(sh.starts_at at time zone so.time_zone)::date=day and not sh.store_id=any(scope))then raise exception 'FORBIDDEN';end if;
 if not exists(select 1 from staffing_shifts sh join stores so on so.id=sh.store_id where sh.staff_id=st.id and(sh.starts_at at time zone so.time_zone)::date=day and sh.ends_at<=now()and not exists(select 1 from staffing_sessions se where se.shift_id=sh.id and se.verification_state='confirmed'and coalesce(se.corrected_in_at,se.check_in_at)<=sh.starts_at and coalesce(se.corrected_out_at,se.check_out_at)>=sh.ends_at))then raise exception 'Tidak ditemukan waktu kerja terjadwal yang tidak dipenuhi pada tanggal ini';end if;
 if exists(select 1 from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id join stores so on so.id=sh.store_id where se.staff_id=st.id and(sh.starts_at at time zone so.time_zone)::date=day and(se.verification_state='pending'or coalesce(se.corrected_out_at,se.check_out_at)is null))then raise exception 'Selesaikan review absensi dan waktu pulang terlebih dahulu';end if;
 if exists(select 1 from staffing_absence_fines where request_id=r.id and voided_at is null)then raise exception 'Kasus ini sudah memiliki denda. Batalkan pencatatan lama untuk koreksi';end if;
 insert into staffing_absence_fines(staff_id,request_id,fine_date,amount,reason,created_by,client_id,data_hash)values(st.id,r.id,day,amount,note,actor,key,hash)returning * into f;
 insert into staffing_audit(actor,action,entity_id,details)values(actor,'record_absence_fine',f.id::text,to_jsonb(f));
 if st.telegram_user_id is not null and st.active then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',st.telegram_user_id,'text','Denda Rp'||amount||' untuk kasus tanggal '||to_char(day,'DD/MM/YYYY')||E'\n'||note));end if;
 return to_jsonb(f);
end $$;
create function staffing_void_absence_fine(p_actor uuid,p_bootstrap boolean,p_data jsonb)returns jsonb language plpgsql set search_path=public as $$
declare f staffing_absence_fines;note text:=trim(p_data->>'reason');actor text:=coalesce(p_actor::text,'bootstrap-super-admin');begin
 select * into f from staffing_absence_fines where id=(p_data->>'fine_id')::uuid;perform staffing_require_staff(p_actor,p_bootstrap,f.staff_id);perform id from staffing_staff where id=f.staff_id for update;select * into f from staffing_absence_fines where id=f.id for update;
 if f.voided_at is not null then return to_jsonb(f);end if;
 if length(coalesce(note,''))not between 5 and 2000 then raise exception 'Isi alasan pembatalan';end if;
 if exists(select 1 from staffing_payrolls where staff_id=f.staff_id and f.fine_date between period_start and period_end)then raise exception 'Periode payroll sudah final';end if;
 update staffing_absence_fines set voided_at=now(),voided_by=actor,void_reason=note where id=f.id returning * into f;
 insert into staffing_audit(actor,action,entity_id,details)values(actor,'void_absence_fine',f.id::text,to_jsonb(f));insert into staffing_outbox(payload)select jsonb_build_object('chat_id',telegram_user_id,'text','Pencatatan denda tanggal '||to_char(f.fine_date,'DD/MM/YYYY')||' dibatalkan.'||E'\n'||note)from staffing_staff where id=f.staff_id and active and telegram_user_id is not null;return to_jsonb(f);
end $$;
alter function staffing_staff_detail(uuid,boolean,uuid)rename to staffing_staff_detail_v14;
create function staffing_staff_detail(p_actor uuid,p_bootstrap boolean,p_staff uuid)returns jsonb language plpgsql stable set search_path=public as $$
declare detail jsonb;begin detail:=staffing_staff_detail_v14(p_actor,p_bootstrap,p_staff);return detail||jsonb_build_object('absence_fines',coalesce((select jsonb_agg(to_jsonb(f)order by f.created_at desc)from staffing_absence_fines f where f.staff_id=p_staff),'[]'));end $$;

revoke all on function staffing_request_fines(uuid,boolean,uuid),staffing_record_absence_fine(uuid,boolean,jsonb),staffing_void_absence_fine(uuid,boolean,jsonb),staffing_staff_detail_v14(uuid,boolean,uuid),staffing_staff_detail(uuid,boolean,uuid),staffing_payroll_source(uuid,boolean,uuid,date,date),staffing_payroll_source_v13(uuid,boolean,uuid,date,date),staffing_short_range(timestamptz,timestamptz,text,boolean),staffing_bot_escape(text),staffing_bot_mention(text,bigint),staffing_bot_private(bigint,bigint,text),staffing_bot_group_schedule(bigint,bigint,date),staffing_attendance_update_v13(jsonb),staffing_review_attendance(uuid,boolean,jsonb),staffing_swap_prompt(bigint,bigint),staffing_swap_pick(jsonb),staffing_shift_request_text(uuid),staffing_shift_request_notify(uuid,text),staffing_leave_request_v13(jsonb),staffing_private_prompt(bigint,text),staffing_overtime_context(uuid),staffing_overtime_prompt(bigint,text),staffing_overtime_request(jsonb),staffing_private_request(jsonb),staffing_overtime_queue(uuid,boolean,uuid),staffing_decide_overtime(uuid,boolean,uuid,text,text),staffing_invalidate_overtime(),staffing_activity(uuid,boolean,uuid,date),staffing_attendance_metadata(uuid),staffing_apply_update(jsonb),staffing_activity_v13(uuid,boolean,uuid,date),staffing_attendance_metadata_v13(uuid),staffing_bot_private_legacy_v13(bigint,bigint,text),staffing_private_request_legacy_v13(jsonb) from public,anon,authenticated;
grant execute on function staffing_request_fines(uuid,boolean,uuid),staffing_record_absence_fine(uuid,boolean,jsonb),staffing_void_absence_fine(uuid,boolean,jsonb),staffing_staff_detail_v14(uuid,boolean,uuid),staffing_staff_detail(uuid,boolean,uuid),staffing_payroll_source(uuid,boolean,uuid,date,date),staffing_payroll_source_v13(uuid,boolean,uuid,date,date),staffing_short_range(timestamptz,timestamptz,text,boolean),staffing_bot_escape(text),staffing_bot_mention(text,bigint),staffing_bot_private(bigint,bigint,text),staffing_bot_group_schedule(bigint,bigint,date),staffing_attendance_update_v13(jsonb),staffing_review_attendance(uuid,boolean,jsonb),staffing_swap_prompt(bigint,bigint),staffing_swap_pick(jsonb),staffing_shift_request_text(uuid),staffing_shift_request_notify(uuid,text),staffing_leave_request_v13(jsonb),staffing_private_prompt(bigint,text),staffing_overtime_context(uuid),staffing_overtime_prompt(bigint,text),staffing_overtime_request(jsonb),staffing_private_request(jsonb),staffing_overtime_queue(uuid,boolean,uuid),staffing_decide_overtime(uuid,boolean,uuid,text,text),staffing_invalidate_overtime(),staffing_activity(uuid,boolean,uuid,date),staffing_attendance_metadata(uuid),staffing_apply_update(jsonb),staffing_activity_v13(uuid,boolean,uuid,date),staffing_attendance_metadata_v13(uuid),staffing_bot_private_legacy_v13(bigint,bigint,text),staffing_private_request_legacy_v13(jsonb) to service_role;
commit;
