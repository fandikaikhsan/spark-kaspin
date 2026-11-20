begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local search_path=public;

alter table staffing_staff add column telegram_username text check(telegram_username is null or telegram_username~'^[a-z0-9_]{1,32}$');
alter table staffing_shifts add column overtime_only boolean not null default false;
-- One Telegram photo can substantiate several independently reviewed sessions.
alter table staffing_events drop constraint staffing_events_update_id_key;
create unique index staffing_event_update_session on staffing_events(update_id,session_id,kind);
create table staffing_attendance_batches(
 id uuid primary key default gen_random_uuid(),reporter_id uuid not null references staffing_staff(id),store_id uuid not null references stores(id),chat_id bigint not null check(chat_id<0),
 kind text not null check(kind in('check_in','check_out')),state text not null default 'confirmation'check(state in('confirmation','location','photo','completed','cancelled')),
 requested_at timestamptz not null,expires_at timestamptz not null,request_message_id bigint not null,prompt_message_id bigint,
 latitude numeric check(latitude between -90 and 90),longitude numeric check(longitude between -180 and 180),location_sent_at timestamptz,
 photo_file_id text,photo_unique_id text,photo_message_id bigint,photo_sent_at timestamptz,photo_update_id bigint,completed_at timestamptz
);
create index on staffing_attendance_batches(reporter_id,chat_id,expires_at);
alter table staffing_attempts add column attendance_batch_id uuid references staffing_attendance_batches(id);
create table staffing_unplanned_sessions(
 id uuid primary key default gen_random_uuid(),staff_id uuid not null references staffing_staff(id),store_id uuid not null references stores(id),
 check_in_at timestamptz not null,check_out_at timestamptz,corrected_in_at timestamptz,corrected_out_at timestamptz,
 check_in_reporter_id uuid not null references staffing_staff(id),check_out_reporter_id uuid references staffing_staff(id),
 in_batch_id uuid not null references staffing_attendance_batches(id),out_batch_id uuid references staffing_attendance_batches(id),
 outside_reason text not null,verification_state text not null default 'pending'check(verification_state in('pending','confirmed','rejected')),
 review_note text,reviewed_at timestamptz,reviewed_by text,resolution_session_id uuid unique references staffing_sessions(id),resolution_type text,resolved_at timestamptz,resolved_by text
);
create index staffing_unplanned_review_queue on staffing_unplanned_sessions(store_id,verification_state,check_in_at)where resolution_session_id is null;
create unique index staffing_one_open_unplanned on staffing_unplanned_sessions(staff_id)where check_out_at is null and corrected_out_at is null and resolution_session_id is null;
create table staffing_attendance_batch_members(
 batch_id uuid not null references staffing_attendance_batches(id),staff_id uuid not null references staffing_staff(id),shift_id uuid references staffing_shifts(id),
 session_id uuid references staffing_sessions(id),unplanned_id uuid references staffing_unplanned_sessions(id),shift_snapshot jsonb,outside_reason text,
 primary key(batch_id,staff_id)
);
create index staffing_batch_staff on staffing_attendance_batch_members(staff_id,batch_id);
create index staffing_active_batch_prompt on staffing_attendance_batches(chat_id,reporter_id,prompt_message_id)where state in('confirmation','location','photo');
alter table staffing_outbox add column attendance_batch_id uuid references staffing_attendance_batches(id);
do $$declare t text;begin foreach t in array array['staffing_attendance_batches','staffing_attendance_batch_members','staffing_unplanned_sessions']loop
 execute format('alter table %I enable row level security',t);execute format('revoke all on table %I from public,anon,authenticated',t);execute format('grant all on table %I to service_role',t);
end loop;end$$;

create function staffing_note_suffix(p_note text)returns text language sql immutable set search_path=public as $$
 select case when nullif(trim(p_note),'')is null then ''else E'\nCatatan: '||trim(p_note)end;
$$;
-- Only the verified Telegram sender can update a username alias. Identity and
-- permissions always remain tied to numeric Telegram IDs, never the alias.
create function staffing_sync_telegram_alias(p_user bigint,p_username text)returns void language plpgsql set search_path=public as $$
#variable_conflict use_column
begin
 if p_username is not null and p_username!~'^[A-Za-z0-9_]{1,32}$'then return;end if;
 if not exists(select 1 from staffing_staff where telegram_user_id=p_user and active)then return;end if;
 update staffing_staff set telegram_username=null where telegram_username=lower(p_username)and telegram_user_id<>p_user;
 update staffing_staff set telegram_username=lower(p_username)where telegram_user_id=p_user and active;
end$$;
create function staffing_attendance_directory(p_user bigint,p_chat bigint)returns jsonb language plpgsql stable set search_path=public as $$
#variable_conflict use_column
declare st staffing_staff;dest uuid;begin
 select * into st from staffing_staff where telegram_user_id=p_user and active;
 select g.store_id into dest from staffing_groups g join stores s on s.id=g.store_id where g.chat_id=p_chat and s.active;
 if st.id is null or dest is null or not(st.home_store_id=dest or exists(select 1 from staffing_shifts where staff_id=st.id and store_id=dest and starts_at<=now()+interval '1 day'and ends_at>=now()-interval '1 day'))then return '[]';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('user_id',s.telegram_user_id,'username',s.telegram_username)order by s.id)from staffing_staff s where s.active and s.telegram_user_id is not null and(s.home_store_id=dest or exists(select 1 from staffing_shifts where staff_id=s.id and store_id=dest and starts_at<=now()+interval '1 day'and ends_at>=now()-interval '1 day'))),'[]');
end$$;
create function staffing_batch_prompt(p_batch uuid)returns void language plpgsql set search_path=public as $$
#variable_conflict use_column

declare b staffing_attendance_batches;body text;r record;zone text;begin
 select * into b from staffing_attendance_batches where id=p_batch;
 select time_zone into zone from stores where id=b.store_id;
 body:='Konfirmasi '||case b.kind when 'check_in'then 'masuk'else 'pulang'end||E':\n';
 for r in select m.*,s.full_name from staffing_attendance_batch_members m join staffing_staff s on s.id=m.staff_id where m.batch_id=b.id order by s.full_name loop
  if r.shift_id is not null then body:=body||E'\n'||r.full_name||' · '||staffing_short_range((r.shift_snapshot->>'starts_at')::timestamptz,(r.shift_snapshot->>'ends_at')::timestamptz,zone);
  elsif b.kind='check_in'then
   body:=body||E'\nTidak ditemukan shift yang sesuai. Jadwal '||r.full_name||E':\n'||coalesce((select string_agg('- '||staffing_short_range(sh.starts_at,sh.ends_at,zone),E'\n'order by sh.starts_at)from(select * from staffing_shifts where staff_id=r.staff_id and store_id=b.store_id and ends_at>=b.requested_at-interval '1 day'order by starts_at limit 2)sh),'Belum ada jadwal.')||E'\nAnda yakin absen masuk?';
  else body:=body||E'\n'||r.full_name||' · Di luar jadwal';end if;
 end loop;
 body:=body||E'\n\nLanjutkan dengan lokasi dan foto. Bukti yang sama digunakan untuk semua nama di atas.';
 insert into staffing_outbox(payload,attendance_batch_id,expected_state)values(jsonb_build_object('chat_id',b.chat_id,'text',body,'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Benar, lanjutkan','callback_data','ba:c:'||b.id),jsonb_build_object('text','Batal','callback_data','ba:x:'||b.id))))),b.id,'confirmation');
