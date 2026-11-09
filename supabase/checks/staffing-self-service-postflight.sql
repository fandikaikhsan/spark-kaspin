-- READ ONLY. Run after 20261109180000_staffing_self_service.sql. All columns must be true.
begin transaction read only;
select
 to_regclass('public.staffing_private_flows') is not null as private_flows_present,
 exists(select 1 from pg_class where oid=to_regclass('public.staffing_private_flows') and relrowsecurity) as private_flows_rls,
 not has_table_privilege('anon','public.staffing_private_flows','select,insert,update,delete')
 and not has_table_privilege('authenticated','public.staffing_private_flows','select,insert,update,delete') as private_flows_client_access_blocked,
 exists(select 1 from information_schema.columns where table_schema='public' and table_name='staffing_requests' and column_name='evidence_file_id') as request_evidence_present,
 (select bool_and(not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute') and has_function_privilege('service_role',p.oid,'execute'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and left(p.proname,9)='staffing_') as function_permissions_correct,
 position('staffing_private_request' in pg_get_functiondef('public.staffing_apply_update(jsonb)'::regprocedure))>0
 and position('staffing_apply_update_v4' in pg_get_functiondef('public.staffing_apply_update(jsonb)'::regprocedure))>0
 and position('staffing_lock_group' in pg_get_functiondef('public.staffing_apply_update(jsonb)'::regprocedure))>0 as dispatcher_current,
 position('private_flow_token' in pg_get_functiondef('public.staffing_deliver_outbox(bigint,bigint)'::regprocedure))>0 as private_prompt_receipts_current,
 exists(select 1 from pg_constraint where conrelid='public.stores'::regclass and conname='stores_time_zone_check' and position('Asia/Jayapura' in pg_get_constraintdef(oid))>0) as wit_supported;
commit;
