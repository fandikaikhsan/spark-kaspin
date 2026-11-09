begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local search_path = public;

-- Keep existing POS objects and keys intact. Staffing uses a table prefix so the
-- existing server-only PostgREST setup needs no additional exposed schema.
-- Fail before DDL when the existing authentication contract differs.
do $$ begin
  if exists(select 1 from public.app_users where role is null or role not in ('admin','manager')) then
    raise exception 'STAFFING_ROLE_CONFLICT: app_users contains roles outside admin/manager';
  end if;
  if exists(select 1 from pg_constraint co join pg_attribute a
    on a.attrelid=co.conrelid and a.attname='role'
    where co.conrelid='public.app_users'::regclass and co.contype='c'
      and a.attnum=any(co.conkey) and co.conname<>'app_users_role_check') then
    raise exception 'STAFFING_ROLE_CONSTRAINT_CONFLICT: inspect additional role constraints before rollout';
  end if;
  if not has_table_privilege('service_role','public.stores','select')
    or not has_table_privilege('service_role','public.app_users','select') then
    raise exception 'STAFFING_SERVICE_GRANT_MISSING: service_role needs read access to stores and app_users';
  end if;
end $$;
alter table public.app_users drop constraint if exists app_users_role_check;
alter table public.app_users add constraint app_users_role_check check (role in ('admin', 'manager'));

