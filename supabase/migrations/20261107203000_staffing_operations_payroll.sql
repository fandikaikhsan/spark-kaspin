begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local search_path = public;
alter table staffing_staff add column cash_advance_ceiling bigint check(cash_advance_ceiling between 0 and 1000000000000);
alter table staffing_sessions add column verification_state text not null default 'pending' check(verification_state in ('pending','confirmed','rejected'));
alter table staffing_sessions add column review_note text;
alter table staffing_sessions add column reviewed_at timestamptz;
alter table staffing_sessions add column reviewed_by text;
create table staffing_requests (
 id uuid primary key default gen_random_uuid(),staff_id uuid not null references staffing_staff(id),
 kind text not null check(kind in ('paid_leave','unpaid_leave','sick','emergency','cash_advance')),
 payment_mode text not null default 'none' check(payment_mode in ('none','leave','sick')),
 status text not null default 'pending' check(status in ('pending','approved','rejected','cancelled','disbursed')),
 start_date date,end_date date,leave_dates jsonb not null default '[]',days numeric(8,2),amount bigint,
 reason text not null check(length(trim(reason)) between 5 and 2000),document_note text,
 created_by text not null,created_at timestamptz not null default now(),decided_at timestamptz,decided_by text,decision_note text,
 check((kind='cash_advance' and amount is not null and amount>0 and start_date is null and days is null) or (kind<>'cash_advance' and amount is null and start_date is not null and end_date is not null and end_date>=start_date and days>0 and jsonb_array_length(leave_dates)>0))
);
create index on staffing_requests(staff_id,created_at desc);
create table staffing_leave_entries(id uuid primary key default gen_random_uuid(),staff_id uuid not null references staffing_staff(id),days numeric(8,2) not null check(days<>0),reason text not null,request_id uuid references staffing_requests(id),entry_kind text not null check(entry_kind in ('adjustment','use','reversal')),created_at timestamptz not null default now(),unique(request_id,entry_kind));
create table staffing_payroll_rules(
 id uuid primary key default gen_random_uuid(),staff_id uuid not null references staffing_staff(id),effective_from date not null,
 normal_rate bigint not null check(normal_rate between 1 and 10000000),day_hours numeric(4,1)not null check(day_hours between 0.5 and 24),night_enabled boolean not null,night_rate bigint check(night_rate between 1 and 10000000),night_start time not null,night_end time not null,
 overtime_percent integer not null check(overtime_percent between 100 and 500),leave_day_rate bigint check(leave_day_rate between 0 and 1000000000),sick_day_rate bigint check(sick_day_rate between 0 and 1000000000),
 late_enabled boolean not null default false,frequency_enabled boolean not null default false,late_tiers jsonb not null default '[]',frequency_tiers jsonb not null default '[]',
 loan_repayment_cap bigint check(loan_repayment_cap between 0 and 1000000000000),created_at timestamptz not null default now(),created_by text not null,
 check(not night_enabled or(night_rate is not null and night_start<>night_end))
);
create index on staffing_payroll_rules(staff_id,effective_from desc,created_at desc);
create table staffing_payrolls(id uuid primary key default gen_random_uuid(),staff_id uuid not null references staffing_staff(id),period_start date not null,period_end date not null,source_version text not null,result jsonb not null,created_by text not null,created_at timestamptz not null default now(),check(period_end>=period_start),unique(staff_id,period_start,period_end));
create table staffing_cash_ledger(id uuid primary key default gen_random_uuid(),staff_id uuid not null references staffing_staff(id),kind text not null check(kind in ('disbursement','repayment')),amount bigint not null,request_id uuid references staffing_requests(id),payroll_id uuid unique references staffing_payrolls(id),reason text not null,created_at timestamptz not null default now(),check((kind='disbursement' and amount>0 and request_id is not null) or(kind='repayment' and amount<0)));
create unique index on staffing_cash_ledger(request_id) where kind='disbursement';
create table staffing_bonuses(id uuid primary key default gen_random_uuid(),staff_id uuid not null references staffing_staff(id),bonus_date date not null,amount bigint not null check(amount between 1 and 1000000000),reason text not null,payroll_id uuid references staffing_payrolls(id),created_at timestamptz not null default now());
create table staffing_time_approvals(id uuid primary key default gen_random_uuid(),session_id uuid not null references staffing_sessions(id),kind text not null check(kind in ('overtime','unpaid_break')),starts_at timestamptz not null,ends_at timestamptz not null,reason text not null,created_by text not null,created_at timestamptz not null default now(),check(ends_at>starts_at and ends_at<=starts_at+interval '24 hours'));
create table staffing_operation_keys(key uuid primary key,actor text not null,action text not null,data_hash text not null,result jsonb);
create table staffing_discipline(id uuid primary key default gen_random_uuid(),staff_id uuid not null references staffing_staff(id),points integer not null check(points between 1 and 4),reason text not null,created_at timestamptz not null default now());
do $$declare t text;begin foreach t in array array['requests','leave_entries','payroll_rules','payrolls','cash_ledger','bonuses','time_approvals','discipline','operation_keys']loop
 execute format('alter table staffing_%I enable row level security',t);execute format('revoke all on staffing_%I from public,anon,authenticated',t);execute format('grant all on staffing_%I to service_role',t);
 end loop;end$$;

