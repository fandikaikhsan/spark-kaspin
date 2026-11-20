-- READ ONLY. Run after 20261120160000_staffing_attendance_anomaly_review.sql.
-- All columns must be true. Does not change attendance or send messages.
begin transaction read only;
select
 current_setting('transaction_read_only')='on' as read_only,
 to_regprocedure('public.staffing_attendance_time_warnings(timestamptz,timestamptz)')is not null as warning_function_present,
 position('ATTENDANCE_ANOMALY_CONFIRMATION_REQUIRED' in pg_get_functiondef('public.staffing_review_attendance(uuid,boolean,jsonb)'::regprocedure))>0 as acceptance_requires_acknowledgement,
 position('time_anomalies_acknowledged' in pg_get_functiondef('public.staffing_review_attendance(uuid,boolean,jsonb)'::regprocedure))>0 as exception_audit_enabled,
 exists(select 1 from pg_constraint where conrelid='public.staffing_sessions'::regclass and conname='staffing_sessions_reviewed_time_order' and convalidated) as reviewed_time_order_constraint_present,
 (select bool_and(not has_function_privilege('anon',p.oid,'execute')and not has_function_privilege('authenticated',p.oid,'execute')and has_function_privilege('service_role',p.oid,'execute'))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and p.proname in('staffing_attendance_time_warnings','staffing_review_attendance')) as function_permissions_correct;
commit;
