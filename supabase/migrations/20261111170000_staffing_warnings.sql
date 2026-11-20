begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local search_path=public;

create table staffing_warnings(
 id uuid primary key default gen_random_uuid(),staff_id uuid not null references staffing_staff(id),store_id uuid not null references stores(id),
 status text not null default 'draft'check(status in('draft','issued','revoked')),revision integer not null default 0,
 data jsonb not null,number text unique,snapshot jsonb,issued_points integer check(issued_points between 1 and 4),
 points_before integer,points_after integer,created_by text not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 issued_by text,issued_at timestamptz,revoked_at timestamptz,revocation_reason text,
 check((status='draft'and number is null and snapshot is null and issued_at is null)or(status in('issued','revoked')and number is not null and snapshot is not null and issued_at is not null))
);
create index on staffing_warnings(staff_id,created_at desc);
create table staffing_warning_sequences(year integer primary key,sequence integer not null check(sequence>0));
create table staffing_warning_events(
 id bigint generated always as identity primary key,staff_id uuid not null references staffing_staff(id),warning_id uuid references staffing_warnings(id),
 event text not null,actor text not null,details jsonb not null default '{}',created_at timestamptz not null default now()
);
create index on staffing_warning_events(staff_id,created_at desc);
create index on staffing_warning_events(warning_id,created_at desc);
create table staffing_warning_deliveries(
 warning_id uuid not null references staffing_warnings(id),document_version text not null,staff_id uuid not null references staffing_staff(id),
 telegram_user_id bigint not null check(telegram_user_id>0),recipient_version text not null,
 state text not null check(state in('sending','sent','failed','uncertain')),token uuid not null default gen_random_uuid(),
 actor text not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),message_id bigint,
 primary key(warning_id,document_version)
);
do $$declare t text;begin foreach t in array array['warnings','warning_sequences','warning_events','warning_deliveries']loop
 execute format('alter table staffing_%I enable row level security',t);
 execute format('revoke all on staffing_%I from public,anon,authenticated',t);
 execute format('grant all on staffing_%I to service_role',t);
end loop;end $$;
grant usage,select on sequence staffing_warning_events_id_seq to service_role;

-- Retain all existing positive SP entries. New entries form an immutable ledger.
alter table staffing_discipline add column entry_kind text not null default 'legacy' check(entry_kind in('legacy','warning','reduction','reversal'));
alter table staffing_discipline add column warning_id uuid references staffing_warnings(id);
alter table staffing_discipline add column actor text not null default 'legacy';
alter table staffing_discipline add column context jsonb not null default '{}';
alter table staffing_discipline drop constraint staffing_discipline_points_check;
alter table staffing_discipline add constraint staffing_discipline_points_check check(
 (entry_kind in('legacy','warning')and points between 1 and 4)or(entry_kind in('reduction','reversal')and points between -1000000 and -1));
create unique index staffing_warning_points_once on staffing_discipline(warning_id,entry_kind)where warning_id is not null;

create function staffing_points_summary(p_staff uuid)returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object('balance',coalesce(sum(points),0),'version',md5(coalesce(jsonb_agg(jsonb_build_array(id,points)order by id),'[]')::text))from staffing_discipline where staff_id=p_staff;
$$;
create function staffing_guard_points()returns trigger language plpgsql set search_path=public as $$
declare balance bigint;begin
 if tg_op<>'INSERT'then raise exception 'Riwayat poin tidak dapat diubah / dihapus; buat penyesuaian baru';end if;
 perform id from staffing_staff where id=new.staff_id for update;
 select coalesce(sum(points),0)into balance from staffing_discipline where staff_id=new.staff_id;
 if balance+new.points<0 then raise exception 'Saldo poin tidak boleh negatif';end if;
 return new;
end $$;
create trigger staffing_points_guard before insert or update or delete on staffing_discipline for each row execute function staffing_guard_points();