create function staffing_staff_money(p_staff uuid) returns jsonb language sql stable set search_path=public as $$
 select jsonb_build_object('ceiling',st.cash_advance_ceiling,'outstanding',greatest(coalesce((select sum(amount) from staffing_cash_ledger where staff_id=st.id),0),0),'reserved',coalesce((select sum(amount) from staffing_requests where staff_id=st.id and kind='cash_advance' and status='approved'),0),'available',case when st.cash_advance_ceiling is null then null else greatest(st.cash_advance_ceiling-coalesce((select sum(amount) from staffing_cash_ledger where staff_id=st.id),0)-coalesce((select sum(amount) from staffing_requests where staff_id=st.id and kind='cash_advance' and status='approved'),0),0) end,'leave_balance',case when exists(select 1 from staffing_leave_entries where staff_id=st.id) then coalesce((select sum(days) from staffing_leave_entries where staff_id=st.id),0) else null end) from staffing_staff st where st.id=p_staff;
$$;
create function staffing_require_staff(p_actor uuid,p_bootstrap boolean,p_staff uuid) returns staffing_staff language plpgsql stable set search_path=public as $$declare st staffing_staff;v_stores uuid[];begin
 v_stores:=staffing_actor_stores(p_actor,p_bootstrap);select * into st from staffing_staff where id=p_staff and home_store_id=any(v_stores);if st.id is null then raise exception 'FORBIDDEN';end if;return st;end$$;
create function staffing_roster(p_actor uuid,p_bootstrap boolean)returns jsonb language plpgsql stable set search_path=public as $$declare v_stores uuid[];begin
 v_stores:=staffing_actor_stores(p_actor,p_bootstrap);
 return coalesce((select jsonb_agg(to_jsonb(st)-'telegram_user_id'||jsonb_build_object('telegram_linked',st.telegram_user_id is not null,'store_name',s.name,'time_zone',s.time_zone,'region_id',sr.region_id,'money',staffing_staff_money(st.id),'pending_requests',(select count(*) from staffing_requests where staff_id=st.id and status='pending'),'last_payroll',(select result->'net_pay' from staffing_payrolls where staff_id=st.id order by period_end desc limit 1)) order by st.full_name) from staffing_staff st join stores s on s.id=st.home_store_id left join staffing_store_regions sr on sr.store_id=s.id where st.home_store_id=any(v_stores)),'[]'::jsonb);
end$$;
create function staffing_staff_detail(p_actor uuid,p_bootstrap boolean,p_staff uuid) returns jsonb language plpgsql stable set search_path=public as $$declare st staffing_staff;begin
 st:=staffing_require_staff(p_actor,p_bootstrap,p_staff);
 return jsonb_build_object('profile',to_jsonb(st)-'telegram_user_id'||jsonb_build_object('telegram_linked',st.telegram_user_id is not null),'store',(select jsonb_build_object('id',id,'name',name,'time_zone',time_zone) from stores where id=st.home_store_id),'money',staffing_staff_money(st.id),
 'rules',coalesce((select jsonb_agg(to_jsonb(q) order by q.effective_from desc,q.created_at desc) from(select * from staffing_payroll_rules where staff_id=st.id order by effective_from desc,created_at desc limit 50)q),'[]'::jsonb),
 'requests',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc) from(select * from staffing_requests where staff_id=st.id order by created_at desc limit 200)q),'[]'::jsonb),
 'leave_entries',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc) from(select * from staffing_leave_entries where staff_id=st.id order by created_at desc limit 200)q),'[]'::jsonb),
 'bonuses',coalesce((select jsonb_agg(to_jsonb(q) order by q.bonus_date desc) from(select * from staffing_bonuses where staff_id=st.id order by bonus_date desc limit 200)q),'[]'::jsonb),
 'cash_ledger',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc) from(select * from staffing_cash_ledger where staff_id=st.id order by created_at desc limit 200)q),'[]'::jsonb),
 'payrolls',coalesce((select jsonb_agg(to_jsonb(q) order by q.period_end desc) from(select * from staffing_payrolls where staff_id=st.id order by period_end desc limit 100)q),'[]'::jsonb),
 'discipline',coalesce((select jsonb_agg(to_jsonb(q) order by q.created_at desc) from(select * from staffing_discipline where staff_id=st.id order by created_at desc limit 100)q),'[]'::jsonb),
 'shifts',coalesce((select jsonb_agg(to_jsonb(q) order by q.starts_at desc) from(select sh.*,case when sh.store_id=any(staffing_actor_stores(p_actor,p_bootstrap))then s.name else 'Penugasan store lain' end as store_name,s.time_zone from staffing_shifts sh join stores s on s.id=sh.store_id where sh.staff_id=st.id order by sh.starts_at desc limit 300)q),'[]'::jsonb),
 'sessions',coalesce((select jsonb_agg(to_jsonb(q) order by q.check_in_at desc) from(select se.*,sh.starts_at,sh.ends_at,sh.label,sh.store_id,s.name as store_name,s.time_zone from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id join stores s on s.id=sh.store_id where se.staff_id=st.id order by se.check_in_at desc limit 200)q),'[]'::jsonb));
