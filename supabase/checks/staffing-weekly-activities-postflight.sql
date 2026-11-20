-- READ ONLY. Run after 20261120180000_staffing_weekly_activities.sql.
-- All columns must be true. Does not update records or send notifications.
begin transaction read only;
select
 current_setting('transaction_read_only')='on' as read_only,
 to_regprocedure('public.staffing_activity_week(uuid,boolean,uuid,date)')is not null as weekly_activity_present,
 position('pending_attendance' in pg_get_functiondef('public.staffing_activity_week(uuid,boolean,uuid,date)'::regprocedure))>0 as unresolved_attendance_included,
 position('w.week_start+7' in pg_get_functiondef('public.staffing_activity_week(uuid,boolean,uuid,date)'::regprocedure))>0
 and position('at time zone s.time_zone' in pg_get_functiondef('public.staffing_activity_week(uuid,boolean,uuid,date)'::regprocedure))>0 as weekly_store_timezone_boundaries,
 not has_function_privilege('anon','public.staffing_activity_week(uuid,boolean,uuid,date)','execute')
 and not has_function_privilege('authenticated','public.staffing_activity_week(uuid,boolean,uuid,date)','execute')
 and has_function_privilege('service_role','public.staffing_activity_week(uuid,boolean,uuid,date)','execute') as server_only_access;
commit;