create function staffing_warning_log(p_warning uuid,p_staff uuid,p_actor text,p_event text,p_details jsonb default '{}')returns void language plpgsql set search_path=public as $$begin
 insert into staffing_warning_events(warning_id,staff_id,actor,event,details)values(p_warning,p_staff,p_actor,p_event,p_details);
 insert into staffing_audit(actor,action,entity_id,details)values(p_actor,'warning_'||p_event,coalesce(p_warning,p_staff)::text,p_details);
end $$;

create function staffing_warning_validate(p_input jsonb,p_complete boolean)returns jsonb language plpgsql stable set search_path=public as $$
declare data jsonb:='{}';field text;value text;day date;level integer;severity text;begin
 if jsonb_typeof(p_input)is distinct from 'object'then raise exception 'Isi rincian surat';end if;
 foreach field in array array['subject','job_title','incident_place','chronology','findings','policy_reference','clarification','corrective_actions','consequences','sanction_note','issue_city','signer_name','signer_role']loop
  value:=trim(coalesce(p_input->>field,''));
  if length(value)>(case when field in('chronology','findings','clarification','corrective_actions','consequences','sanction_note','policy_reference')then 4000 else 200 end)then raise exception 'Rincian surat terlalu panjang: %',field;end if;
  data:=data||jsonb_build_object(field,value);
 end loop;
 foreach field in array array['letter_date','incident_date','monitoring_start','monitoring_end']loop
  value:=trim(coalesce(p_input->>field,''));
  if value<>''then
   if value!~'^\d{4}-\d{2}-\d{2}$'then raise exception 'Format tanggal surat tidak valid';end if;
   day:=value::date;if to_char(day,'YYYY-MM-DD')<>value then raise exception 'Tanggal surat tidak valid';end if;
  end if;
  data:=data||jsonb_build_object(field,value);
 end loop;
 value:=trim(coalesce(p_input->>'incident_time',''));
 if value<>''and(value!~'^\d{2}:\d{2}$'or value::time>time '23:59')then raise exception 'Jam kejadian tidak valid';end if;
 data:=data||jsonb_build_object('incident_time',value);
 level:=coalesce(nullif(p_input->>'level',''),'1')::integer;severity:=coalesce(p_input->>'severity','light');
 if level not between 1 and 3 or severity not in('light','moderate','severe','critical')then raise exception 'Pilih tingkat surat dan bobot pelanggaran';end if;
 data:=data||jsonb_build_object('level',level,'severity',severity);
 if p_complete then
  foreach field in array array['letter_date','incident_date','monitoring_start','monitoring_end','subject','job_title','incident_place','chronology','findings','policy_reference','corrective_actions','consequences','issue_city','signer_name','signer_role']loop
   if length(data->>field)<(case when field='chronology'then 20 when field in('findings','corrective_actions')then 10 when field in('policy_reference','consequences','subject')then 5 else 1 end)then raise exception 'Lengkapi isian surat: %',field;end if;
  end loop;
  if(data->>'incident_date')::date>(data->>'letter_date')::date or(data->>'monitoring_start')::date<(data->>'letter_date')::date or(data->>'monitoring_end')::date<(data->>'monitoring_start')::date then raise exception 'Periksa tanggal kejadian, surat, dan masa pembinaan';end if;
 end if;
 return data;
end $$;