end$$;

create function staffing_operations(p_actor uuid,p_bootstrap boolean,p_action text,p_data jsonb)returns jsonb language plpgsql set search_path=public as $$declare
 v_stores uuid[];st staffing_staff;se staffing_sessions;sh staffing_shifts;r staffing_requests;v_id uuid;v_actor text;v_money jsonb;v_sum numeric;v_date jsonb;v_last numeric;v_rule staffing_payroll_rules;v_before jsonb;v_mode text;v_key uuid;v_cached staffing_operation_keys;
begin
 v_stores:=staffing_actor_stores(p_actor,p_bootstrap);v_actor:=coalesce(p_actor::text,'bootstrap-super-admin');
 if p_action in('attendance_review','overtime','unpaid_break')then
  select * into se from staffing_sessions where id=(p_data->>'session_id')::uuid;select * into sh from staffing_shifts where id=se.shift_id;
  if se.id is null or not sh.store_id=any(v_stores)then raise exception 'FORBIDDEN';end if;
  select * into st from staffing_staff where id=se.staff_id for update;
 elsif p_action in('approve_request','reject_request','cancel_request','disburse')then
  select * into r from staffing_requests where id=(p_data->>'request_id')::uuid;
  st:=staffing_require_staff(p_actor,p_bootstrap,r.staff_id);perform id from staffing_staff where id=st.id for update;
  select * into r from staffing_requests where id=r.id for update;
 else st:=staffing_require_staff(p_actor,p_bootstrap,(p_data->>'staff_id')::uuid);perform id from staffing_staff where id=st.id for update;end if;

 if p_data->>'client_id' is not null and p_action not in('approve_request','reject_request','cancel_request','disburse')then
  v_key:=(p_data->>'client_id')::uuid;
  insert into staffing_operation_keys(key,actor,action,data_hash)values(v_key,v_actor,p_action,md5((p_data-'client_id')::text))on conflict do nothing;
  if not found then
   select * into v_cached from staffing_operation_keys where key=v_key;
   if v_cached.actor<>v_actor or v_cached.action<>p_action or v_cached.data_hash<>md5((p_data-'client_id')::text)then raise exception 'Pengajuan sudah tercatat dengan data lain; muat ulang';end if;
   return v_cached.result;
  end if;
 end if;
 v_money:=staffing_staff_money(st.id);
 case p_action
 when 'profile' then
  update staffing_staff set full_name=trim(p_data->>'full_name'),active=(p_data->>'active')::boolean,cash_advance_ceiling=nullif(p_data->>'ceiling','')::bigint where id=st.id;v_id:=st.id;
 when 'leave_adjustment' then
  if length(trim(coalesce(p_data->>'reason','')))<5 or coalesce((p_data->>'days')::numeric,0)=0 or abs((p_data->>'days')::numeric)>1000 or (p_data->>'days')::numeric*2<>trunc((p_data->>'days')::numeric*2)then raise exception 'Periksa jumlah hari dan alasan';end if;
  if coalesce((v_money->>'leave_balance')::numeric,0)+(p_data->>'days')::numeric<0 then raise exception 'Saldo izin tidak boleh negatif';end if;
  insert into staffing_leave_entries(staff_id,days,reason,entry_kind)values(st.id,(p_data->>'days')::numeric,trim(p_data->>'reason'),'adjustment')returning id into v_id;
 when 'request' then
  if not st.active then raise exception 'Staff tidak aktif';end if;
  if p_data->>'kind'='cash_advance'then
   if v_money->>'available' is null or (p_data->>'amount')::bigint<=0 or (p_data->>'amount')::bigint>(v_money->>'available')::bigint then raise exception 'Nominal melebihi jatah kasbon tersedia; periksa plafon';end if;
   insert into staffing_requests(staff_id,kind,amount,reason,created_by)values(st.id,'cash_advance',(p_data->>'amount')::bigint,trim(p_data->>'reason'),v_actor)returning id into v_id;
  else
   if p_data->>'kind' not in('paid_leave','unpaid_leave','sick','emergency')or jsonb_typeof(p_data->'leave_dates')<>'array' or jsonb_array_length(p_data->'leave_dates')not between 1 and 62 then raise exception 'Pilih jenis dan tanggal izin';end if;
   if p_data->>'start_date' is null or p_data->>'end_date' is null or (p_data->>'end_date')::date<(p_data->>'start_date')::date or (p_data->>'end_date')::date-(p_data->>'start_date')::date>61 then raise exception 'Rentang izin tidak valid';end if;
   v_sum:=0;
   for v_date in select * from jsonb_array_elements(p_data->'leave_dates')loop
    if v_date->>'date' is null or (v_date->>'date')::date not between(p_data->>'start_date')::date and(p_data->>'end_date')::date or coalesce((v_date->>'units')::numeric,0)not in(0.5,1)then raise exception 'Tanggal atau unit izin tidak valid';end if;v_sum:=v_sum+(v_date->>'units')::numeric;
   end loop;
   if(select count(distinct d->>'date') from jsonb_array_elements(p_data->'leave_dates')d)<>jsonb_array_length(p_data->'leave_dates')then raise exception 'Tanggal izin duplikat';end if;
   v_mode:=case p_data->>'kind' when 'paid_leave'then 'leave' when 'sick'then 'sick' when 'unpaid_leave'then 'none' else p_data->>'payment_mode' end;
   if v_mode is null or v_mode not in('none','leave','sick')then raise exception 'Tentukan perlakuan upah izin darurat';end if;
   insert into staffing_requests(staff_id,kind,payment_mode,start_date,end_date,leave_dates,days,reason,document_note,created_by)values(st.id,p_data->>'kind',v_mode,(p_data->>'start_date')::date,(p_data->>'end_date')::date,p_data->'leave_dates',v_sum,trim(p_data->>'reason'),nullif(trim(p_data->>'document_note'),''),v_actor)returning id into v_id;
  end if;
 when 'approve_request' then
  if r.status='approved'then return jsonb_build_object('id',r.id);end if;if r.status<>'pending'then raise exception 'Pengajuan sudah diproses';end if;
  if r.kind='cash_advance'then
   if v_money->>'available' is null or r.amount>(v_money->>'available')::bigint then raise exception 'Jatah kasbon tidak mencukupi';end if;
  else
   if exists(select 1 from staffing_payrolls p,jsonb_array_elements(r.leave_dates)d where p.staff_id=st.id and(d->>'date')::date between p.period_start and p.period_end)then raise exception 'Periode payroll sudah final; catat penyesuaian pada periode terbuka';end if;
   if exists(select 1 from staffing_shifts s join stores so on so.id=s.store_id where s.staff_id=st.id and not s.store_id=any(v_stores) and exists(select 1 from jsonb_array_elements(r.leave_dates)d where(s.starts_at at time zone so.time_zone)::date=(d->>'date')::date))then raise exception 'FORBIDDEN';end if;
   if exists(select 1 from staffing_requests old,jsonb_array_elements(old.leave_dates)a,jsonb_array_elements(r.leave_dates)b where old.staff_id=st.id and old.status='approved'and old.kind<>'cash_advance'and a->>'date'=b->>'date')then raise exception 'Tanggal izin bertabrakan dengan izin disetujui';end if;
   if r.payment_mode='leave'then
    if coalesce((v_money->>'leave_balance')::numeric,0)<r.days then raise exception 'Saldo izin berbayar tidak mencukupi';end if;
    insert into staffing_leave_entries(staff_id,days,reason,request_id,entry_kind)values(st.id,-r.days,'Izin berbayar disetujui',r.id,'use');
   end if;
  end if;
  update staffing_requests set status='approved',decided_at=now(),decided_by=v_actor,decision_note=nullif(trim(p_data->>'note'),'')where id=r.id;v_id:=r.id;
 when 'reject_request' then
  if r.status='rejected'then return jsonb_build_object('id',r.id);end if;if r.status<>'pending'then raise exception 'Pengajuan sudah diproses';end if;
  if length(trim(coalesce(p_data->>'note','')))<5 then raise exception 'Alasan penolakan wajib diisi';end if;
  update staffing_requests set status='rejected',decided_at=now(),decided_by=v_actor,decision_note=trim(p_data->>'note')where id=r.id;v_id:=r.id;
 when 'cancel_request' then
  if r.status='cancelled'then return jsonb_build_object('id',r.id);end if;
  if r.status not in('pending','approved')then raise exception 'Pengajuan tidak dapat dibatalkan';end if;
  if length(trim(coalesce(p_data->>'note','')))<5 then raise exception 'Alasan pembatalan wajib diisi';end if;
  if r.kind<>'cash_advance'and exists(select 1 from staffing_payrolls p,jsonb_array_elements(r.leave_dates)d where p.staff_id=st.id and(d->>'date')::date between p.period_start and p.period_end)then raise exception 'Izin sudah masuk payroll final; catat penyesuaian terpisah';end if;
  if r.payment_mode='leave'and r.status='approved'then insert into staffing_leave_entries(staff_id,days,reason,request_id,entry_kind)values(st.id,r.days,'Pembatalan izin',r.id,'reversal');end if;
  update staffing_requests set status='cancelled',decided_at=now(),decided_by=v_actor,decision_note=trim(p_data->>'note')where id=r.id;v_id:=r.id;
 when 'disburse' then
  if r.status='disbursed'then return jsonb_build_object('id',r.id);end if;
  if r.kind<>'cash_advance'or r.status<>'approved'then raise exception 'Kasbon harus disetujui sebelum dicairkan';end if;
  insert into staffing_cash_ledger(staff_id,kind,amount,request_id,reason)values(st.id,'disbursement',r.amount,r.id,'Pencairan kasbon');update staffing_requests set status='disbursed'where id=r.id;v_id:=r.id;
 when 'repayment' then
  if (p_data->>'amount')::bigint<=0 or(p_data->>'amount')::bigint>(v_money->>'outstanding')::bigint or length(trim(coalesce(p_data->>'reason','')))<5 then raise exception 'Periksa nominal pelunasan dan alasan';end if;
  insert into staffing_cash_ledger(staff_id,kind,amount,reason)values(st.id,'repayment',-(p_data->>'amount')::bigint,trim(p_data->>'reason'))returning id into v_id;
 when 'bonus' then
  if length(trim(coalesce(p_data->>'reason','')))<5 then raise exception 'Alasan bonus wajib diisi';end if;
  if exists(select 1 from staffing_payrolls where staff_id=st.id and(p_data->>'bonus_date')::date between period_start and period_end)then raise exception 'Periode sudah final; gunakan tanggal penyesuaian pada periode terbuka';end if;
  insert into staffing_bonuses(staff_id,bonus_date,amount,reason)values(st.id,(p_data->>'bonus_date')::date,(p_data->>'amount')::bigint,trim(p_data->>'reason'))returning id into v_id;
 when 'discipline' then
  if length(trim(coalesce(p_data->>'reason','')))<5 then raise exception 'Catatan SP wajib diisi';end if;
  insert into staffing_discipline(staff_id,points,reason)values(st.id,(p_data->>'points')::integer,trim(p_data->>'reason'))returning id into v_id;
 when 'attendance_review' then
  if p_data->>'state' not in('confirmed','rejected')or length(trim(coalesce(p_data->>'note','')))<5 then raise exception 'Keputusan dan alasan review wajib diisi';end if;
  select to_jsonb(s)into v_before from staffing_sessions s where id=se.id;
  update staffing_sessions set verification_state=p_data->>'state',review_note=trim(p_data->>'note'),reviewed_at=now(),reviewed_by=v_actor where id=se.id;v_id:=se.id;p_data:=p_data||jsonb_build_object('before',v_before);
 when 'overtime','unpaid_break' then
  if length(trim(coalesce(p_data->>'reason','')))<5 then raise exception 'Alasan persetujuan waktu wajib diisi';end if;
  if exists(select 1 from staffing_payrolls p where p.staff_id=st.id and daterange(p.period_start,p.period_end,'[]')&&daterange(((p_data->>'starts_at')::timestamptz at time zone(select time_zone from stores where id=st.home_store_id))::date,((p_data->>'ends_at')::timestamptz at time zone(select time_zone from stores where id=st.home_store_id))::date,'[]'))then raise exception 'Periode payroll sudah final';end if;
  if p_action='unpaid_break'and(coalesce(se.corrected_out_at,se.check_out_at)is null or(p_data->>'starts_at')::timestamptz<coalesce(se.corrected_in_at,se.check_in_at)or(p_data->>'ends_at')::timestamptz>coalesce(se.corrected_out_at,se.check_out_at))then raise exception 'Istirahat harus berada di dalam sesi selesai';end if;
  if exists(select 1 from staffing_time_approvals where session_id=se.id and kind=p_action and starts_at<(p_data->>'ends_at')::timestamptz and ends_at>(p_data->>'starts_at')::timestamptz)then raise exception 'Interval persetujuan bertabrakan';end if;
  insert into staffing_time_approvals(session_id,kind,starts_at,ends_at,reason,created_by)values(se.id,p_action,(p_data->>'starts_at')::timestamptz,(p_data->>'ends_at')::timestamptz,trim(p_data->>'reason'),v_actor)returning id into v_id;
 when 'payroll_rule' then
  if jsonb_typeof(coalesce(p_data->'late_tiers','[]'))<>'array' or jsonb_typeof(coalesce(p_data->'frequency_tiers','[]'))<>'array' or jsonb_array_length(coalesce(p_data->'late_tiers','[]'))>20 or jsonb_array_length(coalesce(p_data->'frequency_tiers','[]'))>20 then raise exception 'Tabel penalti maksimal 20 baris';end if;
  v_last:=0;for v_date in select * from jsonb_array_elements(coalesce(p_data->'late_tiers','[]'))loop
   if coalesce(v_date->>'minutes','')!~'^[0-9]+$' or coalesce(v_date->>'amount','')!~'^[0-9]+$' or(v_date->>'minutes')::numeric<=v_last or(v_date->>'minutes')::numeric>100000 or(v_date->>'amount')::numeric>1000000000 then raise exception 'Interval penalti tidak valid';end if;v_last:=(v_date->>'minutes')::numeric;
  end loop;
  v_last:=0;for v_date in select * from jsonb_array_elements(coalesce(p_data->'frequency_tiers','[]'))loop
   if coalesce(v_date->>'count','')!~'^[0-9]+$' or coalesce(v_date->>'amount','')!~'^[0-9]+$' or(v_date->>'count')::numeric<=v_last or(v_date->>'count')::numeric>100000 or(v_date->>'amount')::numeric>1000000000 then raise exception 'Frekuensi penalti tidak valid';end if;v_last:=(v_date->>'count')::numeric;
  end loop;
  if(coalesce((p_data->>'late_enabled')::boolean,false)and jsonb_array_length(p_data->'late_tiers')=0)or(coalesce((p_data->>'frequency_enabled')::boolean,false)and jsonb_array_length(p_data->'frequency_tiers')=0)then raise exception 'Isi tabel penalti sebelum mengaktifkan';end if;
  insert into staffing_payroll_rules(staff_id,effective_from,normal_rate,day_hours,night_enabled,night_rate,night_start,night_end,overtime_percent,leave_day_rate,sick_day_rate,late_enabled,frequency_enabled,late_tiers,frequency_tiers,loan_repayment_cap,created_by)values(st.id,(p_data->>'effective_from')::date,(p_data->>'normal_rate')::bigint,(p_data->>'day_hours')::numeric,(p_data->>'night_enabled')::boolean,nullif(p_data->>'night_rate','')::bigint,(p_data->>'night_start')::time,(p_data->>'night_end')::time,(p_data->>'overtime_percent')::integer,nullif(p_data->>'leave_day_rate','')::bigint,nullif(p_data->>'sick_day_rate','')::bigint,coalesce((p_data->>'late_enabled')::boolean,false),coalesce((p_data->>'frequency_enabled')::boolean,false),coalesce(p_data->'late_tiers','[]'),coalesce(p_data->'frequency_tiers','[]'),nullif(p_data->>'loan_repayment_cap','')::bigint,v_actor)returning id into v_id;
 else raise exception 'Unknown operations action';end case;
 insert into staffing_audit(actor,action,entity_id,details)values(v_actor,p_action,v_id::text,p_data);
 if v_key is not null then update staffing_operation_keys set result=jsonb_build_object('id',v_id)where key=v_key;end if;
 return jsonb_build_object('id',v_id);