end$$;
create function staffing_batch_start(p_update jsonb)returns void language plpgsql set search_path=public as $$
#variable_conflict use_column

declare st staffing_staff;subject staffing_staff;b staffing_attendance_batches;sh staffing_shifts;se staffing_sessions;outside staffing_unplanned_sessions;
 dest uuid;ids bigint[];uid bigint:=(p_update->>'userId')::bigint;chat bigint:=(p_update->>'chatId')::bigint;kind text;moment timestamptz:=coalesce((p_update->>'sentAt')::timestamptz,now());n integer;why text;begin
 select * into st from staffing_staff where telegram_user_id=uid and active;
 select g.store_id into dest from staffing_groups g join stores s on s.id=g.store_id where g.chat_id=chat and s.active;
 if st.id is null or dest is null then return;end if;
 if not(st.home_store_id=dest or exists(select 1 from staffing_shifts where staff_id=st.id and store_id=dest and starts_at<=now()+interval '1 day'and ends_at>=now()-interval '1 day'))then return;end if;
 if p_update->>'attendanceError'is not null then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Mention belum dapat diverifikasi. Pastikan rekan sudah tertaut, pernah mengirim /menu ke bot, dan username-nya benar. Bisa juga pilih mention nama rekan dari daftar anggota grup.'));return;end if;
 if moment>now()+interval '1 minute'or moment<now()-interval '10 minutes'then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Command kedaluwarsa. Ulangi /masuk atau /pulang.'));return;end if;
 kind:=case when p_update->>'kind'in('check_in','proxy_check_in')then 'check_in'else 'check_out'end;
 if p_update->>'attendeeCode'is not null then select array[telegram_user_id]into ids from staffing_staff where code=p_update->>'attendeeCode'and active;
 elsif jsonb_typeof(p_update->'attendeeIds')='array'then select array_agg(distinct value::bigint)into ids from jsonb_array_elements_text(p_update->'attendeeIds');
 else ids:=array[uid];end if;
 if ids is null or cardinality(ids)not between 1 and 10 or array_position(ids,null)is not null then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Pilih 1–10 staf aktif yang sudah tertaut. Gunakan saya untuk dirimu sendiri.'));return;end if;
 perform id from staffing_staff where telegram_user_id=any(ids)or id=st.id order by id for update;
 if(select count(*)from staffing_staff s where s.telegram_user_id=any(ids)and s.active and(s.home_store_id=dest or exists(select 1 from staffing_shifts where staff_id=s.id and store_id=dest and starts_at<=now()+interval '1 day'and ends_at>=now()-interval '1 day')))<>cardinality(ids)then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Ada staf yang belum tertaut, tidak aktif, atau bukan staf store ini. Periksa semua nama sebelum mengulang.'));return;end if;
 if exists(select 1 from staffing_attendance_batch_members m join staffing_attendance_batches active_batch on active_batch.id=m.batch_id join staffing_staff s on s.id=m.staff_id where s.telegram_user_id=any(ids)and active_batch.state in('confirmation','location','photo')and active_batch.expires_at>now()and active_batch.reporter_id<>st.id)
 or exists(select 1 from staffing_attempts a join staffing_staff s on s.id=a.staff_id where s.telegram_user_id=any(ids)and a.state in('confirmation','location','photo')and a.expires_at>now()and coalesce(a.submitted_by_staff_id,a.staff_id)<>st.id)then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Salah satu staf sedang diverifikasi oleh pelapor lain. Selesaikan proses itu dahulu.'));return;end if;
 for subject in select * from staffing_staff where telegram_user_id=any(ids)order by id loop
  if kind='check_in'and(exists(select 1 from staffing_sessions where staff_id=subject.id and coalesce(corrected_out_at,check_out_at)is null)or exists(select 1 from staffing_unplanned_sessions where staff_id=subject.id and resolution_session_id is null and coalesce(corrected_out_at,check_out_at)is null))then
   insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text',subject.full_name||' masih memiliki sesi terbuka. Gunakan /pulang dahulu. Tidak ada absensi kelompok yang disimpan.'));return;
  end if;
  if kind='check_out'and not(exists(select 1 from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id where se.staff_id=subject.id and sh.store_id=dest and coalesce(se.corrected_out_at,se.check_out_at)is null)or exists(select 1 from staffing_unplanned_sessions where staff_id=subject.id and store_id=dest and resolution_session_id is null and coalesce(corrected_out_at,check_out_at)is null))then
   insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text',subject.full_name||' belum memiliki catatan masuk di store ini. Absen pulang tidak dapat dilakukan. Tidak ada absensi kelompok yang disimpan.'));return;
  end if;
 end loop;
 delete from staffing_outbox where attendance_batch_id in(select id from staffing_attendance_batches where reporter_id=st.id and state in('confirmation','location','photo'))and delivered_at is null;
 update staffing_attendance_batches set state='cancelled'where reporter_id=st.id and state in('confirmation','location','photo');
 update staffing_attempts set state='cancelled'where coalesce(submitted_by_staff_id,staff_id)=st.id and state in('confirmation','location','photo');
 insert into staffing_attendance_batches(reporter_id,store_id,chat_id,kind,requested_at,expires_at,request_message_id)values(st.id,dest,chat,kind,moment,moment+interval '10 minutes',(p_update->>'messageId')::bigint)returning * into b;
 for subject in select * from staffing_staff where telegram_user_id=any(ids)order by id loop
  sh:=null;se:=null;outside:=null;why:=null;
  if kind='check_in'then
   select count(*)into n from staffing_shifts s where staff_id=subject.id and store_id=dest and starts_at<=moment+interval '2 hours'and ends_at>=moment and not exists(select 1 from staffing_sessions where shift_id=s.id);
   if n=1 then select * into sh from staffing_shifts s where staff_id=subject.id and store_id=dest and starts_at<=moment+interval '2 hours'and ends_at>=moment and not exists(select 1 from staffing_sessions where shift_id=s.id);end if;
   if sh.id is null then why:='Tidak ditemukan satu shift yang sesuai';end if;
   if sh.id is not null and exists(select 1 from staffing_requests r cross join lateral jsonb_array_elements(r.leave_dates)d join stores so on so.id=dest where r.staff_id=subject.id and r.status='approved'and r.kind<>'cash_advance'and sh.starts_at<(((d->>'date')::date+1)::timestamp at time zone so.time_zone)and sh.ends_at>((d->>'date')::date::timestamp at time zone so.time_zone))then sh:=null;why:='Jadwal memiliki izin / sakit yang disetujui';end if;
  else
   select s.* into se from staffing_sessions s join staffing_shifts s2 on s2.id=s.shift_id where s.staff_id=subject.id and s2.store_id=dest and coalesce(s.corrected_out_at,s.check_out_at)is null;
   if se.id is not null then select * into sh from staffing_shifts where id=se.shift_id;else select * into outside from staffing_unplanned_sessions where staff_id=subject.id and store_id=dest and resolution_session_id is null and coalesce(corrected_out_at,check_out_at)is null;end if;
  end if;
  insert into staffing_attendance_batch_members(batch_id,staff_id,shift_id,session_id,unplanned_id,shift_snapshot,outside_reason)values(b.id,subject.id,sh.id,se.id,outside.id,case when sh.id is not null then to_jsonb(sh)end,why);
 end loop;
 perform staffing_batch_prompt(b.id);