create function staffing_warning_list(p_actor uuid,p_bootstrap boolean,p_staff uuid)returns jsonb language plpgsql stable set search_path=public as $$
declare st staffing_staff;begin
 st:=staffing_require_staff(p_actor,p_bootstrap,p_staff);
 return jsonb_build_object('points',staffing_points_summary(st.id),
 'warnings',coalesce((select jsonb_agg(jsonb_build_object('id',w.id,'number',w.number,'status',w.status,'revision',w.revision,'level',w.data->'level','severity',w.data->>'severity','points',w.issued_points,'subject',w.data->>'subject','letter_date',w.data->>'letter_date','monitoring_end',w.data->>'monitoring_end','created_at',w.created_at,'issued_at',w.issued_at)order by w.created_at desc)from staffing_warnings w where w.staff_id=st.id),'[]'),
 'ledger',coalesce((select jsonb_agg(to_jsonb(d)order by d.created_at desc,d.id)from staffing_discipline d where d.staff_id=st.id),'[]'),
 'events',coalesce((select jsonb_agg(to_jsonb(q)order by q.created_at desc,q.id desc)from(select e.id,e.warning_id,e.event,e.details,e.created_at,coalesce(u.username,case e.actor when 'bootstrap-super-admin'then 'Admin'else e.actor end)as actor_label from staffing_warning_events e left join app_users u on u.id::text=e.actor where e.staff_id=st.id)q),'[]'));
end $$;

create function staffing_warning_document(p_actor uuid,p_bootstrap boolean,p_warning uuid)returns jsonb language plpgsql stable set search_path=public as $$
declare w staffing_warnings;st staffing_staff;store stores;render jsonb;version text;delivery staffing_warning_deliveries;begin
 select * into w from staffing_warnings where id=p_warning;
 if w.id is null then raise exception 'Surat tidak ditemukan';end if;
 st:=staffing_require_staff(p_actor,p_bootstrap,w.staff_id);select * into store from stores where id=st.home_store_id;
 render:=case when w.status='draft'then jsonb_build_object('staff_name',st.full_name,'staff_code',st.code,'store_name',store.name,'time_zone',store.time_zone,'data',w.data)else w.snapshot end;
 version:=md5(jsonb_build_object('warning',to_jsonb(w),'render',render)::text);
 select * into delivery from staffing_warning_deliveries where warning_id=w.id and document_version=version;
 return render||jsonb_build_object('id',w.id,'staff_id',st.id,'status',w.status,'revision',w.revision,'number',w.number,'issued_points',w.issued_points,'points_before',w.points_before,'points_after',w.points_after,'issued_at',w.issued_at,'revoked_at',w.revoked_at,'revocation_reason',w.revocation_reason,'document_version',version,
 'recipient_linked',st.active and st.telegram_user_id is not null,'recipient_version',md5(jsonb_build_object('id',st.id,'telegram',st.telegram_user_id,'active',st.active)::text),'delivery_state',delivery.state,'delivery_updated_at',delivery.updated_at);
end $$;

create function staffing_warning_detail(p_actor uuid,p_bootstrap boolean,p_warning uuid)returns jsonb language plpgsql stable set search_path=public as $$
declare doc jsonb;begin
 doc:=staffing_warning_document(p_actor,p_bootstrap,p_warning);
 return doc||jsonb_build_object('events',coalesce((select jsonb_agg(to_jsonb(q)order by q.created_at desc,q.id desc)from(select e.id,e.event,e.details,e.created_at,coalesce(u.username,case e.actor when 'bootstrap-super-admin'then 'Admin'else e.actor end)as actor_label from staffing_warning_events e left join app_users u on u.id::text=e.actor where e.warning_id=p_warning)q),'[]'));
end $$;