end$$;

create function staffing_payroll_source(p_actor uuid,p_bootstrap boolean,p_staff uuid,p_from date,p_to date)returns jsonb language plpgsql stable set search_path=public as $$declare st staffing_staff;v_zone text;v_start timestamptz;v_end timestamptz;v_input jsonb;begin
 st:=staffing_require_staff(p_actor,p_bootstrap,p_staff);
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>61 then raise exception 'Periode payroll maksimal 62 hari';end if;
 select time_zone into v_zone from stores where id=st.home_store_id;v_start:=p_from::timestamp at time zone v_zone;v_end:=(p_to+1)::timestamp at time zone v_zone;
 v_input:=jsonb_build_object('staff_id',st.id,'period_start',p_from,'period_end',p_to,'time_zone',v_zone,'range_start',v_start,'range_end',v_end,
 'rule',(select to_jsonb(r) from staffing_payroll_rules r where staff_id=st.id and effective_from<=p_from order by effective_from desc,created_at desc,id desc limit 1),
 'rule_changes',coalesce((select jsonb_agg(to_jsonb(r) order by effective_from,created_at,id) from staffing_payroll_rules r where staff_id=st.id and effective_from>p_from and effective_from<=p_to),'[]'::jsonb),
 'sessions',coalesce((select jsonb_agg(to_jsonb(q) order by q.id) from(select se.*,sh.starts_at,sh.ends_at,sh.label,s.time_zone from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id join stores s on s.id=sh.store_id where se.staff_id=st.id and coalesce(se.corrected_in_at,se.check_in_at)<v_end and coalesce(se.corrected_out_at,se.check_out_at,v_end)>v_start)q),'[]'::jsonb),
 'time_approvals',coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from staffing_time_approvals a join staffing_sessions se on se.id=a.session_id where se.staff_id=st.id and a.starts_at<v_end and a.ends_at>v_start),'[]'::jsonb),
 'leave',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from staffing_requests r where r.staff_id=st.id and r.kind<>'cash_advance'and r.status='approved'and r.start_date<=p_to and r.end_date>=p_from),'[]'::jsonb),
 'bonuses',coalesce((select jsonb_agg(to_jsonb(b) order by b.id) from staffing_bonuses b where staff_id=st.id and bonus_date between p_from and p_to and payroll_id is null),'[]'::jsonb),
 'outstanding',(staffing_staff_money(st.id)->'outstanding'),
 'posted',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'period_start',p.period_start,'period_end',p.period_end)order by p.id)from staffing_payrolls p where staff_id=st.id and daterange(period_start,period_end,'[]')&&daterange(p_from,p_to,'[]')),'[]'::jsonb));
 return jsonb_build_object('input',v_input,'version',md5(v_input::text));