end$$;

create function staffing_materialize_batch_event(p_batch uuid,p_staff uuid,p_session uuid,p_shift uuid)returns uuid language plpgsql set search_path=public as $$
#variable_conflict use_column

declare b staffing_attendance_batches;attempt uuid;begin
 select * into b from staffing_attendance_batches where id=p_batch;
 insert into staffing_attempts(attendance_batch_id,staff_id,submitted_by_staff_id,shift_id,chat_id,kind,state,requested_at,request_message_id,expires_at,verification_chat_id,latitude,longitude,location_sent_at,photo_file_id,photo_unique_id,photo_message_id,photo_sent_at,completed_at)
 values(b.id,p_staff,b.reporter_id,p_shift,b.chat_id,b.kind,'completed',b.requested_at,b.request_message_id,b.expires_at,b.chat_id,b.latitude,b.longitude,b.location_sent_at,b.photo_file_id,b.photo_unique_id,b.photo_message_id,b.photo_sent_at,b.completed_at)returning id into attempt;
 insert into staffing_events(session_id,attempt_id,kind,effective_at,timestamp_source,message_id,update_id)values(p_session,attempt,b.kind,b.requested_at,'telegram_command',b.request_message_id,b.photo_update_id);
 return attempt;
end$$;
create function staffing_batch_abort(p_batch uuid,p_text text)returns void language plpgsql set search_path=public as $$
begin
 delete from staffing_outbox where attendance_batch_id=p_batch and delivered_at is null;
 update staffing_attendance_batches set state='cancelled'where id=p_batch;
 insert into staffing_outbox(payload)select jsonb_build_object('chat_id',chat_id,'text',p_text)from staffing_attendance_batches where id=p_batch;
end$$;
create function staffing_batch_continue(p_update jsonb,p_batch uuid)returns void language plpgsql set search_path=public as $$
#variable_conflict use_column

declare b staffing_attendance_batches;m staffing_attendance_batch_members;st staffing_staff;sh staffing_shifts;se staffing_sessions;outside staffing_unplanned_sessions;
 uid bigint:=(p_update->>'userId')::bigint;chat bigint:=(p_update->>'chatId')::bigint;k text:=p_update->>'kind';body text;buttons jsonb:='[]';zone text;moment timestamptz:=coalesce((p_update->>'sentAt')::timestamptz,now());begin
 select * into b from staffing_attendance_batches where id=p_batch and chat_id=chat and state in('confirmation','location','photo')for update;
 if b.id is null or not exists(select 1 from staffing_staff where id=b.reporter_id and telegram_user_id=uid and active)then return;end if;
 if k not in('batch_confirm','batch_cancel','cancel')and b.prompt_message_id is distinct from(p_update->>'replyTo')::bigint then return;end if;
 if k in('batch_cancel','cancel')or b.expires_at<now()or moment>b.expires_at then
  delete from staffing_outbox where attendance_batch_id=b.id and delivered_at is null;
  update staffing_attendance_batches set state='cancelled'where id=b.id;
  insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text',case when k in('batch_cancel','cancel')then 'Proses absensi dibatalkan.'else 'Verifikasi kedaluwarsa. Ulangi /masuk atau /pulang.'end));return;
 end if;
 if moment<b.requested_at then return;end if;
 if k='batch_confirm'and b.state='confirmation'then
  update staffing_attendance_batches set state='location',prompt_message_id=null where id=b.id;
  insert into staffing_outbox(payload,attendance_batch_id,expected_state)values(jsonb_build_object('chat_id',chat,'text','Balas pesan ini dengan lokasi melalui Attachment > Location. Kedaluwarsa dalam '||greatest(1,ceil(extract(epoch from(b.expires_at-now()))/60))||' menit.','reply_parameters',jsonb_build_object('message_id',b.request_message_id),'reply_markup',jsonb_build_object('force_reply',true,'selective',true)),b.id,'location');return;
 end if;
 if k='location'and b.state='location'then
  update staffing_attendance_batches set state='photo',prompt_message_id=null,latitude=(p_update->>'latitude')::numeric,longitude=(p_update->>'longitude')::numeric,location_sent_at=moment where id=b.id;
  insert into staffing_outbox(payload,attendance_batch_id,expected_state)values(jsonb_build_object('chat_id',chat,'text','Balas pesan ini dengan foto kehadiran di Sarkop. Foto digunakan untuk semua staf yang dikonfirmasi. Kedaluwarsa dalam '||greatest(1,ceil(extract(epoch from(b.expires_at-now()))/60))||' menit.','reply_parameters',jsonb_build_object('message_id',b.request_message_id),'reply_markup',jsonb_build_object('force_reply',true,'selective',true)),b.id,'photo');return;
 end if;
 if k<>'photo'or b.state<>'photo'or moment<b.location_sent_at then return;end if;
 perform id from staffing_staff where id in(select staff_id from staffing_attendance_batch_members where batch_id=b.id)or id=b.reporter_id order by id for update;
 if exists(select 1 from staffing_attendance_batch_members m join staffing_staff s on s.id=m.staff_id where m.batch_id=b.id and not s.active)then perform staffing_batch_abort(b.id,'Staf tidak aktif; ulangi absensi');return;end if;
 -- Validate every member under the same locks before recording anyone.
 for m in select * from staffing_attendance_batch_members where batch_id=b.id order by staff_id loop
  if b.kind='check_in'and(exists(select 1 from staffing_sessions where staff_id=m.staff_id and coalesce(corrected_out_at,check_out_at)is null)or exists(select 1 from staffing_unplanned_sessions where staff_id=m.staff_id and resolution_session_id is null and coalesce(corrected_out_at,check_out_at)is null))then perform staffing_batch_abort(b.id,'Sesi berubah selama verifikasi; ulangi absensi');return;end if;
  if b.kind='check_out'then
   if m.session_id is not null then
    if not exists(select 1 from staffing_sessions where id=m.session_id and staff_id=m.staff_id and coalesce(corrected_out_at,check_out_at)is null and coalesce(corrected_in_at,check_in_at)<=b.requested_at)then perform staffing_batch_abort(b.id,'Sesi berubah; tidak ada checkout yang disimpan');return;end if;
   elsif not exists(select 1 from staffing_unplanned_sessions where id=m.unplanned_id and staff_id=m.staff_id and resolution_session_id is null and coalesce(corrected_out_at,check_out_at)is null and coalesce(corrected_in_at,check_in_at)<=b.requested_at)then perform staffing_batch_abort(b.id,'Sesi berubah; tidak ada checkout yang disimpan');return;end if;
  end if;
 end loop;
 update staffing_attendance_batches set state='completed',photo_file_id=p_update->>'fileId',photo_unique_id=p_update->>'fileUniqueId',photo_message_id=(p_update->>'messageId')::bigint,photo_sent_at=moment,photo_update_id=(p_update->>'updateId')::bigint,completed_at=now()where id=b.id returning * into b;
 select time_zone into zone from stores where id=b.store_id;body:='';
 for m in select * from staffing_attendance_batch_members where batch_id=b.id order by staff_id loop
  se:=null;outside:=null;sh:=null;select * into st from staffing_staff where id=m.staff_id;
  if b.kind='check_in'then
   select * into sh from staffing_shifts where id=m.shift_id for update;
   if sh.id is not null and sh.staff_id=m.staff_id and to_jsonb(sh)=m.shift_snapshot and not exists(select 1 from staffing_sessions where shift_id=sh.id)then
    insert into staffing_sessions(shift_id,staff_id,check_in_at,check_in_reporter_id)values(sh.id,m.staff_id,b.requested_at,b.reporter_id)returning * into se;
   else
    insert into staffing_unplanned_sessions(staff_id,store_id,check_in_at,check_in_reporter_id,in_batch_id,outside_reason)values(m.staff_id,b.store_id,b.requested_at,b.reporter_id,b.id,coalesce(m.outside_reason,'Jadwal berubah selama verifikasi'))returning * into outside;
   end if;
  elsif m.session_id is not null then
   update staffing_sessions set check_out_at=b.requested_at,check_out_reporter_id=b.reporter_id,verification_state='pending',review_note=null,reviewed_at=null,reviewed_by=null,overtime_from_attendance=false where id=m.session_id returning * into se;select * into sh from staffing_shifts where id=se.shift_id;
  else update staffing_unplanned_sessions set check_out_at=b.requested_at,check_out_reporter_id=b.reporter_id,out_batch_id=b.id,verification_state='pending',review_note=null,reviewed_at=null,reviewed_by=null where id=m.unplanned_id returning * into outside;
  end if;
  if se.id is not null then perform staffing_materialize_batch_event(b.id,m.staff_id,se.id,sh.id);buttons:=buttons||jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Laporkan '||left(st.full_name,48),'callback_data','sf:r:'||se.id)));end if;
  update staffing_attendance_batch_members set session_id=se.id,unplanned_id=outside.id where batch_id=b.id and staff_id=m.staff_id;
  insert into staffing_audit(actor,action,entity_id,details)values('telegram:'||uid,b.kind,coalesce(se.id,outside.id)::text,jsonb_build_object('batch_id',b.id,'subject_staff_id',m.staff_id,'reported_by_staff_id',b.reporter_id,'outside_schedule',outside.id is not null));
  body:=body||case when body<>''then E'\n'else ''end||st.full_name||' waktu '||case b.kind when 'check_in'then 'masuk'else 'pulang'end||' tercatat '||to_char(b.requested_at at time zone zone,'DD/MM HH24:MI:SS')||case when outside.id is not null then ' · Masuk di luar jadwal'else ''end||'.';
  if st.id<>b.reporter_id and st.telegram_user_id is not null then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',st.telegram_user_id,'text','Absensi '||case b.kind when 'check_in'then 'masuk'else 'pulang'end||' dicatat oleh '||(select full_name from staffing_staff where id=b.reporter_id)||' untukmu. Bukti bersama dikirim di grup; menunggu review manager.'));end if;
 end loop;
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text',body||E'\nLokasi dan foto diterima.','reply_markup',jsonb_build_object('inline_keyboard',buttons)));
end$$;

