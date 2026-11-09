begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local search_path = public;

-- Extend only the existing timezone contract. Never change saved shift instants.
do $$ declare c record; begin
 for c in select conname from pg_constraint where conrelid='public.stores'::regclass and contype='c'
   and conkey && array(select attnum from pg_attribute where attrelid='public.stores'::regclass and attname in('time_zone','utc_offset')) loop
  if c.conname not in('stores_time_zone_check','stores_utc_offset_check','stores_check') then
   raise exception 'STORE_TIMEZONE_CONSTRAINT_CONFLICT: inspect % before rollout',c.conname;
  end if;
  execute format('alter table public.stores drop constraint %I',c.conname);
 end loop;
end $$;
alter table stores add constraint stores_time_zone_check check(time_zone in('Asia/Jakarta','Asia/Makassar','Asia/Jayapura'));
alter table stores add constraint stores_utc_offset_check check(
 (time_zone='Asia/Jakarta' and utc_offset='+07:00') or
 (time_zone='Asia/Makassar' and utc_offset='+08:00') or
 (time_zone='Asia/Jayapura' and utc_offset='+09:00'));

create function staffing_configure_organization(p_actor uuid,p_bootstrap boolean,p_action text,p_data jsonb)
returns jsonb language plpgsql set search_path=public as $$
declare r staffing_regions; mapping staffing_store_regions; dest uuid; chat bigint; before_value jsonb; result_id uuid;
begin
 perform staffing_actor_stores(p_actor,p_bootstrap);
 if not(p_bootstrap or exists(select 1 from app_users where id=p_actor and active and role='admin')) then raise exception 'FORBIDDEN'; end if;
 if p_action='region_update' then
  select * into r from staffing_regions where id=(p_data->>'region_id')::uuid for update;
  if r.id is null then raise exception 'Region tidak ditemukan'; end if;
  if r.name is distinct from p_data->>'previous_name' then raise exception 'Region sudah berubah. Muat ulang halaman.'; end if;
  if length(trim(coalesce(p_data->>'name',''))) not between 1 and 100 then raise exception 'Isi nama region, 1 sampai 100 karakter'; end if;
  before_value:=to_jsonb(r); result_id:=r.id;
  update staffing_regions set name=trim(p_data->>'name') where id=r.id;
 elsif p_action='store_region_update' then
  perform id from stores where id=(p_data->>'store_id')::uuid and active for update;
  if not found then raise exception 'Pilih store aktif'; end if;
  select * into mapping from staffing_store_regions where store_id=(p_data->>'store_id')::uuid for update;
  if mapping.store_id is null or mapping.region_id is distinct from (p_data->>'previous_region_id')::uuid then raise exception 'Region store sudah berubah. Muat ulang halaman.'; end if;
  dest:=(p_data->>'region_id')::uuid;
  if not exists(select 1 from staffing_regions where id=dest) then raise exception 'Pilih region yang valid'; end if;
  if mapping.region_id=dest then return jsonb_build_object('id',mapping.store_id); end if;
  if length(trim(coalesce(p_data->>'note',''))) not between 5 and 500 then raise exception 'Isi alasan perubahan, 5 sampai 500 karakter'; end if;
  select chat_id into chat from staffing_groups where store_id=mapping.store_id;
  perform staffing_lock_group(chat);
  if exists(select 1 from staffing_attempts a join staffing_shifts s on s.id=a.shift_id where s.store_id=mapping.store_id and a.state in('confirmation','location','photo') and a.expires_at>now())
    or exists(select 1 from staffing_shift_requests where store_id=mapping.store_id and status in('pending_peer','pending_manager') and expires_at>now())
    or exists(select 1 from staffing_swap_flows where chat_id=chat and expires_at>now()) then
   raise exception 'Selesaikan proses absensi dan tukar shift sebelum memindahkan region store';
  end if;
  before_value:=to_jsonb(mapping); result_id:=mapping.store_id;
  update staffing_store_regions set region_id=dest where store_id=mapping.store_id;
 else raise exception 'Unknown organization action'; end if;
 insert into staffing_audit(actor,action,entity_id,details) values(coalesce(p_actor::text,'bootstrap-super-admin'),p_action,result_id::text,jsonb_build_object('before',before_value,'change',p_data));
 return jsonb_build_object('id',result_id);
end $$;