create function staffing_warning_manage(p_actor uuid,p_bootstrap boolean,p_action text,p_data jsonb)returns jsonb language plpgsql set search_path=public as $$
declare st staffing_staff;w staffing_warnings;store stores;staff_id uuid;warning_id uuid:=nullif(p_data->>'warning_id','')::uuid;
 actor text:=coalesce(p_actor::text,'bootstrap-super-admin');key_id uuid:=(p_data->>'client_id')::uuid;cache staffing_operation_keys;v_result jsonb;v_data jsonb;before_value jsonb;summary jsonb;
 points integer;balance integer;reversed integer;note text;v_year integer;seq integer;v_number text;begin
 if p_action not in('save_draft','issue','reduce_points','revoke','resolve_delivery')then raise exception 'Aksi peringatan tidak tersedia';end if;
 if warning_id is not null then select * into w from staffing_warnings where id=warning_id;staff_id:=w.staff_id;else staff_id:=(p_data->>'staff_id')::uuid;end if;
 st:=staffing_require_staff(p_actor,p_bootstrap,staff_id);select * into st from staffing_staff where id=st.id for update;
 perform staffing_require_staff(p_actor,p_bootstrap,st.id);
 if warning_id is not null then select * into w from staffing_warnings where id=warning_id for update;end if;
 if key_id is null then raise exception 'Identitas perubahan wajib diisi';end if;
 insert into staffing_operation_keys(key,actor,action,data_hash)values(key_id,actor,'warning:'||p_action,md5((p_data-'client_id')::text))on conflict do nothing;
 if not found then
  select * into cache from staffing_operation_keys where key=key_id;
  if cache.actor<>actor or cache.action<>'warning:'||p_action or cache.data_hash<>md5((p_data-'client_id')::text)then raise exception 'Permintaan sudah tercatat dengan data lain; muat ulang';end if;
  return cache.result;
 end if;
 summary:=staffing_points_summary(st.id);balance:=(summary->>'balance')::integer;
 select * into store from stores where id=st.home_store_id;
 before_value:=case when w.id is not null then to_jsonb(w)else '{}'end;
 if p_action='save_draft'then
  v_data:=staffing_warning_validate(p_data->'data',false);
  if warning_id is null then
   insert into staffing_warnings(staff_id,store_id,data,created_by)values(st.id,store.id,v_data,actor)returning * into w;
   perform staffing_warning_log(w.id,st.id,actor,'draft_created',jsonb_build_object('after',v_data));
  else
   if w.status<>'draft'then raise exception 'Surat yang sudah diterbitkan tidak dapat diedit';end if;
   if p_data->>'revision'is null or(p_data->>'revision')::integer<>w.revision then raise exception 'WARNING_STALE';end if;
   update staffing_warnings set data=v_data,store_id=store.id,revision=revision+1,updated_at=now()where id=w.id returning * into w;
   perform staffing_warning_log(w.id,st.id,actor,'draft_updated',jsonb_build_object('before',before_value->'data','after',w.data));
  end if;
 elsif p_action='reduce_points'then
  if p_data->>'points_version'is distinct from summary->>'version'then raise exception 'POINTS_STALE';end if;
  points:=(p_data->>'points')::integer;note:=trim(p_data->>'reason');
  if points is null or points<1 or points>balance or length(coalesce(note,''))not between 5 and 2000 then raise exception 'Isi pengurangan poin sesuai saldo serta alasan minimal 5 karakter';end if;
  insert into staffing_discipline(staff_id,points,reason,entry_kind,actor,context)values(st.id,-points,note,'reduction',actor,jsonb_build_object('before',balance,'after',balance-points));
  perform staffing_warning_log(null,st.id,actor,'points_reduced',jsonb_build_object('points',points,'before',balance,'after',balance-points,'reason',note));
 elsif p_action='issue'then
  if w.id is null or w.status<>'draft'then raise exception 'Hanya draft yang dapat diterbitkan';end if;
  if p_data->>'revision'is null or(p_data->>'revision')::integer<>w.revision then raise exception 'WARNING_STALE';end if;
  if p_data->>'points_version'is distinct from summary->>'version'then raise exception 'POINTS_STALE';end if;
  if not st.active then raise exception 'Staf tidak aktif';end if;
  if w.store_id<>store.id then raise exception 'Home store berubah. Simpan ulang draft untuk memeriksa konteks surat';end if;
  if coalesce((p_data->>'acknowledged')::boolean,false)is not true then raise exception 'Konfirmasi pemeriksaan surat sebelum diterbitkan';end if;
  v_data:=staffing_warning_validate(w.data,true);
  if(v_data->>'letter_date')::date>(now()at time zone store.time_zone)::date then raise exception 'Tanggal surat tidak boleh di masa depan';end if;
  points:=case v_data->>'severity'when 'light'then 1 when 'moderate'then 2 when 'severe'then 3 else 4 end;
  v_year:=extract(year from(v_data->>'letter_date')::date)::integer;
  insert into staffing_warning_sequences(year,sequence)values(v_year,1)on conflict(year)do update set sequence=staffing_warning_sequences.sequence+1 returning sequence into seq;
  v_number:=lpad(seq::text,greatest(3,length(seq::text)),'0')||'/SP'||(v_data->>'level')||'/SARKOP/'||(array['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'])[extract(month from(v_data->>'letter_date')::date)::integer]||'/'||v_year;
  update staffing_warnings set status='issued',revision=revision+1,number=v_number,data=v_data,snapshot=jsonb_build_object('staff_name',st.full_name,'staff_code',st.code,'store_name',store.name,'time_zone',store.time_zone,'data',v_data),issued_points=points,points_before=balance,points_after=balance+points,issued_at=now(),issued_by=actor,updated_at=now()where id=w.id returning * into w;
  insert into staffing_discipline(staff_id,points,reason,entry_kind,warning_id,actor,context)values(st.id,points,v_data->>'subject','warning',w.id,actor,jsonb_build_object('before',balance,'after',balance+points));
  perform staffing_warning_log(w.id,st.id,actor,'issued',jsonb_build_object('number',w.number,'points',points,'before',balance,'after',balance+points));
 elsif p_action='revoke'then
  if w.id is null or w.status<>'issued'then raise exception 'Hanya surat terbit yang dapat dibatalkan';end if;
  if p_data->>'revision'is null or(p_data->>'revision')::integer<>w.revision then raise exception 'WARNING_STALE';end if;
  if p_data->>'points_version'is distinct from summary->>'version'then raise exception 'POINTS_STALE';end if;
  note:=trim(p_data->>'reason');if length(coalesce(note,''))not between 5 and 2000 then raise exception 'Isi alasan pembatalan surat minimal 5 karakter';end if;
  if exists(select 1 from staffing_warning_deliveries wd where wd.warning_id=w.id and wd.state in('sending','uncertain'))then raise exception 'Verifikasi status pengiriman surat sebelum pembatalan';end if;
  reversed:=least(w.issued_points,balance);
  if reversed>0 then insert into staffing_discipline(staff_id,points,reason,entry_kind,warning_id,actor,context)values(st.id,-reversed,note,'reversal',w.id,actor,jsonb_build_object('before',balance,'after',balance-reversed,'original_points',w.issued_points));end if;
  update staffing_warnings set status='revoked',revision=revision+1,revoked_at=now(),revocation_reason=note,updated_at=now()where id=w.id returning * into w;
  perform staffing_warning_log(w.id,st.id,actor,'revoked',jsonb_build_object('reason',note,'points_reversed',reversed,'before',balance,'after',balance-reversed));
 else
  perform staffing_warning_resolve_delivery(p_actor,p_bootstrap,w.id,p_data);
 end if;
 v_result:=jsonb_build_object('id',w.id,'points',staffing_points_summary(st.id));
 update staffing_operation_keys set result=v_result where key=key_id;
 return v_result;