alter function staffing_deliver_outbox(bigint,bigint)rename to staffing_deliver_outbox_v20;
create function staffing_deliver_outbox(p_id bigint,p_message_id bigint)returns void language plpgsql set search_path=public as $$
#variable_conflict use_column
declare row staffing_outbox;begin
 select * into row from staffing_outbox where id=p_id;
 perform staffing_deliver_outbox_v20(p_id,p_message_id);
 if row.attendance_batch_id is not null then update staffing_attendance_batches set prompt_message_id=p_message_id where id=row.attendance_batch_id and state=row.expected_state;end if;
end$$;
create function staffing_batch_group_guard()returns trigger language plpgsql set search_path=public as $$
#variable_conflict use_column
begin
 if exists(select 1 from staffing_attendance_batches where chat_id=old.chat_id and state in('confirmation','location','photo')and expires_at>now())then raise exception 'Selesaikan absensi kelompok sebelum mengganti grup';end if;if tg_op='DELETE'then return old;end if;return new;
end$$;
create trigger staffing_active_batch_group_guard before update or delete on staffing_groups for each row execute function staffing_batch_group_guard();
alter function staffing_apply_update(jsonb)rename to staffing_apply_update_v20;
create function staffing_apply_update(p_update jsonb)returns void language plpgsql set search_path=public as $$
#variable_conflict use_column

declare uid bigint:=(p_update->>'userId')::bigint;chat bigint:=(p_update->>'chatId')::bigint;k text:=p_update->>'kind';bid uuid;begin
 if uid is null or uid<=0 or chat is null then return;end if;
 perform staffing_lock_group(chat);perform pg_advisory_xact_lock(hashtext('staffing-bot'),hashtext(uid::text));
 if p_update?'senderUsername'then perform staffing_sync_telegram_alias(uid,p_update->>'senderUsername');end if;
 if p_update->>'chatType'in('group','supergroup')then
  if k in('check_in','check_out','proxy_check_in','proxy_check_out')and p_update->>'attendanceVersion'='2'then
   insert into staffing_inbox(update_id)values((p_update->>'updateId')::bigint)on conflict do nothing;if not found then return;end if;
   perform staffing_batch_start(p_update);return;
  end if;
  if k in('batch_confirm','batch_cancel')then bid:=(p_update->>'batchId')::uuid;
  elsif k in('location','photo','cancel')then select b.id into bid from staffing_attendance_batches b join staffing_staff s on s.id=b.reporter_id where s.telegram_user_id=uid and b.chat_id=chat and b.state in('confirmation','location','photo')and(k='cancel'or b.prompt_message_id=(p_update->>'replyTo')::bigint)order by b.requested_at desc limit 1;end if;
  if bid is not null then
   insert into staffing_inbox(update_id)values((p_update->>'updateId')::bigint)on conflict do nothing;if not found then return;end if;
   perform staffing_batch_continue(p_update,bid);return;
  end if;
 end if;
 if k in('batch_confirm','batch_cancel')then return;end if;
 perform staffing_apply_update_v20(p_update);
end$$;

create function staffing_unplanned_version(p_session uuid)returns text language sql stable set search_path=public as $$
 select md5((to_jsonb(u)||jsonb_build_object('work_timezone',s.time_zone))::text)from staffing_unplanned_sessions u join stores s on s.id=u.store_id where u.id=p_session;
$$;
create function staffing_unplanned_view(p_actor uuid,p_bootstrap boolean,p_store uuid default null,p_staff uuid default null)returns jsonb language plpgsql stable set search_path=public as $$
#variable_conflict use_column
declare scope uuid[];begin
 scope:=staffing_actor_stores(p_actor,p_bootstrap);if p_store is not null and not p_store=any(scope)then raise exception 'FORBIDDEN';end if;
 return coalesce((select jsonb_agg(to_jsonb(u)||jsonb_build_object('is_unscheduled',true,'session_id',u.id,'shift_id',null,'starts_at',coalesce(u.corrected_in_at,u.check_in_at),'ends_at',coalesce(u.corrected_out_at,u.check_out_at,u.corrected_in_at,u.check_in_at)+interval '1 second','label','Masuk di luar jadwal','full_name',s.full_name,'store_name',so.name,'time_zone',so.time_zone,'review_version',staffing_unplanned_version(u.id),'can_view_profile',s.home_store_id=any(scope),'approved_leave',false,'last_location',(select jsonb_build_object('latitude',b.latitude,'longitude',b.longitude,'sent_at',b.location_sent_at)from staffing_attendance_batches b where b.id=coalesce(u.out_batch_id,u.in_batch_id)),'shared_evidence_count',(select count(*)from staffing_attendance_batch_members where batch_id=u.in_batch_id),'check_in_reporter_name',case when u.check_in_reporter_id<>u.staff_id then a.full_name end,'check_out_reporter_name',case when u.check_out_reporter_id<>u.staff_id then b.full_name end,'payroll_locked',exists(select 1 from staffing_payrolls p join stores home on home.id=s.home_store_id where p.staff_id=u.staff_id and(p.period_start::timestamp at time zone home.time_zone)<coalesce(u.corrected_out_at,u.check_out_at,now())and((p.period_end+1)::timestamp at time zone home.time_zone)>coalesce(u.corrected_in_at,u.check_in_at)))order by u.check_in_at desc)
 from staffing_unplanned_sessions u join staffing_staff s on s.id=u.staff_id join stores so on so.id=u.store_id join staffing_staff a on a.id=u.check_in_reporter_id left join staffing_staff b on b.id=u.check_out_reporter_id
 where u.store_id=any(scope)and(p_store is null or u.store_id=p_store)and(p_staff is null or u.staff_id=p_staff)and u.resolution_session_id is null),'[]');
