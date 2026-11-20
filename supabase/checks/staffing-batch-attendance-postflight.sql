-- READ ONLY. Run after 20261120200000_staffing_batch_attendance.sql.
-- All columns must be true. Does not record attendance or send messages.
begin transaction read only;
with required(name)as(values('staffing_attendance_batches'),('staffing_attendance_batch_members'),('staffing_unplanned_sessions'))
select
 current_setting('transaction_read_only')='on'as read_only,
 (select bool_and(to_regclass('public.'||name)is not null)from required)as capture_tables_present,
 (select bool_and(c.relrowsecurity and not has_table_privilege('anon',c.oid,'select,insert,update,delete')and not has_table_privilege('authenticated',c.oid,'select,insert,update,delete'))from required r join pg_class c on c.oid=to_regclass('public.'||r.name))as capture_tables_private,
 position('staffing_batch_start'in pg_get_functiondef('public.staffing_apply_update(jsonb)'::regprocedure))>0 and position('staffing_apply_update_v20'in pg_get_functiondef('public.staffing_apply_update(jsonb)'::regprocedure))>0 as batch_and_legacy_dispatcher,
 to_regprocedure('public.staffing_resolve_unplanned(uuid,boolean,jsonb)')is not null as manager_resolution_available,
 position('unplanned_attendance'in pg_get_functiondef('public.staffing_payroll_source(uuid,boolean,uuid,date,date)'::regprocedure))>0 as unresolved_payroll_guard,
 position('staffing_note_suffix'in pg_get_functiondef('public.staffing_notify_personal_result()'::regprocedure))>0 and position('staffing_note_suffix'in pg_get_functiondef('public.staffing_decide_overtime(uuid,boolean,uuid,text,text)'::regprocedure))>0 as optional_notes_formatted,
 exists(select 1 from pg_index where indexrelid=to_regclass('public.staffing_event_update_session')and indisunique and indisvalid)as per_session_update_deduplication,
 (select bool_and(not has_function_privilege('anon',p.oid,'execute')and not has_function_privilege('authenticated',p.oid,'execute')and has_function_privilege('service_role',p.oid,'execute'))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and left(p.proname,9)='staffing_')as all_functions_server_only;
commit;