end $$;

create function staffing_warning_download(p_actor uuid,p_bootstrap boolean,p_warning uuid,p_version text)returns void language plpgsql set search_path=public as $$
declare doc jsonb;begin
 doc:=staffing_warning_document(p_actor,p_bootstrap,p_warning);
 if doc->>'document_version'is distinct from p_version then raise exception 'WARNING_STALE';end if;
 perform staffing_warning_log(p_warning,(doc->>'staff_id')::uuid,coalesce(p_actor::text,'bootstrap-super-admin'),'download_requested',jsonb_build_object('status',doc->>'status','document_version',p_version));
end $$;

create function staffing_warning_reserve_delivery(p_actor uuid,p_bootstrap boolean,p_warning uuid,p_recipient_version text,p_document_version text)returns jsonb language plpgsql set search_path=public as $$
declare w staffing_warnings;st staffing_staff;doc jsonb;delivery staffing_warning_deliveries;begin
 select * into w from staffing_warnings where id=p_warning;
 st:=staffing_require_staff(p_actor,p_bootstrap,w.staff_id);select * into st from staffing_staff where id=st.id for update;
 perform staffing_require_staff(p_actor,p_bootstrap,st.id);
 select * into w from staffing_warnings where id=w.id for update;
 if w.status not in('issued','revoked')then raise exception 'Terbitkan surat sebelum mengirim PDF';end if;
 if not st.active or st.telegram_user_id is null then raise exception 'Staf tidak aktif atau akun Telegram belum tertaut';end if;
 doc:=staffing_warning_document(p_actor,p_bootstrap,w.id);
 if doc->>'recipient_version'is distinct from p_recipient_version then raise exception 'WARNING_RECIPIENT_CHANGED';end if;
 if doc->>'document_version'is distinct from p_document_version then raise exception 'WARNING_STALE';end if;
 select * into delivery from staffing_warning_deliveries where warning_id=w.id and document_version=p_document_version for update;
 if delivery.state='sent'then return jsonb_build_object('already_sent',true);end if;
 if delivery.state in('sending','uncertain')then raise exception 'Verifikasi status kirim sebelum mencoba kembali';end if;
 if exists(select 1 from staffing_warning_deliveries wd where wd.warning_id=w.id and wd.state in('sending','uncertain'))then raise exception 'Verifikasi pengiriman versi surat sebelumnya terlebih dahulu';end if;
 insert into staffing_warning_deliveries(warning_id,document_version,staff_id,telegram_user_id,recipient_version,state,actor)
 values(w.id,p_document_version,st.id,st.telegram_user_id,p_recipient_version,'sending',coalesce(p_actor::text,'bootstrap-super-admin'))
 on conflict(warning_id,document_version)do update set state='sending',telegram_user_id=excluded.telegram_user_id,recipient_version=excluded.recipient_version,token=gen_random_uuid(),actor=excluded.actor,updated_at=now(),message_id=null returning * into delivery;
 perform staffing_warning_log(w.id,st.id,delivery.actor,'send_started',jsonb_build_object('document_version',p_document_version,'recipient_name',st.full_name,'recipient_code',st.code));
 return jsonb_build_object('already_sent',false,'token',delivery.token,'telegram_user_id',st.telegram_user_id,'document',doc);