create table public.staffing_regions (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) between 1 and 100)
);
create table public.staffing_store_regions (
  store_id uuid primary key references public.stores(id) on delete restrict,
  region_id uuid not null references public.staffing_regions(id) on delete restrict
);
create index on public.staffing_store_regions(region_id);
create table public.staffing_manager_regions (
  user_id uuid not null references public.app_users(id) on delete restrict,
  region_id uuid not null references public.staffing_regions(id) on delete restrict,
  primary key(user_id, region_id)
);
create table public.staffing_staff (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Za-z0-9._-]{1,40}$'),
  full_name text not null check (length(trim(full_name)) between 1 and 120),
  home_store_id uuid not null references public.stores(id) on delete restrict,
  telegram_user_id bigint unique check (telegram_user_id > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index on public.staffing_staff(home_store_id);
create table public.staffing_link_tokens (
  token_hash text primary key,
  staff_id uuid not null references public.staffing_staff(id) on delete restrict,
  expires_at timestamptz not null,
  used_at timestamptz
);
create table public.staffing_groups (
  chat_id bigint primary key check (chat_id < 0),
  store_id uuid not null references public.stores(id) on delete restrict
);
create table public.staffing_shifts (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staffing_staff(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete restrict,
  label text not null check (length(trim(label)) between 1 and 80),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at and ends_at <= starts_at + interval '24 hours')
);
create index on public.staffing_shifts(staff_id, starts_at);
create index on public.staffing_shifts(store_id, starts_at);
create table public.staffing_attempts (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staffing_staff(id) on delete restrict,
  shift_id uuid not null references public.staffing_shifts(id) on delete restrict,
  chat_id bigint not null,
  kind text not null check (kind in ('check_in', 'check_out')),
  state text not null check (state in ('confirmation', 'location', 'photo', 'completed', 'cancelled')),
  requested_at timestamptz not null,
  received_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  request_message_id bigint not null,
  prompt_message_id bigint,
  latitude numeric check (latitude between -90 and 90),
  longitude numeric check (longitude between -180 and 180),
  location_sent_at timestamptz,
  photo_file_id text,
  photo_unique_id text,
  completed_at timestamptz
);
create index on public.staffing_attempts(staff_id, chat_id);
create table public.staffing_sessions (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null unique references public.staffing_shifts(id) on delete restrict,
  staff_id uuid not null references public.staffing_staff(id) on delete restrict,
  check_in_at timestamptz not null,
  check_out_at timestamptz,
  corrected_in_at timestamptz,
  corrected_out_at timestamptz,
  check (coalesce(corrected_out_at, check_out_at) is null or coalesce(corrected_out_at, check_out_at) >= coalesce(corrected_in_at, check_in_at))
);
create unique index staffing_one_open_session on public.staffing_sessions(staff_id)
  where coalesce(corrected_out_at, check_out_at) is null;
create table public.staffing_events (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.staffing_sessions(id) on delete restrict,
  attempt_id uuid not null unique references public.staffing_attempts(id) on delete restrict,
  kind text not null check (kind in ('check_in', 'check_out')),
  effective_at timestamptz not null,
  received_at timestamptz not null default now(),
  timestamp_source text not null check (timestamp_source in ('telegram_message', 'server_received')),
  message_id bigint not null,
  update_id bigint not null unique
);
create table public.staffing_reports (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.staffing_sessions(id) on delete restrict,
  reporter_staff_id uuid not null references public.staffing_staff(id) on delete restrict,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution text,
  unique(session_id, reporter_staff_id)
);
create table public.staffing_audit (
  id bigint generated always as identity primary key,
  actor text not null,
  action text not null,
  entity_id text,
  details jsonb not null,
  created_at timestamptz not null default now()
);
create table public.staffing_inbox (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);
create table public.staffing_outbox (
  id bigint generated always as identity primary key,
  method text not null default 'sendMessage' check (method in ('sendMessage')),
  payload jsonb not null,
  attempt_id uuid references public.staffing_attempts(id),
  expected_state text,
  delivered_at timestamptz,
  telegram_message_id bigint,
  retry_at timestamptz not null default now(),
  failures integer not null default 0
);
create index on public.staffing_outbox(retry_at) where delivered_at is null;

-- All entry points are server-only. No client supplies its own actor/region.
do $$ declare t text; begin
  foreach t in array array['regions','store_regions','manager_regions','staff','link_tokens','groups','shifts','attempts','sessions','events','reports','audit','inbox','outbox'] loop
    execute format('alter table public.staffing_%I enable row level security', t);
    execute format('revoke all on table public.staffing_%I from public, anon, authenticated', t);
    execute format('grant all on table public.staffing_%I to service_role', t);
  end loop;
end $$;
grant usage, select on sequence public.staffing_audit_id_seq, public.staffing_outbox_id_seq to service_role;

create function public.staffing_actor_stores(p_actor uuid, p_bootstrap boolean)
returns uuid[] language plpgsql stable set search_path = public as $$
declare v_role text;
begin
  if p_bootstrap then return array(select id from stores); end if;
  select role into v_role from app_users where id = p_actor and active;
  if v_role = 'admin' then return array(select id from stores); end if;
  if v_role <> 'manager' or v_role is null then raise exception 'FORBIDDEN'; end if;
  return array(select sr.store_id from staffing_store_regions sr join staffing_manager_regions mr using(region_id) where mr.user_id = p_actor);
end $$;

create function public.staffing_dashboard(p_actor uuid, p_bootstrap boolean)
returns jsonb language plpgsql stable set search_path = public as $$
declare v_stores uuid[]; v_admin boolean;
begin
  v_stores := staffing_actor_stores(p_actor, p_bootstrap);
  v_admin := p_bootstrap or exists(select 1 from app_users where id = p_actor and active and role = 'admin');
  return jsonb_build_object(
    'canConfigure', v_admin,
    'regions', coalesce((select jsonb_agg(to_jsonb(r) order by r.name) from staffing_regions r where v_admin or exists(select 1 from staffing_manager_regions mr where mr.region_id = r.id and mr.user_id = p_actor)), '[]'::jsonb),
    'stores', coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'time_zone',s.time_zone,'active',s.active,'region_id',sr.region_id) order by s.name) from stores s left join staffing_store_regions sr on sr.store_id = s.id where s.id = any(v_stores)), '[]'::jsonb),
    'managers', case when v_admin then coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'username',u.username,'role',u.role,'active',u.active,'region_ids',coalesce((select jsonb_agg(mr.region_id) from staffing_manager_regions mr where mr.user_id = u.id),'[]'::jsonb))) from app_users u),'[]'::jsonb) else '[]'::jsonb end,
    'staff', coalesce((select jsonb_agg(to_jsonb(s) - 'telegram_user_id' || jsonb_build_object('telegram_linked',s.telegram_user_id is not null) order by s.full_name) from staffing_staff s where s.home_store_id = any(v_stores)), '[]'::jsonb),
    'groups', coalesce((select jsonb_agg(to_jsonb(g)) from staffing_groups g where g.store_id = any(v_stores)), '[]'::jsonb),
    'shifts', coalesce((select jsonb_agg(to_jsonb(q) order by q.starts_at desc) from (select * from staffing_shifts where store_id = any(v_stores) and starts_at >= now() - interval '14 days' order by starts_at desc limit 200) q), '[]'::jsonb),
    'sessions', coalesce((select jsonb_agg(to_jsonb(q) order by q.check_in_at desc) from (select se.*, sh.store_id, sh.label, sh.starts_at, sh.ends_at, st.full_name from staffing_sessions se join staffing_shifts sh on sh.id = se.shift_id join staffing_staff st on st.id = se.staff_id where sh.store_id = any(v_stores) order by se.check_in_at desc limit 100) q), '[]'::jsonb),
    'reports', coalesce((select jsonb_agg(to_jsonb(q)) from (select r.*, st.full_name as reporter_name from staffing_reports r join staffing_staff st on st.id = r.reporter_staff_id join staffing_sessions se on se.id = r.session_id join staffing_shifts sh on sh.id = se.shift_id where sh.store_id = any(v_stores) and r.resolved_at is null) q), '[]'::jsonb)
  );