alter table staffing_requests add column evidence_file_id text;
alter table staffing_requests add column evidence_unique_id text;
alter table staffing_requests add column evidence_mime text check(evidence_mime in('image/jpeg','image/png','application/pdf'));
alter table staffing_requests add column evidence_message_id bigint;
alter table staffing_requests add column evidence_chat_id bigint;
alter table staffing_requests add column evidence_sent_at timestamptz;
create table staffing_private_flows(
 user_id bigint primary key check(user_id>0),staff_id uuid not null references staffing_staff(id),
 chat_id bigint not null check(chat_id=user_id),
 token text not null default substr(replace(gen_random_uuid()::text,'-',''),1,12),
 step text not null check(step in('type','amount','start','end','reason','evidence','confirm')),
 data jsonb not null default '{}',prompt_message_id bigint,
 created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '30 minutes'
);
alter table staffing_private_flows enable row level security;
revoke all on staffing_private_flows from public,anon,authenticated;
grant all on staffing_private_flows to service_role;
alter table staffing_outbox add column private_flow_token text;

create function staffing_private_prompt(p_user bigint,p_hint text default '') returns void language plpgsql set search_path=public as $$
declare f staffing_private_flows; body text; keys jsonb:='[]'; row record; money jsonb; available numeric;
begin
 update staffing_private_flows set token=substr(replace(gen_random_uuid()::text,'-',''),1,12),prompt_message_id=null where user_id=p_user and expires_at>now() returning * into f;
 if f.user_id is null then return; end if;
 case f.step
 when 'type' then
  body:='Pilih jenis izin. Pengajuan baru berlaku setelah manager menyetujui.';
  for row in select * from(values('paid_leave','Izin berbayar'),('unpaid_leave','Izin tanpa upah'),('sick','Sakit')) as t(id,label) loop
   keys:=keys||jsonb_build_array(jsonb_build_array(jsonb_build_object('text',row.label,'callback_data','rf:type:'||f.token||':'||row.id)));
  end loop;
 when 'amount' then
  money:=staffing_staff_money(f.staff_id);
  available:=greatest(coalesce((money->>'available')::numeric,0)-coalesce((select sum(amount) from staffing_requests where staff_id=f.staff_id and kind='cash_advance' and status='pending'),0),0);
  body:='Masukkan nominal kasbon dalam rupiah, angka saja (contoh 50000).'||E'\nBisa diajukan sekarang: Rp'||available||E'\nPengajuan pending ikut diperhitungkan agar tidak melebihi plafon.';
 when 'start' then body:='Tanggal mulai izin / sakit? Balas dengan DD/MM/YYYY (contoh 15/11/2026), sesuai tanggal lokal store. Maksimal 62 hari per pengajuan.';
 when 'end' then body:='Tanggal selesai izin / sakit? Balas dengan DD/MM/YYYY. Untuk satu hari, masukkan tanggal mulai yang sama.';
 when 'reason' then body:='Tuliskan alasan izin / sakit, 5–2000 karakter. Alasan dan bukti hanya terlihat olehmu dan manager.';
 when 'evidence' then body:='Lampirkan bukti sebagai foto atau dokumen PDF/JPG/PNG (maksimal 10 MB). Balas langsung pesan ini dengan lampirannya.';
 when 'confirm' then
  if f.data->>'kind'='cash_advance' then body:='Ajukan kasbon Rp'||(f.data->>'amount')||'?';
  else body:='Periksa pengajuan '||case f.data->>'kind' when 'paid_leave' then 'izin berbayar' when 'sick' then 'sakit' else 'izin tanpa upah' end||E'\n'||to_char((f.data->>'start_date')::date,'DD/MM/YYYY')||' – '||to_char((f.data->>'end_date')::date,'DD/MM/YYYY')||E'\n'||((f.data->>'end_date')::date-(f.data->>'start_date')::date+1)||' hari kalender (termasuk semua tanggal dalam rentang).'||E'\nAlasan: '||(f.data->>'reason')||E'\nBukti terlampir. Bila perlu setengah hari / mengecualikan tanggal libur, minta manager mencatat pengajuan yang sesuai.'; end if;
  keys:=jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Kirim pengajuan','callback_data','rf:send:'||f.token||':yes')));
 end case;
 body:=coalesce(nullif(p_hint,'' )||E'\n\n','')||body||E'\n/batal untuk membuang draft ini. Draft kedaluwarsa dalam 30 menit sejak dimulai.';
 insert into staffing_outbox(payload,private_flow_token) values(jsonb_build_object('chat_id',p_user,'text',body,'reply_markup',case when f.step in('type','confirm') then jsonb_build_object('inline_keyboard',keys) else jsonb_build_object('force_reply',true,'selective',true) end),f.token);
end $$;