end$$;
create function staffing_finalize_payroll(p_actor uuid,p_bootstrap boolean,p_staff uuid,p_from date,p_to date,p_version text,p_result jsonb)returns jsonb language plpgsql set search_path=public as $$declare st staffing_staff;v_source jsonb;v_old staffing_payrolls;v_id uuid;v_gross bigint;v_deduction bigint;v_repayment bigint;v_net bigint;v_actor text;begin
 st:=staffing_require_staff(p_actor,p_bootstrap,p_staff);perform id from staffing_staff where id=st.id for update;v_actor:=coalesce(p_actor::text,'bootstrap-super-admin');
 select * into v_old from staffing_payrolls where staff_id=st.id and period_start=p_from and period_end=p_to;if v_old.id is not null then return to_jsonb(v_old);end if;
 v_source:=staffing_payroll_source(p_actor,p_bootstrap,p_staff,p_from,p_to);
 if p_to>=(now()at time zone(v_source->'input'->>'time_zone'))::date then raise exception 'Periode belum berakhir';end if;
 if v_source->>'version'<>p_version then raise exception 'PAYROLL_STALE';end if;
 if jsonb_array_length(v_source->'input'->'posted')>0 then raise exception 'Periode bertabrakan dengan payroll final';end if;
 if p_result is null or jsonb_typeof(p_result->'blockers')<>'array' or jsonb_array_length(p_result->'blockers')<>0 then raise exception 'Selesaikan pemeriksaan payroll';end if;
 v_gross:=(p_result->>'gross_pay')::bigint;v_deduction:=(p_result->>'deductions')::bigint;v_repayment:=(p_result->>'loan_repayment')::bigint;v_net:=(p_result->>'net_pay')::bigint;
 if v_gross is null or v_deduction is null or v_repayment is null or v_net is null or least(v_gross,v_deduction,v_repayment,v_net)<0 or v_gross-v_deduction-v_repayment<>v_net or v_repayment>(v_source->'input'->>'outstanding')::bigint then raise exception 'Hasil payroll tidak valid';end if;
 insert into staffing_payrolls(staff_id,period_start,period_end,source_version,result,created_by)values(st.id,p_from,p_to,p_version,p_result||jsonb_build_object('source',v_source->'input'),v_actor)returning id into v_id;
 update staffing_bonuses set payroll_id=v_id where staff_id=st.id and bonus_date between p_from and p_to and payroll_id is null;
 if v_repayment>0 then insert into staffing_cash_ledger(staff_id,kind,amount,payroll_id,reason)values(st.id,'repayment',-v_repayment,v_id,'Potongan kasbon payroll');end if;
 insert into staffing_audit(actor,action,entity_id,details)values(v_actor,'finalize_payroll',v_id::text,jsonb_build_object('staff_id',st.id,'period_start',p_from,'period_end',p_to,'net_pay',v_net,'loan_repayment',v_repayment));
 return(select to_jsonb(p)from staffing_payrolls p where id=v_id);