end $$;

create function public.staffing_manage(p_actor uuid, p_bootstrap boolean, p_action text, p_data jsonb)
returns jsonb language plpgsql set search_path = public as $$
declare v_stores uuid[]; v_admin boolean; v_id uuid; v_store uuid; v_staff staffing_staff; v_shift staffing_shifts; v_session staffing_sessions; v_before jsonb; v_result jsonb := '{}'::jsonb;
begin
  v_stores := staffing_actor_stores(p_actor,p_bootstrap);
  v_admin := p_bootstrap or exists(select 1 from app_users where id=p_actor and active and role='admin');
  if p_action in ('region','store_region','manager_region','group') and not v_admin then raise exception 'FORBIDDEN'; end if;
  case p_action
  when 'region' then
    insert into staffing_regions(name) values(trim(p_data->>'name')) returning id into v_id;
  when 'store_region' then
    -- Region changes affect authorization; never silently transfer existing records.
    v_store := (p_data->>'store_id')::uuid;
    if exists(select 1 from staffing_store_regions where store_id=v_store) then raise exception 'Store already has a region; use a reviewed transfer migration'; end if;
    insert into staffing_store_regions(store_id,region_id) values(v_store,(p_data->>'region_id')::uuid);
    v_id := v_store;
  when 'manager_region' then
    if not exists(select 1 from app_users where id=(p_data->>'user_id')::uuid and active and role='manager') then raise exception 'Choose an active manager account'; end if;
    insert into staffing_manager_regions(user_id,region_id) values((p_data->>'user_id')::uuid,(p_data->>'region_id')::uuid) on conflict do nothing;
    v_id := (p_data->>'user_id')::uuid;
  when 'group' then
    v_store := (p_data->>'store_id')::uuid;
    insert into staffing_groups(chat_id,store_id) values((p_data->>'chat_id')::bigint,v_store);
    v_id := v_store;
  when 'staff' then
    v_store := (p_data->>'home_store_id')::uuid;
    if not v_store = any(v_stores) then raise exception 'FORBIDDEN'; end if;
    if not exists(select 1 from stores s join staffing_store_regions sr on s.id=sr.store_id where s.id=v_store and s.active) then raise exception 'Choose an active store with a region'; end if;
    insert into staffing_staff(code,full_name,home_store_id) values(trim(p_data->>'code'),trim(p_data->>'full_name'),v_store) returning id into v_id;
  when 'invite' then
    select * into v_staff from staffing_staff where id=(p_data->>'staff_id')::uuid for update;
    if v_staff.id is null or not v_staff.home_store_id = any(v_stores) then raise exception 'FORBIDDEN'; end if;
    if not v_staff.active or v_staff.telegram_user_id is not null then raise exception 'Staff is inactive or already linked'; end if;
    delete from staffing_link_tokens where staff_id=v_staff.id and used_at is null;
    insert into staffing_link_tokens(token_hash,staff_id,expires_at) values(p_data->>'token_hash',v_staff.id,now()+interval '24 hours');
    v_id := v_staff.id;
    -- Never include token hashes in the audit log.
    p_data := jsonb_build_object('staff_id',v_id);
  when 'shift' then
    select * into v_staff from staffing_staff where id=(p_data->>'staff_id')::uuid for update;
    v_store := (p_data->>'store_id')::uuid;
    if v_staff.id is null or not v_staff.home_store_id=any(v_stores) or not v_store=any(v_stores) then raise exception 'FORBIDDEN'; end if;
    if not v_staff.active then raise exception 'Staff is inactive'; end if;
    if not exists(select 1 from stores s join staffing_store_regions sr on sr.store_id=s.id where s.id=v_store and s.active) then raise exception 'Choose an active store with a region'; end if;
    if exists(select 1 from staffing_shifts where staff_id=v_staff.id and starts_at < (p_data->>'ends_at')::timestamptz and ends_at > (p_data->>'starts_at')::timestamptz) then raise exception 'Shift overlaps an existing assignment'; end if;
    insert into staffing_shifts(staff_id,store_id,label,starts_at,ends_at) values(v_staff.id,v_store,trim(p_data->>'label'),(p_data->>'starts_at')::timestamptz,(p_data->>'ends_at')::timestamptz) returning id into v_id;
  when 'correction' then
    select se.* into v_session from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id where se.id=(p_data->>'session_id')::uuid and sh.store_id=any(v_stores) for update of se;
    if v_session.id is null then raise exception 'FORBIDDEN'; end if;
    if length(trim(coalesce(p_data->>'reason',''))) < 5 then raise exception 'A correction reason is required'; end if;
    v_before := to_jsonb(v_session);
    update staffing_sessions set corrected_in_at=(p_data->>'check_in_at')::timestamptz, corrected_out_at=nullif(p_data->>'check_out_at','')::timestamptz where id=v_session.id;
    p_data := jsonb_build_object('before',v_before,'correction',p_data);
    v_id := v_session.id;
  when 'resolve_report' then
    if length(trim(coalesce(p_data->>'reason',''))) < 5 then raise exception 'A review explanation is required'; end if;
    update staffing_reports r set resolved_at=now(),resolution=trim(p_data->>'reason') from staffing_sessions se,staffing_shifts sh where r.id=(p_data->>'report_id')::uuid and se.id=r.session_id and sh.id=se.shift_id and sh.store_id=any(v_stores) and r.resolved_at is null returning r.id into v_id;
    if v_id is null then raise exception 'FORBIDDEN'; end if;
  else raise exception 'Unknown staffing action';
  end case;
  insert into staffing_audit(actor,action,entity_id,details) values(coalesce(p_actor::text,'bootstrap-super-admin'),p_action,v_id::text,p_data);
  return v_result || jsonb_build_object('id',v_id);