-- Preserve attendance receipts and bind private text to the exact current prompt.
alter function staffing_deliver_outbox(bigint,bigint) rename to staffing_deliver_outbox_v5;
create function staffing_deliver_outbox(p_id bigint,p_message_id bigint) returns void language plpgsql set search_path=public as $$
declare o staffing_outbox; begin
 select * into o from staffing_outbox where id=p_id;
 perform staffing_deliver_outbox_v5(p_id,p_message_id);
 if o.private_flow_token is not null then
  update staffing_private_flows set prompt_message_id=p_message_id where user_id=(o.payload->>'chat_id')::bigint and token=o.private_flow_token and expires_at>now();
 end if;
end $$;

create function staffing_private_request(p_update jsonb) returns void language plpgsql set search_path=public as $$
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
  if p_update->>'choice' not in('leave','cash') then return; end if;
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
  insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Draft kedaluwarsa. Mulai kembali dari /izin atau /kasbon.')); return;
 end if;
 if sent<f.created_at-interval '1 second' then return; end if;
 if k='request_pick' then
  if f.token is distinct from p_update->>'flowToken' then return; end if;
  if f.step='type' and p_update->>'choice'='type' and p_update->>'entityId' in('paid_leave','unpaid_leave','sick') then
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
    perform staffing_private_prompt(uid,'Saldo izin berbayar tidak cukup setelah memperhitungkan pengajuan pending. /batal lalu pilih izin tanpa upah atau hubungi manager.'); return;
   end if;
   if exists(select 1 from staffing_requests r where r.staff_id=st.id and r.kind<>'cash_advance' and r.status in('pending','approved') and r.start_date<=(f.data->>'end_date')::date and r.end_date>=(f.data->>'start_date')::date) then
    perform staffing_private_prompt(uid,'Tanggal bertabrakan dengan pengajuan lain. /batal lalu pilih tanggal lain atau hubungi manager.'); return;
   end if;
   insert into staffing_requests(staff_id,kind,payment_mode,start_date,end_date,leave_dates,days,reason,created_by,evidence_file_id,evidence_unique_id,evidence_mime,evidence_chat_id,evidence_message_id,evidence_sent_at)
   values(st.id,f.data->>'kind',case f.data->>'kind' when 'paid_leave' then 'leave' when 'sick' then 'sick' else 'none' end,(f.data->>'start_date')::date,(f.data->>'end_date')::date,dates,jsonb_array_length(dates),f.data->>'reason','telegram:'||uid,f.data->>'evidence_file_id',f.data->>'evidence_unique_id',f.data->>'evidence_mime',chat,(f.data->>'evidence_message_id')::bigint,(f.data->>'evidence_sent_at')::timestamptz) returning id into request_id;
  end if;
  delete from staffing_private_flows where user_id=uid;
  insert into staffing_audit(actor,action,entity_id,details)values('telegram:'||uid,'submit_personal_request',request_id::text,jsonb_build_object('kind',f.data->>'kind'));
  insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text','Pengajuan terkirim. Menunggu review manager. Lihat status di /izin atau /kasbon.')); return;
 end if;
 if (p_update->>'replyTo')::bigint is distinct from f.prompt_message_id or f.prompt_message_id is null then return; end if;
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

create function staffing_request_evidence(p_actor uuid,p_bootstrap boolean,p_request uuid) returns jsonb language plpgsql stable set search_path=public as $$
declare r staffing_requests; begin
 select * into r from staffing_requests where id=p_request;
 if r.id is null then return null; end if;
 perform staffing_require_staff(p_actor,p_bootstrap,r.staff_id);
 return case when r.evidence_file_id is not null then jsonb_build_object('file_id',r.evidence_file_id,'mime',r.evidence_mime) end;
end $$;

