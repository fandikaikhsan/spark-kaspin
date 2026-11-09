begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local search_path = public;

-- Optimistic version includes all shifts intersecting the local calendar week.
-- It also protects the carried-in portion of an overnight shift from last week.
create function public.staffing_schedule_version(p_store uuid,p_start timestamptz,p_end timestamptz)
returns text language sql stable set search_path=public as $$
  select md5(coalesce(jsonb_agg(to_jsonb(sh) order by sh.id)::text,'[]'))
  from staffing_shifts sh where sh.store_id=p_store and sh.starts_at<p_end and sh.ends_at>p_start;
$$;

create function public.staffing_schedule_week(p_actor uuid,p_bootstrap boolean,p_store uuid,p_week date)
returns jsonb language plpgsql stable set search_path=public as $$
declare v_stores uuid[]; v_store stores; v_start timestamptz; v_end timestamptz;
begin
  v_stores:=staffing_actor_stores(p_actor,p_bootstrap);
  if not p_store=any(v_stores) then raise exception 'FORBIDDEN'; end if;
  select * into v_store from stores where id=p_store;
  if v_store.id is null then raise exception 'FORBIDDEN'; end if;
  if p_week is null or extract(isodow from p_week)<>1 then raise exception 'Week must start on Monday'; end if;
  v_start:=p_week::timestamp at time zone v_store.time_zone;
  v_end:=(p_week+7)::timestamp at time zone v_store.time_zone;
  return jsonb_build_object(
    'store',jsonb_build_object('id',v_store.id,'name',v_store.name,'time_zone',v_store.time_zone,'active',v_store.active,'region_id',(select region_id from staffing_store_regions where store_id=p_store)),
    'week_start',p_week,
    'version',staffing_schedule_version(p_store,v_start,v_end),
    'staff',coalesce((select jsonb_agg(to_jsonb(st)-'telegram_user_id'||jsonb_build_object('telegram_linked',st.telegram_user_id is not null) order by st.full_name) from staffing_staff st where st.home_store_id=any(v_stores) and st.active),'[]'::jsonb),
    'shifts',coalesce((select jsonb_agg(to_jsonb(q) order by q.starts_at) from (
      select sh.*,st.full_name,
        exists(select 1 from staffing_attempts a where a.shift_id=sh.id) or exists(select 1 from staffing_sessions se where se.shift_id=sh.id) as locked,
        sh.starts_at>=v_start and st.home_store_id=any(v_stores) and st.active as editable
      from staffing_shifts sh join staffing_staff st on st.id=sh.staff_id where sh.store_id=p_store and sh.starts_at<v_end and sh.ends_at>v_start
    ) q),'[]'::jsonb),
    -- Availability of the authorized roster outside this store/window, without
    -- revealing the other store's label/name or its employee roster.
    'busy',coalesce((select jsonb_agg(jsonb_build_object('id',sh.id,'staff_id',sh.staff_id,'starts_at',sh.starts_at,'ends_at',sh.ends_at)) from staffing_shifts sh join staffing_staff st on st.id=sh.staff_id where st.home_store_id=any(v_stores) and sh.starts_at<v_end+interval '1 day' and sh.ends_at>v_start and not(sh.store_id=p_store and sh.starts_at<v_end and sh.ends_at>v_start)),'[]'::jsonb)
  );
end $$;

create function public.staffing_commit_week(p_actor uuid,p_bootstrap boolean,p_store uuid,p_week date,p_version text,p_shifts jsonb)
returns jsonb language plpgsql set search_path=public as $$
declare
  v_stores uuid[]; v_store stores; v_start timestamptz; v_end timestamptz;
  v_before jsonb; v_ids uuid[]; v_keep uuid[]; v_row jsonb; v_old staffing_shifts;
  v_id uuid; v_staff uuid; v_from timestamptz; v_to timestamptz; v_label text;