end$$;
create function staffing_unplanned_context(p_actor uuid,p_bootstrap boolean,p_session uuid)returns jsonb language plpgsql stable set search_path=public as $$
#variable_conflict use_column
declare u staffing_unplanned_sessions;scope uuid[];begin
 scope:=staffing_actor_stores(p_actor,p_bootstrap);select * into u from staffing_unplanned_sessions where id=p_session;
 if u.id is null or not u.store_id=any(scope)then raise exception 'FORBIDDEN';end if;
 return jsonb_build_object('time_zone',(select time_zone from stores where id=u.store_id),'options',coalesce((select jsonb_agg(jsonb_build_object('id',sh.id,'staff_id',sh.staff_id,'full_name',s.full_name,'starts_at',sh.starts_at,'ends_at',sh.ends_at,'version',md5(to_jsonb(sh)::text))order by sh.starts_at,s.full_name)
 from staffing_shifts sh join staffing_staff s on s.id=sh.staff_id where sh.store_id=u.store_id and s.home_store_id=any(scope)and s.active and sh.starts_at>=u.check_in_at-interval '7 days'and sh.starts_at<=u.check_in_at+interval '7 days'
 and not exists(select 1 from staffing_sessions where shift_id=sh.id)and not exists(select 1 from staffing_attempts where shift_id=sh.id)and not exists(select 1 from staffing_shift_requests where(shift_id=sh.id or other_shift_id=sh.id)and status in('pending_peer','pending_manager')and expires_at>now())and not exists(select 1 from staffing_attendance_batch_members bm join staffing_attendance_batches bb on bb.id=bm.batch_id where bm.shift_id=sh.id and bb.state in('confirmation','location','photo')and bb.expires_at>now())),'[]'));
end$$;
create function staffing_review_unplanned(p_actor uuid,p_bootstrap boolean,p_data jsonb)returns jsonb language plpgsql set search_path=public as $$
#variable_conflict use_column

declare u staffing_unplanned_sessions;scope uuid[];actual_in timestamptz;actual_out timestamptz;warnings jsonb;v_actor text:=coalesce(p_actor::text,'bootstrap-super-admin');cached staffing_operation_keys;v_key uuid:=(p_data->>'client_id')::uuid;v_state text:=p_data->>'state';note text:=coalesce(trim(p_data->>'note'),'');v_result jsonb;zone text;begin
 scope:=staffing_actor_stores(p_actor,p_bootstrap);select * into u from staffing_unplanned_sessions where id=(p_data->>'session_id')::uuid;
 if u.id is null or not u.store_id=any(scope)then raise exception 'FORBIDDEN';end if;perform id from staffing_staff where id=u.staff_id for update;select * into u from staffing_unplanned_sessions where id=u.id for update;
 if v_key is null then raise exception 'Identitas pengajuan wajib diisi';end if;
 insert into staffing_operation_keys(key,actor,action,data_hash)values(v_key,v_actor,'review_unplanned',md5((p_data-'client_id')::text))on conflict do nothing;
 if not found then select * into cached from staffing_operation_keys k where k.key=v_key;if cached.actor<>v_actor or cached.action<>'review_unplanned'or cached.data_hash<>md5((p_data-'client_id')::text)then raise exception 'Identitas perubahan sudah dipakai';end if;return cached.result;end if;
 if u.resolution_session_id is not null or p_data->>'version'is distinct from staffing_unplanned_version(u.id)then raise exception 'ATTENDANCE_STALE';end if;
 if v_state is null or v_state not in('pending','confirmed','rejected')or length(note)>1000 then raise exception 'Periksa status review dan catatan';end if;
 actual_in:=coalesce(u.corrected_in_at,u.check_in_at);actual_out:=coalesce(u.corrected_out_at,u.check_out_at);
 if coalesce((p_data->>'correct_times')::boolean,false)then actual_in:=(p_data->>'check_in_at')::timestamptz;actual_out:=nullif(p_data->>'check_out_at','')::timestamptz;end if;
 if actual_in is null or(u.check_out_at is not null and actual_out is null)then raise exception 'Waktu masuk dan checkout asli tidak dapat dikosongkan';end if;
 warnings:=staffing_attendance_time_warnings(actual_in,actual_out);
 if v_state='confirmed'and jsonb_array_length(warnings)>0 and p_data->'acknowledge_time_anomalies'is distinct from 'true'::jsonb then raise exception 'ATTENDANCE_ANOMALY_CONFIRMATION_REQUIRED';end if;
 select s.time_zone into zone from staffing_staff st join stores s on s.id=st.home_store_id where st.id=u.staff_id;
 if exists(select 1 from staffing_payrolls p where p.staff_id=u.staff_id and(p.period_start::timestamp at time zone zone)<greatest(coalesce(actual_out,now()),u.check_in_at,actual_in)+interval '1 second'and((p.period_end+1)::timestamp at time zone zone)>least(actual_in,u.check_in_at,coalesce(actual_out,actual_in)))then raise exception 'Periode payroll sudah final';end if;
 update staffing_unplanned_sessions set corrected_in_at=case when actual_in is distinct from coalesce(corrected_in_at,check_in_at)then actual_in else corrected_in_at end,corrected_out_at=case when actual_out is distinct from coalesce(corrected_out_at,check_out_at)then actual_out else corrected_out_at end,verification_state=v_state,review_note=note,reviewed_at=now(),reviewed_by=v_actor where id=u.id;
 insert into staffing_audit(actor,action,entity_id,details)values(v_actor,'review_unplanned',u.id::text,jsonb_build_object('before',to_jsonb(u),'after',(select to_jsonb(s)from staffing_unplanned_sessions s where s.id=u.id),'time_anomalies',warnings,'time_anomalies_acknowledged',v_state='confirmed'and jsonb_array_length(warnings)>0));
 if v_state in('confirmed','rejected')then insert into staffing_outbox(payload)select jsonb_build_object('chat_id',telegram_user_id,'text','Review absensi '||case v_state when 'confirmed'then 'dikonfirmasi'else 'ditolak'end||'. Lihat /absensi untuk waktu terbaru.'||staffing_note_suffix(note))from staffing_staff where id=u.staff_id and active and telegram_user_id is not null;end if;
 v_result:=jsonb_build_object('id',u.id);update staffing_operation_keys k set result=v_result where k.key=v_key;return v_result;