create or replace function staffing_bot_private(p_user bigint,p_chat bigint,p_kind text)returns void language plpgsql set search_path=public as $$
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
  body:='Izin & sakit saya'||E'\nSaldo izin: '||coalesce(money->>'leave_balance','Belum dicatat')||E'\n'||coalesce(lines,'Belum ada pengajuan.')||E'\nPilih Ajukan izin / sakit untuk membuat pengajuan pribadi.';
 when 'cash_status'then
  select string_agg(q.line,E'\n')into lines from(select to_char(created_at at time zone zone,'DD/MM/YYYY')||' · Rp'||amount||' · '||case status when 'pending'then 'Menunggu review'when 'approved'then 'Menunggu pencairan'when 'disbursed'then 'Dicairkan'when 'rejected'then 'Ditolak'else 'Dibatalkan'end as line from staffing_requests where staff_id=st.id and kind='cash_advance'order by created_at desc limit 10)q;
  body:='Kasbon saya'||E'\nPlafon: Rp'||coalesce(money->>'ceiling','Belum diatur')||E'\nTersedia: Rp'||coalesce(money->>'available','Belum diatur')||E'\nBelum lunas: Rp'||(money->>'outstanding')||E'\n'||coalesce(lines,'Belum ada pengajuan kasbon.')||E'\nPengajuan pending: Rp'||coalesce((select sum(amount)::text from staffing_requests where staff_id=st.id and kind='cash_advance' and status='pending'),'0')||E'\nBisa diajukan sekarang: Rp'||greatest(coalesce((money->>'available')::numeric,0)-coalesce((select sum(amount) from staffing_requests where staff_id=st.id and kind='cash_advance' and status='pending'),0),0)||E'\nPilih Ajukan kasbon untuk melanjutkan.';
 else body:='Menu pribadi · '||st.full_name||E'\nPilih informasi milikmu. Perubahan plafon, saldo, tarif dan koreksi waktu hanya dilakukan manager melalui dashboard.';
 end case;
 buttons:='[[{"text":"Jadwal saya","callback_data":"sm:schedule"},{"text":"Absensi saya","callback_data":"sm:history"}],[{"text":"Saldo saya","callback_data":"sm:balance"},{"text":"Izin & sakit","callback_data":"sm:leave"}],[{"text":"Kasbon saya","callback_data":"sm:cash"},{"text":"Penghasilan saya","callback_data":"sm:income"}]]';
 if p_kind='help' then body:='Pribadi: /izin untuk informasi dan pengajuan izin / sakit; /kasbon untuk informasi dan pengajuan kasbon. Balas langsung pertanyaan bot untuk mengisi data. /batal membuang draft di chat ini; tidak menghapus pengajuan / absensi yang sudah terkirim. Permintaan tukar yang sudah terkirim dibatalkan lewat tombol pada permintaan.'; end if;
 if p_kind='leave_status' then buttons:=jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Ajukan izin / sakit','callback_data','rq:leave')))||buttons; end if;
 if p_kind='cash_status' then buttons:=jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Ajukan kasbon','callback_data','rq:cash')))||buttons; end if;
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',p_chat,'text',body,'reply_markup',jsonb_build_object('inline_keyboard',buttons)));
end$$;


create or replace function staffing_swap_prompt(p_user bigint,p_chat bigint)returns void language plpgsql set search_path=public as $$
declare f staffing_swap_flows;st staffing_staff;g uuid;items jsonb;buttons jsonb:='[]';row jsonb;total integer;title text;nav jsonb:='[]';begin
 select * into f from staffing_swap_flows where user_id=p_user and chat_id=p_chat;
 select * into st from staffing_staff where telegram_user_id=p_user and active;
 select store_id into g from staffing_groups where chat_id=p_chat;
 if f.user_id is null or st.id is null or g is null or f.expires_at<=now()then return;end if;
 update staffing_swap_flows set token=substr(replace(gen_random_uuid()::text,'-',''),1,12)where user_id=p_user and chat_id=p_chat returning * into f;
 if f.step='mode'then
  items:='[{"id":"replace","label":"Minta pengganti"},{"id":"swap","label":"Tukar dua shift"}]';title:='Pilih jenis perubahan dengan '||(select full_name from staffing_staff where id=(f.data->>'target')::uuid)||'. Jadwal baru berlaku setelah pihak kedua dan manager menyetujui.';
 elsif f.step='shift'then
  select coalesce(jsonb_agg(to_jsonb(q)order by q.starts_at),'[]')into items from(select sh.id,sh.starts_at,sh.label||' · '||to_char(sh.starts_at at time zone so.time_zone,'DD/MM HH24:MI')||'–'||to_char(sh.ends_at at time zone so.time_zone,'DD/MM HH24:MI')as label
   from staffing_shifts sh join stores so on so.id=sh.store_id where sh.staff_id=st.id and sh.store_id=g and sh.starts_at>now()and sh.starts_at<now()+interval '90 days'and not exists(select 1 from staffing_attempts where shift_id=sh.id)and not exists(select 1 from staffing_sessions where shift_id=sh.id)and not exists(select 1 from staffing_shift_requests r where r.shift_id=sh.id and r.status in('pending_peer','pending_manager')and r.expires_at>now()and staffing_shift_request_valid(r.id))order by sh.starts_at offset f.page*8 limit 9)q;
  title:='Pilih shift milikmu yang ingin diganti / ditukar (maksimal 90 hari ke depan).';
 elsif f.step='person'then
  select coalesce(jsonb_agg(to_jsonb(q)order by q.label,q.id),'[]')into items from(select s.id,s.full_name as label from staffing_staff s
   join staffing_store_regions sr on sr.store_id=s.home_store_id join staffing_store_regions dest on dest.store_id=g and dest.region_id=sr.region_id
   where s.active and s.telegram_user_id is not null and s.id<>st.id order by s.full_name,s.id offset f.page*8 limit 9)q;
  title:='Pilih nama rekan yang jadwalnya ingin kamu tukar, atau yang akan diminta menggantikanmu. Hanya staff aktif yang sudah menautkan Telegram dalam region ini.';
 else
  select coalesce(jsonb_agg(to_jsonb(q)order by q.starts_at),'[]')into items from(select sh.id,sh.starts_at,sh.label||' · '||to_char(sh.starts_at at time zone so.time_zone,'DD/MM HH24:MI')||'–'||to_char(sh.ends_at at time zone so.time_zone,'DD/MM HH24:MI')as label
   from staffing_shifts sh join stores so on so.id=sh.store_id where sh.staff_id=(f.data->>'target')::uuid and sh.store_id=g and sh.starts_at>now()and sh.starts_at<now()+interval '90 days'and not exists(select 1 from staffing_attempts where shift_id=sh.id)and not exists(select 1 from staffing_sessions where shift_id=sh.id)order by sh.starts_at offset f.page*8 limit 9)q;
  title:='Pilih jadwal '||(select full_name from staffing_staff where id=(f.data->>'target')::uuid)||' yang ingin kamu ambil. Berikutnya pilih shift milikmu untuk ditukar.';
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


