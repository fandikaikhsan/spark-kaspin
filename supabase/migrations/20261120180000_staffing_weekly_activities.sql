begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local search_path=public;

create function staffing_activity_week(p_actor uuid,p_bootstrap boolean,p_store uuid default null,p_week date default null)
returns jsonb language plpgsql stable set search_path=public as $$
declare scope uuid[];base jsonb;week_rows jsonb;pending_rows jsonb;begin
 scope:=staffing_actor_stores(p_actor,p_bootstrap);
 if p_store is not null and not p_store=any(scope)then raise exception 'FORBIDDEN';end if;
 if p_week is not null and extract(isodow from p_week)<>1 then raise exception 'Pilih tanggal Senin sebagai awal minggu';end if;
 -- Reuse the current request / shift / overtime queue authorization and keep
 -- their unresolved items visible independently of the selected calendar week.
 base:=staffing_activity(p_actor,p_bootstrap,p_store,p_week);
 with candidates as (
  select sh.*,st.full_name,(st.home_store_id=any(scope))as can_view_profile,
   s.name as store_name,s.time_zone,se.id as session_id,se.check_in_at,se.check_out_at,
   se.corrected_in_at,se.corrected_out_at,se.verification_state,se.review_note,se.reviewed_at,
   (sh.starts_at<((w.week_start+7)::timestamp at time zone s.time_zone)
    and sh.ends_at>(w.week_start::timestamp at time zone s.time_zone))as in_week,
   (select jsonb_build_object('latitude',a.latitude,'longitude',a.longitude,'sent_at',a.location_sent_at,'completed_at',a.completed_at)
    from staffing_events ev join staffing_attempts a on a.id=ev.attempt_id where ev.session_id=se.id order by ev.received_at desc limit 1)as last_location,
   exists(select 1 from staffing_requests req cross join lateral jsonb_array_elements(req.leave_dates)d
    where req.staff_id=st.id and req.status='approved'and req.kind<>'cash_advance'
    and sh.starts_at<(((d->>'date')::date+1)::timestamp at time zone s.time_zone)
    and sh.ends_at>((d->>'date')::date::timestamp at time zone s.time_zone))as approved_leave
  from staffing_shifts sh join staffing_staff st on st.id=sh.staff_id
   join stores s on s.id=sh.store_id left join staffing_sessions se on se.shift_id=sh.id
   cross join lateral(select coalesce(p_week,date_trunc('week',now()at time zone s.time_zone)::date)as week_start)w
  where sh.store_id=any(scope)and(p_store is null or sh.store_id=p_store)
   and ((sh.starts_at<((w.week_start+7)::timestamp at time zone s.time_zone)
         and sh.ends_at>(w.week_start::timestamp at time zone s.time_zone))
        or se.verification_state='pending')
 ), enriched as (
  select c.*,to_jsonb(c)-'in_week'||staffing_shift_metadata(c.id)||
   case when c.session_id is not null then staffing_attendance_metadata(c.session_id)else '{}'::jsonb end as value
  from candidates c
 )
 select coalesce(jsonb_agg(value order by store_name,starts_at,full_name)filter(where in_week),'[]'::jsonb),
        coalesce(jsonb_agg(value order by starts_at,store_name,full_name)filter(where session_id is not null and verification_state='pending'),'[]'::jsonb)
 into week_rows,pending_rows from enriched;
 return base||jsonb_build_object('rows',week_rows,'pending_attendance',pending_rows,'week_start',p_week,'week_end',p_week+6);
end $$;
revoke all on function staffing_activity_week(uuid,boolean,uuid,date)from public,anon,authenticated;
grant execute on function staffing_activity_week(uuid,boolean,uuid,date)to service_role;
commit;