end$$;

alter function staffing_attendance_metadata(uuid)rename to staffing_attendance_metadata_v20;
create function staffing_attendance_metadata(p_session uuid)returns jsonb language sql stable set search_path=public as $$
 select staffing_attendance_metadata_v20(p_session)||jsonb_build_object('overtime_only',sh.overtime_only,'shared_evidence_count',greatest(1,coalesce((select max((select count(*)from staffing_attendance_batch_members where batch_id=a.attendance_batch_id))from staffing_events e join staffing_attempts a on a.id=e.attempt_id where e.session_id=p_session),1)))from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id where se.id=p_session;
$$;
alter function staffing_evidence(uuid,boolean,uuid,uuid)rename to staffing_evidence_v20;
create function staffing_evidence(p_actor uuid,p_bootstrap boolean,p_session uuid default null,p_attempt uuid default null)returns jsonb language plpgsql stable set search_path=public as $$
#variable_conflict use_column
declare scope uuid[];extra jsonb;begin
 scope:=staffing_actor_stores(p_actor,p_bootstrap);
 select coalesce(jsonb_agg(distinct jsonb_build_object('attempt_id',b.id,'kind',b.kind,'latitude',b.latitude,'longitude',b.longitude,'file_id',b.photo_file_id,'requested_at',b.requested_at,'completed_at',b.completed_at,'effective_at',b.requested_at,'timestamp_source','telegram_command')),'[]')into extra
 from staffing_unplanned_sessions u join staffing_attendance_batches b on b.id in(u.in_batch_id,u.out_batch_id)where u.store_id=any(scope)and b.state='completed'and((p_session is not null and u.id=p_session)or(p_attempt is not null and b.id=p_attempt));
 return staffing_evidence_v20(p_actor,p_bootstrap,p_session,p_attempt)||extra;
end$$;
alter function staffing_activity_week(uuid,boolean,uuid,date)rename to staffing_activity_week_v20;
create function staffing_activity_week(p_actor uuid,p_bootstrap boolean,p_store uuid default null,p_week date default null)returns jsonb language plpgsql stable set search_path=public as $$
#variable_conflict use_column
declare base jsonb;items jsonb;visible jsonb;pending jsonb;begin
 base:=staffing_activity_week_v20(p_actor,p_bootstrap,p_store,p_week);items:=staffing_unplanned_view(p_actor,p_bootstrap,p_store,null);
 select coalesce(jsonb_agg(value order by value->>'check_in_at'),'[]')into visible from jsonb_array_elements(items)where(value->>'check_in_at')::timestamptz<((coalesce(p_week,date_trunc('week',now()at time zone(value->>'time_zone'))::date)+7)::timestamp at time zone(value->>'time_zone'))and coalesce((value->>'check_out_at')::timestamptz,now())>(coalesce(p_week,date_trunc('week',now()at time zone(value->>'time_zone'))::date)::timestamp at time zone(value->>'time_zone'));
 select coalesce(jsonb_agg(value order by value->>'check_in_at'),'[]')into pending from jsonb_array_elements(items)where value->>'verification_state'<>'rejected';
 return base||jsonb_build_object('rows',base->'rows'||visible,'pending_attendance',base->'pending_attendance'||pending);
end$$;
alter function staffing_staff_detail(uuid,boolean,uuid)rename to staffing_staff_detail_v20;
create function staffing_staff_detail(p_actor uuid,p_bootstrap boolean,p_staff uuid)returns jsonb language plpgsql stable set search_path=public as $$
#variable_conflict use_column
declare base jsonb;begin
 base:=staffing_staff_detail_v20(p_actor,p_bootstrap,p_staff);return jsonb_set(base,'{sessions}',base->'sessions'||staffing_unplanned_view(p_actor,p_bootstrap,null,p_staff));
end$$;
alter function staffing_payroll_source(uuid,boolean,uuid,date,date)rename to staffing_payroll_source_v20;
create function staffing_payroll_source(p_actor uuid,p_bootstrap boolean,p_staff uuid,p_from date,p_to date)returns jsonb language plpgsql stable set search_path=public as $$
#variable_conflict use_column
declare source jsonb;input jsonb;begin
 source:=staffing_payroll_source_v20(p_actor,p_bootstrap,p_staff,p_from,p_to);
 input:=source->'input'||jsonb_build_object('unplanned_attendance',coalesce((select jsonb_agg(jsonb_build_object('id',u.id))from staffing_unplanned_sessions u where u.staff_id=p_staff and u.resolution_session_id is null and u.verification_state<>'rejected'and coalesce(u.corrected_in_at,u.check_in_at)<(source->'input'->>'range_end')::timestamptz and coalesce(u.corrected_out_at,u.check_out_at,now())>(source->'input'->>'range_start')::timestamptz),'[]'));
 input:=input||jsonb_build_object('pending_attendance_batches',coalesce((select jsonb_agg(jsonb_build_object('id',b.id))from staffing_attendance_batch_members m join staffing_attendance_batches b on b.id=m.batch_id where m.staff_id=p_staff and b.state in('confirmation','location','photo')and b.expires_at>now()and b.requested_at>=(source->'input'->>'range_start')::timestamptz and b.requested_at<(source->'input'->>'range_end')::timestamptz),'[]'));
 input:=jsonb_set(input,'{sessions}',coalesce((select jsonb_agg(value||jsonb_build_object('overtime_only',coalesce(sh.overtime_only,false)))from jsonb_array_elements(input->'sessions')value left join staffing_shifts sh on sh.id=(value->>'shift_id')::uuid),'[]'));
 return jsonb_build_object('input',input,'version',md5(input::text));
end$$;

create function staffing_resolve_unplanned(p_actor uuid,p_bootstrap boolean,p_data jsonb)returns jsonb language plpgsql set search_path=public as $$
#variable_conflict use_column

