-- READ ONLY. Run after 20261109200000_staffing_request_amendment.sql; all columns true.
begin transaction read only;
select
 (select count(*)=4 from information_schema.columns where table_schema='public' and table_name='staffing_requests' and column_name in('revision','original_values','amended_at','amendment_note')) as amendment_columns_present,
 to_regprocedure('public.staffing_amend_request(uuid,boolean,jsonb)')is not null as amendment_rpc_present,
 exists(select 1 from pg_trigger where tgrelid='public.staffing_requests'::regclass and tgname='staffing_request_amendment_notification' and tgenabled<>'D') as personal_notification_enabled,
 (select bool_and(not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute') and has_function_privilege('service_role',p.oid,'execute')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and left(p.proname,9)='staffing_') as function_permissions_correct,
 (select relrowsecurity from pg_class where oid='public.staffing_requests'::regclass)
 and not has_table_privilege('anon','public.staffing_requests','select,insert,update,delete')
 and not has_table_privilege('authenticated','public.staffing_requests','select,insert,update,delete') as request_client_access_blocked;
commit;