end $$;

-- One transaction per Telegram update: deduplication, state transitions, evidence
-- and outbound notifications commit together. A staff row serializes concurrent
-- attempts, including updates for different groups/stores.
create function public.staffing_apply_update(p_update jsonb)
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
          v_text := 'Akun berhasil ditautkan. Gunakan /masuk dan /pulang di grup store, atau /jadwal di chat pribadi ini.';
        else v_text := 'Akun tidak dapat ditautkan. Hubungi manager untuk pemeriksaan identitas.'; end if;
      else v_text := 'Undangan tidak berlaku atau sudah digunakan. Minta undangan baru dari manager.'; end if;
    else v_text := 'Spark Staffing: tautkan akun melalui undangan manager. Absensi /masuk dan /pulang dilakukan di grup store. Jadwal pribadi: /jadwal.'; end if;
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
    insert into staffing_attempts(staff_id,shift_id,chat_id,kind,state,requested_at,request_message_id) values(v_staff.id,v_shift.id,v_chat,v_kind,'confirmation',v_effective,(p_update->>'messageId')::bigint) returning * into v_attempt;
    select v_staff.full_name||' · '||s.name||E'\n'||v_shift.label||' · '||to_char(v_shift.starts_at at time zone s.time_zone,'DD Mon HH24:MI')||'–'||to_char(v_shift.ends_at at time zone s.time_zone,'DD Mon HH24:MI')||E'\nKonfirmasi '||case when v_kind='check_in' then 'check-in' else 'checkout' end||'. Lanjutkan dengan lokasi dan foto; waktu bukti lengkap menjadi waktu absen.' into v_text from stores s where s.id=v_store;
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
  if v_attempt.expires_at<=now() then
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
    select * into v_shift from staffing_shifts where id=v_attempt.shift_id;
    if v_attempt.kind='check_in' then
      if exists(select 1 from staffing_sessions where staff_id=v_staff.id and coalesce(corrected_out_at,check_out_at) is null) then return; end if;
      insert into staffing_sessions(shift_id,staff_id,check_in_at) values(v_shift.id,v_staff.id,v_effective) returning * into v_session;
    else
      select * into v_session from staffing_sessions where shift_id=v_shift.id and coalesce(corrected_out_at,check_out_at) is null for update;
      if v_session.id is null or v_effective<coalesce(v_session.corrected_in_at,v_session.check_in_at) then return; end if;
      update staffing_sessions set check_out_at=v_effective where id=v_session.id;
    end if;
    update staffing_attempts set state='completed',photo_file_id=p_update->>'fileId',photo_unique_id=p_update->>'fileUniqueId',completed_at=now() where id=v_attempt.id;
    insert into staffing_events(session_id,attempt_id,kind,effective_at,timestamp_source,message_id,update_id) values(v_session.id,v_attempt.id,v_attempt.kind,v_effective,p_update->>'timestampSource',(p_update->>'messageId')::bigint,(p_update->>'updateId')::bigint);
    insert into staffing_audit(actor,action,entity_id,details) values('telegram:'||v_user,v_attempt.kind,v_session.id::text,jsonb_build_object('attempt_id',v_attempt.id));
    select v_staff.full_name||' · '||s.name||E'\n'||case when v_attempt.kind='check_in' then 'Check-in' else 'Checkout' end||' tercatat: '||to_char(v_effective at time zone s.time_zone,'DD Mon HH24:MI:SS')||' ('||s.time_zone||')'||E'\n'||v_shift.label||case when v_attempt.kind='check_in' then ' · Terlambat '||greatest(0,ceil(extract(epoch from(v_effective-v_shift.starts_at))/60))::text||' menit' else '' end||E'\nLokasi dan foto diterima. Lembur dan penalti memerlukan aturan/approval tersendiri.' into v_text from stores s where s.id=v_store;
    insert into staffing_outbox(payload) values(jsonb_build_object('chat_id',v_chat,'text',v_text,'reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Laporkan ketidaksesuaian','callback_data','sf:r:'||v_session.id))))));
  end if;