declare u staffing_unplanned_sessions;scope uuid[];st staffing_staff;other staffing_staff;chosen staffing_shifts;own staffing_shifts;new_shift uuid;new_session uuid;
 mode text:=p_data->>'mode';v_actor text:=coalesce(p_actor::text,'bootstrap-super-admin');v_key uuid:=(p_data->>'client_id')::uuid;v_hash text:=md5((p_data-'client_id')::text);cached staffing_operation_keys;v_result jsonb;
 actual_in timestamptz;actual_out timestamptz;starts timestamptz;ends timestamptz;zone text;note text:=coalesce(trim(p_data->>'note'),'');begin
 scope:=staffing_actor_stores(p_actor,p_bootstrap);select * into u from staffing_unplanned_sessions where id=(p_data->>'session_id')::uuid;
 if u.id is null or not u.store_id=any(scope)then raise exception 'FORBIDDEN';end if;
 select * into chosen from staffing_shifts where id=nullif(p_data->>'target_shift_id','')::uuid;
 select * into own from staffing_shifts where id=nullif(p_data->>'own_shift_id','')::uuid;
 perform id from staffing_staff where id in(u.staff_id,chosen.staff_id)order by id for update;
 select * into u from staffing_unplanned_sessions where id=u.id for update;
 st:=staffing_require_staff(p_actor,p_bootstrap,u.staff_id);
 if v_key is null then raise exception 'Identitas pengajuan wajib diisi';end if;
 insert into staffing_operation_keys(key,actor,action,data_hash)values(v_key,v_actor,'resolve_unplanned',v_hash)on conflict do nothing;
 if not found then select * into cached from staffing_operation_keys k where k.key=v_key;if cached.actor<>v_actor or cached.action<>'resolve_unplanned'or cached.data_hash<>v_hash then raise exception 'Identitas perubahan sudah dipakai';end if;return cached.result;end if;
 if u.resolution_session_id is not null or p_data->>'version'is distinct from staffing_unplanned_version(u.id)then raise exception 'ATTENDANCE_STALE';end if;
 if mode is null or mode not in('schedule','overtime','replace','swap')or length(note)>1000 then raise exception 'Pilih penanganan absensi';end if;
 if u.verification_state='rejected'then raise exception 'Ubah review penolakan sebelum menangani jadwal';end if;
 actual_in:=coalesce(u.corrected_in_at,u.check_in_at);actual_out:=coalesce(u.corrected_out_at,u.check_out_at);
 select time_zone into zone from stores where id=st.home_store_id;
 if exists(select 1 from staffing_payrolls p where p.staff_id=st.id and(p.period_start::timestamp at time zone zone)<greatest(coalesce(actual_out,now()),actual_in)+interval '1 second'and((p.period_end+1)::timestamp at time zone zone)>least(actual_in,coalesce(actual_out,actual_in)))then raise exception 'Periode payroll sudah final';end if;
 if mode in('schedule','overtime')then
  starts:=case when mode='overtime'then actual_in else(p_data->>'starts_at')::timestamptz end;
  ends:=case when mode='overtime'then actual_out else(p_data->>'ends_at')::timestamptz end;
  if starts is null or ends is null or ends<=starts or ends>starts+interval '24 hours'then raise exception 'Isi rentang waktu valid maksimal 24 jam; lembur memerlukan catatan pulang';end if;
  if mode='overtime'and(u.verification_state<>'confirmed'or length(note)<5)then raise exception 'Konfirmasi absensi terlebih dahulu dan isi alasan lembur minimal 5 karakter';end if;
  if exists(select 1 from staffing_payrolls p where p.staff_id=st.id and(p.period_start::timestamp at time zone zone)<ends and((p.period_end+1)::timestamp at time zone zone)>starts)then raise exception 'Periode jadwal sudah masuk payroll final';end if;
  if exists(select 1 from staffing_shifts where staff_id=st.id and starts_at<ends and ends_at>starts)then raise exception 'Jadwal bertabrakan. Pilih penanganan tukar / pengganti atau koreksi waktunya';end if;
  insert into staffing_shifts(staff_id,store_id,label,starts_at,ends_at,overtime_only)values(st.id,u.store_id,case mode when 'overtime'then 'Lembur di luar jadwal'else 'Jadwal dari absensi'end,starts,ends,mode='overtime')returning id into new_shift;
 else
  if chosen.id is null or chosen.store_id<>u.store_id or chosen.staff_id=st.id then raise exception 'Pilih shift rekan di store yang sama';end if;
  other:=staffing_require_staff(p_actor,p_bootstrap,chosen.staff_id);
  perform id from staffing_shifts where id in(chosen.id,own.id)order by id for update;
  select * into chosen from staffing_shifts where id=chosen.id;
  if p_data->>'target_version'is distinct from md5(to_jsonb(chosen)::text)or chosen.staff_id<>other.id then raise exception 'Jadwal rekan berubah. Muat ulang pilihan';end if;
  if mode='swap'then
   select * into own from staffing_shifts where id=own.id;
   if own.id is null or own.staff_id<>st.id or own.store_id<>u.store_id or p_data->>'own_version'is distinct from md5(to_jsonb(own)::text)then raise exception 'Pilih shift milik staf pertama yang masih berlaku';end if;
  end if;
  if exists(select 1 from staffing_sessions where shift_id in(chosen.id,case when mode='swap'then own.id end))or exists(select 1 from staffing_attempts where shift_id in(chosen.id,case when mode='swap'then own.id end))or exists(select 1 from staffing_shift_requests where(shift_id in(chosen.id,own.id)or other_shift_id in(chosen.id,own.id))and status in('pending_peer','pending_manager')and expires_at>now())then raise exception 'Shift sudah memiliki absensi atau permintaan aktif';end if;
  if exists(select 1 from staffing_attendance_batch_members m join staffing_attendance_batches b on b.id=m.batch_id where m.shift_id in(chosen.id,own.id)and b.state in('confirmation','location','photo')and b.expires_at>now())then raise exception 'Shift sedang diverifikasi';end if;
  if exists(select 1 from staffing_payrolls p join staffing_staff ps on ps.id=p.staff_id join stores home on home.id=ps.home_store_id where p.staff_id in(st.id,other.id)and(p.period_start::timestamp at time zone home.time_zone)<greatest(chosen.ends_at,coalesce(own.ends_at,chosen.ends_at))and((p.period_end+1)::timestamp at time zone home.time_zone)>least(chosen.starts_at,coalesce(own.starts_at,chosen.starts_at)))then raise exception 'Jadwal sudah masuk payroll final';end if;
  if exists(select 1 from staffing_shifts sh where sh.staff_id=st.id and sh.id<>coalesce(case when mode='swap'then own.id end,chosen.id)and sh.starts_at<chosen.ends_at and sh.ends_at>chosen.starts_at)then raise exception 'Jadwal staf pertama bertabrakan';end if;
  if mode='swap'and exists(select 1 from staffing_shifts sh where sh.staff_id=other.id and sh.id<>chosen.id and sh.starts_at<own.ends_at and sh.ends_at>own.starts_at)then raise exception 'Jadwal staf kedua bertabrakan';end if;
  update staffing_shifts set staff_id=st.id where id=chosen.id;
  if mode='swap'then update staffing_shifts set staff_id=other.id where id=own.id;end if;
  new_shift:=chosen.id;
 end if;
 insert into staffing_sessions(shift_id,staff_id,check_in_at,check_out_at,corrected_in_at,corrected_out_at,check_in_reporter_id,check_out_reporter_id,verification_state,review_note,reviewed_at,reviewed_by,overtime_from_attendance)
 values(new_shift,st.id,u.check_in_at,u.check_out_at,u.corrected_in_at,u.corrected_out_at,u.check_in_reporter_id,u.check_out_reporter_id,u.verification_state,u.review_note,u.reviewed_at,u.reviewed_by,false)returning id into new_session;
 perform staffing_materialize_batch_event(u.in_batch_id,st.id,new_session,new_shift);
 if u.out_batch_id is not null then perform staffing_materialize_batch_event(u.out_batch_id,st.id,new_session,new_shift);end if;
 if mode='overtime'then insert into staffing_time_approvals(session_id,kind,starts_at,ends_at,reason,created_by)values(new_session,'overtime',actual_in,actual_out,note,v_actor);end if;
 update staffing_unplanned_sessions set resolution_session_id=new_session,resolution_type=mode,resolved_at=now(),resolved_by=v_actor where id=u.id;
 insert into staffing_audit(actor,action,entity_id,details)values(v_actor,'resolve_unplanned',u.id::text,jsonb_build_object('before',to_jsonb(u),'mode',mode,'session_id',new_session,'shift_id',new_shift,'other_shift_before',to_jsonb(chosen),'own_shift_before',to_jsonb(own),'note',note));
 insert into staffing_outbox(payload)select jsonb_build_object('chat_id',telegram_user_id,'text','Absensi di luar jadwal telah ditangani manager: '||case mode when 'schedule'then 'ditambahkan ke jadwal'when 'overtime'then 'ditambahkan sebagai lembur'when 'swap'then 'tukar jadwal'else 'menggantikan shift rekan'end||'.'||staffing_note_suffix(note))from staffing_staff where id in(st.id,other.id)and active and telegram_user_id is not null;
 v_result:=jsonb_build_object('id',u.id,'session_id',new_session);update staffing_operation_keys k set result=v_result where k.key=v_key;return v_result;