end$$;

create function staffing_activity(p_actor uuid,p_bootstrap boolean,p_store uuid default null,p_day date default null)returns jsonb language plpgsql stable set search_path=public as $$declare v_stores uuid[];begin
 v_stores:=staffing_actor_stores(p_actor,p_bootstrap);if p_store is not null and not p_store=any(v_stores)then raise exception 'FORBIDDEN';end if;
 return jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(q)order by q.store_name,q.starts_at,q.full_name)from(
 select sh.*,st.full_name,(st.home_store_id=any(v_stores))as can_view_profile,s.name as store_name,s.time_zone,se.id as session_id,se.check_in_at,se.check_out_at,se.corrected_in_at,se.corrected_out_at,se.verification_state,se.review_note,se.reviewed_at,
 (select jsonb_build_object('latitude',a.latitude,'longitude',a.longitude,'sent_at',a.location_sent_at,'completed_at',a.completed_at)from staffing_events ev join staffing_attempts a on a.id=ev.attempt_id where ev.session_id=se.id order by ev.received_at desc limit 1)as last_location,
 exists(select 1 from staffing_requests r,jsonb_array_elements(r.leave_dates)d where r.staff_id=st.id and r.status='approved'and r.kind<>'cash_advance'and(d->>'date')::date=coalesce(p_day,(now()at time zone s.time_zone)::date))as approved_leave
 from staffing_shifts sh join staffing_staff st on st.id=sh.staff_id join stores s on s.id=sh.store_id left join staffing_sessions se on se.shift_id=sh.id where sh.store_id=any(v_stores)and(p_store is null or sh.store_id=p_store)and sh.starts_at<((coalesce(p_day,(now()at time zone s.time_zone)::date)+1)::timestamp at time zone s.time_zone)and sh.ends_at>(coalesce(p_day,(now()at time zone s.time_zone)::date)::timestamp at time zone s.time_zone)
 )q),'[]'::jsonb),
 'requests',coalesce((select jsonb_agg(to_jsonb(q)order by q.created_at)from(select r.*,st.full_name,s.name as store_name,(select count(*)from staffing_shifts sh join stores ss on ss.id=sh.store_id where sh.staff_id=st.id and exists(select 1 from jsonb_array_elements(r.leave_dates)d where(sh.starts_at at time zone ss.time_zone)::date=(d->>'date')::date))as affected_shifts from staffing_requests r join staffing_staff st on st.id=r.staff_id join stores s on s.id=st.home_store_id where st.home_store_id=any(v_stores)and(p_store is null or st.home_store_id=p_store)and(r.status='pending'or(r.kind='cash_advance'and r.status='approved')))q),'[]'::jsonb));