end $$;

-- Serialize the sender so overlapping webhook retries do not interleave prompts.
create function public.staffing_claim_outbox()
returns setof public.staffing_outbox language sql set search_path=public as $$
  update staffing_outbox set retry_at=now()+interval '90 seconds'
  where id in (select id from staffing_outbox where delivered_at is null and retry_at<=now() order by id limit 1 for update skip locked)
  returning *;
$$;
create function public.staffing_deliver_outbox(p_id bigint,p_message_id bigint)
returns void language plpgsql set search_path=public as $$
declare v_row staffing_outbox;
begin
  update staffing_outbox set delivered_at=now(),telegram_message_id=p_message_id where id=p_id and delivered_at is null returning * into v_row;
  if v_row.attempt_id is not null then
    update staffing_attempts set prompt_message_id=p_message_id where id=v_row.attempt_id and state=v_row.expected_state;
  end if;
end $$;

revoke all on function public.staffing_actor_stores(uuid,boolean), public.staffing_dashboard(uuid,boolean), public.staffing_manage(uuid,boolean,text,jsonb), public.staffing_apply_update(jsonb), public.staffing_claim_outbox(), public.staffing_deliver_outbox(bigint,bigint) from public,anon,authenticated;
grant execute on function public.staffing_actor_stores(uuid,boolean), public.staffing_dashboard(uuid,boolean), public.staffing_manage(uuid,boolean,text,jsonb), public.staffing_apply_update(jsonb), public.staffing_claim_outbox(), public.staffing_deliver_outbox(bigint,bigint) to service_role;

-- Photo references and coordinates are only returned after region authorization.
create function public.staffing_evidence(p_actor uuid,p_bootstrap boolean,p_session uuid default null,p_attempt uuid default null)
returns jsonb language plpgsql stable set search_path=public as $$
declare v_stores uuid[];
begin
  v_stores := staffing_actor_stores(p_actor,p_bootstrap);
  return coalesce((select jsonb_agg(jsonb_build_object('attempt_id',a.id,'kind',a.kind,'latitude',a.latitude,'longitude',a.longitude,'file_id',a.photo_file_id,'requested_at',a.requested_at,'received_at',a.received_at,'completed_at',a.completed_at,'effective_at',e.effective_at,'timestamp_source',e.timestamp_source)) from staffing_events e join staffing_attempts a on a.id=e.attempt_id join staffing_shifts sh on sh.id=a.shift_id where sh.store_id=any(v_stores) and ((p_session is not null and e.session_id=p_session) or (p_attempt is not null and a.id=p_attempt))), '[]'::jsonb);
end $$;
revoke all on function public.staffing_evidence(uuid,boolean,uuid,uuid) from public,anon,authenticated;
grant execute on function public.staffing_evidence(uuid,boolean,uuid,uuid) to service_role;

commit;