end$$;

create or replace function staffing_notify_personal_result()returns trigger language plpgsql set search_path=public as $$
#variable_conflict use_column
declare uid bigint;body text;begin
 select telegram_user_id into uid from staffing_staff where id=new.staff_id and active;
 if uid is null then return new;end if;
 if tg_table_name='staffing_sessions'then
  if new.verification_state='pending'or(new.verification_state=old.verification_state and new.corrected_in_at is not distinct from old.corrected_in_at and new.corrected_out_at is not distinct from old.corrected_out_at)then return new;end if;
  body:='Review absensi '||case new.verification_state when 'confirmed'then 'dikonfirmasi'else 'ditolak'end||'. Lihat /absensi untuk waktu terbaru.'||staffing_note_suffix(new.review_note);
 else
  if new.status=old.status then return new;end if;
  body:='Pengajuan '||case new.kind when 'cash_advance'then 'kasbon Rp'||new.amount else 'izin / sakit '||new.start_date||' – '||new.end_date end||' · '||case new.status when 'approved'then case when new.kind='cash_advance'then 'Disetujui, menunggu pencairan'else 'Disetujui'end when 'disbursed'then 'Pencairan dikonfirmasi'when 'rejected'then 'Ditolak'else 'Dibatalkan'end||E'\nLihat /menu untuk rincian pribadi.'||staffing_note_suffix(new.decision_note);
 end if;
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',uid,'text',body));return new;
end$$;

create or replace function staffing_decide_overtime(p_actor uuid,p_bootstrap boolean,p_request uuid,p_decision text,p_note text default '')returns jsonb language plpgsql set search_path=public as $$
#variable_conflict use_column

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
 if uid is not null then insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',uid,'text','Pengajuan lembur '||case p_decision when 'approved'then 'disetujui'else 'ditolak'end||' manager.'||staffing_note_suffix(p_note)));end if;
 return jsonb_build_object('id',r.id,'status',p_decision);
end $$;

alter function staffing_bot_private(bigint,bigint,text)rename to staffing_bot_private_v20;
create function staffing_bot_private(p_user bigint,p_chat bigint,p_kind text)returns void language plpgsql set search_path=public as $$
#variable_conflict use_column
declare st staffing_staff;body text;begin
 if p_kind<>'history'then perform staffing_bot_private_v20(p_user,p_chat,p_kind);return;end if;
 if p_user<>p_chat then return;end if;select * into st from staffing_staff where telegram_user_id=p_user and active;
 if st.id is null then perform staffing_bot_private_v20(p_user,p_chat,p_kind);return;end if;
 select string_agg(line,E'\n\n'order by happened desc)into body from(
  select * from(
   select coalesce(se.corrected_in_at,se.check_in_at)as happened,staffing_short_range(coalesce(se.corrected_in_at,se.check_in_at),coalesce(se.corrected_out_at,se.check_out_at),so.time_zone)||' ('||case se.verification_state when 'confirmed'then 'dikonfirmasi'when 'rejected'then 'ditolak'else 'menunggu review'end||')'as line from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id join stores so on so.id=sh.store_id where se.staff_id=st.id
   union all select coalesce(u.corrected_in_at,u.check_in_at),staffing_short_range(coalesce(u.corrected_in_at,u.check_in_at),coalesce(u.corrected_out_at,u.check_out_at),so.time_zone)||' (di luar jadwal · '||case u.verification_state when 'confirmed'then 'dikonfirmasi'when 'rejected'then 'ditolak'else 'menunggu review'end||')'from staffing_unplanned_sessions u join stores so on so.id=u.store_id where u.staff_id=st.id and u.resolution_session_id is null
  )all_sessions order by happened desc limit 10
 )q;
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',p_chat,'text','Absensi 10 sesi terakhir'||E'\n\n'||coalesce(body,'Belum ada absensi.')));
end$$;

alter function staffing_home(uuid,boolean)rename to staffing_home_v20;
create function staffing_home(p_actor uuid,p_bootstrap boolean)returns jsonb language plpgsql stable set search_path=public as $$declare base jsonb;items jsonb;begin
 base:=staffing_home_v20(p_actor,p_bootstrap);items:=staffing_unplanned_view(p_actor,p_bootstrap,null,null);
 return base||jsonb_build_object('pending_attendance',(base->>'pending_attendance')::integer+(select count(*)from jsonb_array_elements(items)where value->>'verification_state'<>'rejected'),'open_sessions',(base->>'open_sessions')::integer+(select count(*)from jsonb_array_elements(items)where value->>'verification_state'<>'rejected'and coalesce(value->>'corrected_out_at',value->>'check_out_at')is null));
end$$;

alter function staffing_claim_outbox()rename to staffing_claim_outbox_v20;
create function staffing_claim_outbox()returns setof staffing_outbox language plpgsql set search_path=public as $$begin
 delete from staffing_outbox o using staffing_attendance_batches b where o.attendance_batch_id=b.id and o.delivered_at is null and(b.expires_at<=now()or b.state<>o.expected_state);
 return query select * from staffing_claim_outbox_v20();
end$$;

create or replace function staffing_shift_request_notify(p_request uuid,p_text text)returns void language plpgsql set search_path=public as $$
declare r staffing_shift_requests;u bigint;body text;begin
 select * into r from staffing_shift_requests where id=p_request;
 body:=staffing_shift_request_text(r.id)||E'\n\n'||case r.status when 'pending_manager'then 'Pihak kedua sudah bersedia. Menunggu persetujuan manager.'when 'approved'then 'Disetujui manager. Jadwal sudah diperbarui.'when 'rejected'then 'Permintaan ditolak.'when 'cancelled'then 'Permintaan dibatalkan.'else staffing_bot_escape(p_text)end;
 body:=body||staffing_note_suffix(r.decision_note);
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',r.chat_id,'text',body,'parse_mode','HTML'));
 for u in select distinct telegram_user_id from staffing_staff where id in(r.requester_id,r.target_staff_id)and telegram_user_id is not null loop insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',u,'text',body,'parse_mode','HTML'));end loop;
end $$;

do $$declare definition text;begin
 select pg_get_functiondef('staffing_apply_update_v20(jsonb)'::regprocedure)into definition;
 definition:=replace(definition,'Konfirmasi shift, lokasi, dan foto dikirim di grup ini. Hasil review manager dikirim ke chat pribadi.','Konfirmasi shift, lokasi, dan foto dikirim di grup ini. Hasil review manager dikirim ke chat pribadi. Absen bersama: /masuk saya @rekan atau /pulang saya @rekan. Tanpa saya berarti pengaju tidak ikut diabsenkan.');
 execute definition;
end$$;

-- Explicit server-only execution across new entry points and preserved wrappers.
do $$declare f record;begin for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and left(p.proname,9)='staffing_'loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
end loop;end$$;
notify pgrst,'reload schema';
commit;