end $$;
create function staffing_warning_finish_delivery(p_warning uuid,p_token uuid,p_state text,p_message bigint default null)returns void language plpgsql set search_path=public as $$
declare d staffing_warning_deliveries;begin
 if p_state not in('sent','failed','uncertain')or(p_state='sent'and(p_message is null or p_message<=0))then raise exception 'Status pengiriman tidak valid';end if;
 update staffing_warning_deliveries set state=p_state,message_id=p_message,updated_at=now()where warning_id=p_warning and token=p_token and state='sending'returning * into d;
 if d.warning_id is not null then perform staffing_warning_log(d.warning_id,d.staff_id,d.actor,'send_'||p_state,jsonb_build_object('document_version',d.document_version,'message_id',p_message));end if;
end $$;
create function staffing_warning_recipient_guard()returns trigger language plpgsql set search_path=public as $$begin
 if(new.telegram_user_id is distinct from old.telegram_user_id or new.active is distinct from old.active or new.home_store_id is distinct from old.home_store_id)
 and exists(select 1 from staffing_warning_deliveries where staff_id=old.id and state in('sending','uncertain'))then raise exception 'Verifikasi pengiriman SP sebelum mengubah akun / status staf';end if;
 return new;
end $$;
create trigger staffing_warning_recipient_pin before update of telegram_user_id,active,home_store_id on staffing_staff for each row execute function staffing_warning_recipient_guard();