end$$;
create function staffing_home(p_actor uuid,p_bootstrap boolean)returns jsonb language plpgsql stable set search_path=public as $$declare v_stores uuid[];begin
 v_stores:=staffing_actor_stores(p_actor,p_bootstrap);
 return jsonb_build_object('staff_count',(select count(*)from staffing_staff where home_store_id=any(v_stores)),'active_staff',(select count(*)from staffing_staff where home_store_id=any(v_stores)and active),'pending_requests',(select count(*)from staffing_requests r join staffing_staff st on st.id=r.staff_id where st.home_store_id=any(v_stores)and r.status='pending'),'pending_attendance',(select count(*)from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id where sh.store_id=any(v_stores)and se.verification_state='pending'),'committed_shifts',(select count(*)from staffing_shifts where store_id=any(v_stores)and ends_at>=now()),'open_sessions',(select count(*)from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id where sh.store_id=any(v_stores)and coalesce(se.corrected_out_at,se.check_out_at)is null and se.verification_state<>'rejected'));
end$$;
revoke all on function staffing_staff_money(uuid),staffing_require_staff(uuid,boolean,uuid),staffing_roster(uuid,boolean),staffing_staff_detail(uuid,boolean,uuid),staffing_operations(uuid,boolean,text,jsonb),staffing_payroll_source(uuid,boolean,uuid,date,date),staffing_finalize_payroll(uuid,boolean,uuid,date,date,text,jsonb),staffing_activity(uuid,boolean,uuid,date),staffing_home(uuid,boolean)from public,anon,authenticated;
grant execute on function staffing_staff_money(uuid),staffing_require_staff(uuid,boolean,uuid),staffing_roster(uuid,boolean),staffing_staff_detail(uuid,boolean,uuid),staffing_operations(uuid,boolean,text,jsonb),staffing_payroll_source(uuid,boolean,uuid,date,date),staffing_finalize_payroll(uuid,boolean,uuid,date,date,text,jsonb),staffing_activity(uuid,boolean,uuid,date),staffing_home(uuid,boolean)to service_role;
create function staffing_session_context(p_actor uuid,p_bootstrap boolean,p_session uuid)returns jsonb language plpgsql stable set search_path=public as $$declare v jsonb;begin
 select jsonb_build_object('staff_id',se.staff_id,'store_id',sh.store_id,'time_zone',s.time_zone)into v from staffing_sessions se join staffing_shifts sh on sh.id=se.shift_id join stores s on s.id=sh.store_id where se.id=p_session and sh.store_id=any(staffing_actor_stores(p_actor,p_bootstrap));
 if v is null then raise exception 'FORBIDDEN';end if;return v;end$$;
alter function staffing_manage(uuid,boolean,text,jsonb)rename to staffing_manage_v1;
create function staffing_manage(p_actor uuid,p_bootstrap boolean,p_action text,p_data jsonb)returns jsonb language plpgsql set search_path=public as $$declare v_context jsonb;v_result jsonb;begin
 if p_action='correction'then
  v_context:=staffing_session_context(p_actor,p_bootstrap,(p_data->>'session_id')::uuid);
  perform id from staffing_staff where id=(v_context->>'staff_id')::uuid for update;
 end if;
 v_result:=staffing_manage_v1(p_actor,p_bootstrap,p_action,p_data);
 if p_action='correction'then
  update staffing_sessions set verification_state='pending',review_note='Waktu dikoreksi; perlu konfirmasi ulang',reviewed_at=null,reviewed_by=null where id=(p_data->>'session_id')::uuid;
 end if;return v_result;end$$;
revoke all on function staffing_manage(uuid,boolean,text,jsonb),staffing_session_context(uuid,boolean,uuid)from public,anon,authenticated;
grant execute on function staffing_manage(uuid,boolean,text,jsonb),staffing_session_context(uuid,boolean,uuid)to service_role;

commit;