begin
  v_stores:=staffing_actor_stores(p_actor,p_bootstrap);
  if not p_store=any(v_stores) then raise exception 'FORBIDDEN'; end if;
  select * into v_store from stores where id=p_store and active;
  if v_store.id is null then raise exception 'Choose an active store'; end if;
  if p_week is null or extract(isodow from p_week)<>1 then raise exception 'Week must start on Monday'; end if;
  if jsonb_typeof(p_shifts)<>'array' or p_shifts is null or jsonb_array_length(p_shifts)>1000 then raise exception 'Invalid weekly schedule'; end if;
  v_start:=p_week::timestamp at time zone v_store.time_zone;
  v_end:=(p_week+7)::timestamp at time zone v_store.time_zone;
  perform pg_advisory_xact_lock(hashtext('staffing-schedule'),hashtext(p_store::text||p_week::text));
  -- Serialize with other-store commits, individual shift publication, and bot
  -- attendance (all acquire the staff row before mutating a shift/attempt).
  perform st.id from staffing_staff st where st.id in (
    select (r->>'staff_id')::uuid from jsonb_array_elements(p_shifts) r
    union select staff_id from staffing_shifts where store_id=p_store and starts_at<v_end and ends_at>v_start
  ) order by st.id for update;
  if p_version is null or p_version<>staffing_schedule_version(p_store,v_start,v_end) then raise exception 'SCHEDULE_STALE'; end if;
  select coalesce(jsonb_agg(to_jsonb(sh) order by sh.id),'[]'::jsonb),coalesce(array_agg(sh.id),'{}'::uuid[]) into v_before,v_ids
    from staffing_shifts sh where sh.store_id=p_store and sh.starts_at>=v_start and sh.starts_at<v_end;
  select coalesce(array_agg((r->>'id')::uuid),'{}'::uuid[]) into v_keep from jsonb_array_elements(p_shifts) r where nullif(r->>'id','') is not null;
  if cardinality(v_keep)<>(select count(distinct x) from unnest(v_keep) x) then raise exception 'Duplicate shift ID'; end if;
  if exists(select 1 from unnest(v_keep) x where not x=any(v_ids)) then raise exception 'FORBIDDEN'; end if;
  for v_old in select * from staffing_shifts where id=any(v_ids) loop
    select r into v_row from jsonb_array_elements(p_shifts) r where r->>'id'=v_old.id::text;
    if v_row is null or (v_row->>'staff_id')::uuid<>v_old.staff_id or (v_row->>'starts_at')::timestamptz<>v_old.starts_at or (v_row->>'ends_at')::timestamptz<>v_old.ends_at or trim(v_row->>'label')<>v_old.label then
      if exists(select 1 from staffing_attempts where shift_id=v_old.id) or exists(select 1 from staffing_sessions where shift_id=v_old.id) then raise exception 'SCHEDULE_LOCKED'; end if;
      if not exists(select 1 from staffing_staff where id=v_old.staff_id and home_store_id=any(v_stores) and active) then raise exception 'FORBIDDEN'; end if;
    end if;
  end loop;
  -- Only remove IDs in the versioned snapshot. A concurrent legacy insertion for
  -- a different staff member must never be silently removed by replacement.
  delete from staffing_shifts where id=any(v_ids) and not id=any(v_keep);
  -- Existing rows are updated before conflict checks, allowing atomic swaps.
  for v_row in select * from jsonb_array_elements(p_shifts) loop
    v_id:=nullif(v_row->>'id','')::uuid;
    v_staff:=(v_row->>'staff_id')::uuid;
    v_from:=(v_row->>'starts_at')::timestamptz;
    v_to:=(v_row->>'ends_at')::timestamptz;
    v_label:=trim(v_row->>'label');
    if v_id is not null and exists(select 1 from staffing_shifts where id=v_id and staff_id=v_staff and starts_at=v_from and ends_at=v_to and label=v_label) then continue; end if;
    if v_staff is null or v_from is null or v_to is null or v_label is null or length(v_label) not between 1 and 80 or v_from<v_start or v_from>=v_end or v_to<v_from+interval '30 minutes' or v_to>v_from+interval '24 hours' then raise exception 'Invalid shift time or label'; end if;
    if not exists(select 1 from staffing_staff where id=v_staff and active and home_store_id=any(v_stores)) then raise exception 'FORBIDDEN'; end if;
    if v_id is null then
      insert into staffing_shifts(staff_id,store_id,label,starts_at,ends_at) values(v_staff,p_store,v_label,v_from,v_to);
    else
      update staffing_shifts set staff_id=v_staff,label=v_label,starts_at=v_from,ends_at=v_to where id=v_id;
    end if;
  end loop;
  if exists(
    select 1 from staffing_shifts a join staffing_shifts b on a.staff_id=b.staff_id and a.id<>b.id and a.starts_at<b.ends_at and a.ends_at>b.starts_at
    where a.store_id=p_store and a.starts_at>=v_start and a.starts_at<v_end
  ) then raise exception 'SCHEDULE_OVERLAP'; end if;
  insert into staffing_audit(actor,action,entity_id,details) values(coalesce(p_actor::text,'bootstrap-super-admin'),'commit_week',p_store::text,jsonb_build_object('week_start',p_week,'before',v_before,'after',(select coalesce(jsonb_agg(to_jsonb(sh) order by sh.id),'[]'::jsonb) from staffing_shifts sh where sh.store_id=p_store and sh.starts_at>=v_start and sh.starts_at<v_end)));
  return staffing_schedule_week(p_actor,p_bootstrap,p_store,p_week);
end $$;

revoke all on function public.staffing_schedule_version(uuid,timestamptz,timestamptz), public.staffing_schedule_week(uuid,boolean,uuid,date), public.staffing_commit_week(uuid,boolean,uuid,date,text,jsonb) from public,anon,authenticated;
grant execute on function public.staffing_schedule_version(uuid,timestamptz,timestamptz), public.staffing_schedule_week(uuid,boolean,uuid,date), public.staffing_commit_week(uuid,boolean,uuid,date,text,jsonb) to service_role;
commit;