create function staffing_warning_resolve_delivery(p_actor uuid,p_bootstrap boolean,p_warning uuid,p_data jsonb)returns void language plpgsql set search_path=public as $$
declare w staffing_warnings;st staffing_staff;d staffing_warning_deliveries;note text:=trim(p_data->>'reason');resolution text:=p_data->>'resolution';actor text:=coalesce(p_actor::text,'bootstrap-super-admin');begin
 select * into w from staffing_warnings where id=p_warning;st:=staffing_require_staff(p_actor,p_bootstrap,w.staff_id);
 perform id from staffing_staff where id=st.id for update;
 select * into d from staffing_warning_deliveries where warning_id=w.id and document_version=p_data->>'document_version'for update;
 if d.warning_id is null or d.state not in('sending','uncertain')then raise exception 'Tidak ada pengiriman yang perlu diverifikasi';end if;
 if d.state='sending'and d.updated_at>now()-interval '2 minutes'then raise exception 'Pengiriman masih berjalan. Tunggu dua menit sebelum verifikasi manual';end if;
 if resolution is null or resolution not in('received','not_received')or length(coalesce(note,''))not between 5 and 2000 or coalesce((p_data->>'acknowledged')::boolean,false)is not true then raise exception 'Periksa chat penerima, pilih hasil verifikasi, dan isi catatan';end if;
 update staffing_warning_deliveries set state=case resolution when 'received'then 'sent'else 'failed'end,updated_at=now()where warning_id=d.warning_id and document_version=d.document_version;
 perform staffing_warning_log(w.id,st.id,actor,'delivery_verified',jsonb_build_object('resolution',resolution,'reason',note,'document_version',d.document_version));
end $$;

-- Add the complete cumulative balance without relying on the 100-row legacy view.
alter function staffing_staff_detail(uuid,boolean,uuid)rename to staffing_staff_detail_v9;
create function staffing_staff_detail(p_actor uuid,p_bootstrap boolean,p_staff uuid)returns jsonb language sql stable set search_path=public as $$
 select staffing_staff_detail_v9(p_actor,p_bootstrap,p_staff)||jsonb_build_object('warning_points',staffing_points_summary(p_staff));
$$;
revoke all on function staffing_staff_detail_v9(uuid,boolean,uuid),staffing_staff_detail(uuid,boolean,uuid)from public,anon,authenticated;
grant execute on function staffing_staff_detail_v9(uuid,boolean,uuid),staffing_staff_detail(uuid,boolean,uuid)to service_role;

revoke all on function staffing_points_summary(uuid),staffing_guard_points(),staffing_warning_log(uuid,uuid,text,text,jsonb),staffing_warning_validate(jsonb,boolean),staffing_warning_list(uuid,boolean,uuid),staffing_warning_document(uuid,boolean,uuid),staffing_warning_detail(uuid,boolean,uuid),staffing_warning_manage(uuid,boolean,text,jsonb),staffing_warning_download(uuid,boolean,uuid,text),staffing_warning_reserve_delivery(uuid,boolean,uuid,text,text),staffing_warning_finish_delivery(uuid,uuid,text,bigint),staffing_warning_recipient_guard(),staffing_warning_resolve_delivery(uuid,boolean,uuid,jsonb)from public,anon,authenticated;
grant execute on function staffing_points_summary(uuid),staffing_guard_points(),staffing_warning_log(uuid,uuid,text,text,jsonb),staffing_warning_validate(jsonb,boolean),staffing_warning_list(uuid,boolean,uuid),staffing_warning_document(uuid,boolean,uuid),staffing_warning_detail(uuid,boolean,uuid),staffing_warning_manage(uuid,boolean,text,jsonb),staffing_warning_download(uuid,boolean,uuid,text),staffing_warning_reserve_delivery(uuid,boolean,uuid,text,text),staffing_warning_finish_delivery(uuid,uuid,text,bigint),staffing_warning_recipient_guard(),staffing_warning_resolve_delivery(uuid,boolean,uuid,jsonb)to service_role;
commit;