create or replace function staffing_swap_pick(p_update jsonb) returns void language plpgsql set search_path=public as $$
declare f staffing_swap_flows; st staffing_staff; target staffing_staff; sh staffing_shifts; other staffing_shifts; r staffing_shift_requests;
 g uuid; uid bigint:=(p_update->>'userId')::bigint; chat bigint:=(p_update->>'chatId')::bigint; entity text:=p_update->>'entityId';
begin
 select * into f from staffing_swap_flows where user_id=uid and chat_id=chat and token=p_update->>'flowToken' and expires_at>now() for update;
 select * into st from staffing_staff where telegram_user_id=uid and active;
 select store_id into g from staffing_groups where chat_id=chat;
 if f.user_id is null or st.id is null or g is null then return; end if;
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
 insert into staffing_outbox(payload)values(jsonb_build_object('chat_id',chat,'text',staffing_shift_request_text(r.id)||E'\n'||target.full_name||', apakah bersedia? Hanya akun pihak kedua yang dapat menyetujui / menolak. Setelah itu perlu persetujuan manager. Jadwal belum berubah.','reply_markup',jsonb_build_object('inline_keyboard',jsonb_build_array(jsonb_build_array(jsonb_build_object('text','Saya bersedia','callback_data','sr:y:'||r.id),jsonb_build_object('text','Tolak','callback_data','sr:n:'||r.id)),jsonb_build_array(jsonb_build_object('text','Batalkan permintaan','callback_data','sr:x:'||r.id))))));
end $$;

-- Old selection keyboards used a different step order. Expire only these
-- transient drafts; submitted peer/manager requests and schedules are preserved.
update staffing_swap_flows set expires_at=least(expires_at,now());

-- Keep the group lock and existing attendance/peer-consent dispatcher intact.
create or replace function staffing_apply_update(p_update jsonb) returns void language plpgsql set search_path=public as $$
declare k text:=p_update->>'kind'; uid bigint:=(p_update->>'userId')::bigint; chat bigint:=(p_update->>'chatId')::bigint;
 st staffing_staff; g uuid; swap_deleted boolean; attendance_cancelled boolean;
begin
 if uid is null or uid<=0 or chat is null or (p_update->>'chatType'='private' and uid<>chat) then return; end if;
 perform staffing_lock_group(chat);
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

revoke all on function staffing_configure_organization(uuid,boolean,text,jsonb),staffing_private_prompt(bigint,text),staffing_private_request(jsonb),staffing_request_evidence(uuid,boolean,uuid),staffing_deliver_outbox_v5(bigint,bigint),staffing_deliver_outbox(bigint,bigint),staffing_apply_update(jsonb) from public,anon,authenticated;
grant execute on function staffing_configure_organization(uuid,boolean,text,jsonb),staffing_private_prompt(bigint,text),staffing_private_request(jsonb),staffing_request_evidence(uuid,boolean,uuid),staffing_deliver_outbox_v5(bigint,bigint),staffing_deliver_outbox(bigint,bigint),staffing_apply_update(jsonb) to service_role;
commit;
