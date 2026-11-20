-- READ ONLY. After 20261120120000_staffing_telegram_simplification.sql; all columns true.
begin transaction read only;
select
 to_regclass('public.staffing_overtime_requests')is not null as overtime_requests_present,
 to_regclass('public.staffing_absence_fines')is not null as case_fines_present,
 (select bool_and(c.relrowsecurity and not has_table_privilege('anon',c.oid,'select,insert,update,delete')and not has_table_privilege('authenticated',c.oid,'select,insert,update,delete'))from pg_class c where c.oid in(to_regclass('public.staffing_overtime_requests'),to_regclass('public.staffing_absence_fines')))as private_tables_protected,
 (select bool_and(not has_function_privilege('anon',p.oid,'execute')and not has_function_privilege('authenticated',p.oid,'execute')and has_function_privilege('service_role',p.oid,'execute'))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and left(p.proname,9)='staffing_')as functions_server_only,
 position('staffing_attendance_update_v13'in pg_get_functiondef('public.staffing_apply_update(jsonb)'::regprocedure))>0 as private_attendance_dispatcher_current,
 position('verification_chat_id'in pg_get_functiondef('public.staffing_attendance_update_v13(jsonb)'::regprocedure))>0 as private_verification_supported,
 to_regprocedure('public.staffing_decide_overtime(uuid,boolean,uuid,text,text)')is not null as overtime_review_available,
 to_regprocedure('public.staffing_record_absence_fine(uuid,boolean,jsonb)')is not null as verified_case_fines_available,
 position('overtime_request_required'in pg_get_functiondef('public.staffing_attendance_metadata(uuid)'::regprocedure))>0 as overtime_policy_current,
 position('overtime_requests'in pg_get_functiondef('public.staffing_activity(uuid,boolean,uuid,date)'::regprocedure))>0 as manager_queue_current,
 position('pending_overtime'in pg_get_functiondef('public.staffing_payroll_source(uuid,boolean,uuid,date,date)'::regprocedure))>0 as payroll_pending_review_guard,
 to_regprocedure('public.staffing_bot_private_legacy_v13(bigint,bigint,text)')is not null as hidden_finance_code_preserved;
commit;
