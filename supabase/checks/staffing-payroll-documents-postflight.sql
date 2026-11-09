-- READ ONLY. Run after 20261109210000_staffing_payroll_documents_proxy.sql; all columns true.
begin transaction read only;
select
 to_regclass('public.staffing_payroll_deliveries')is not null as delivery_table_present,
 exists(select 1 from pg_class where oid=to_regclass('public.staffing_payroll_deliveries')and relrowsecurity)
 and not has_table_privilege('anon','public.staffing_payroll_deliveries','select,insert,update,delete')
 and not has_table_privilege('authenticated','public.staffing_payroll_deliveries','select,insert,update,delete') as delivery_client_access_blocked,
 to_regprocedure('public.staffing_reserve_payroll_delivery(uuid,boolean,uuid,text)')is not null as recipient_reservation_present,
 exists(select 1 from pg_trigger where tgrelid='public.staffing_staff'::regclass and tgname='staffing_payroll_recipient_guard'and tgenabled<>'D')as recipient_pin_enabled,
 position('staffing_attendance_update_v7'in pg_get_functiondef('public.staffing_apply_update(jsonb)'::regprocedure))>0 as proxy_dispatcher_current,
 exists(select 1 from information_schema.columns where table_schema='public'and table_name='staffing_attempts'and column_name='submitted_by_staff_id') as reporter_identity_present,
 position('Catatan opsional' in pg_get_functiondef('public.staffing_review_attendance(uuid,boolean,jsonb)'::regprocedure))>0
 or position('catatan opsional' in pg_get_functiondef('public.staffing_review_attendance(uuid,boolean,jsonb)'::regprocedure))>0 as review_note_optional,
 (select bool_and(not has_function_privilege('anon',p.oid,'execute')and not has_function_privilege('authenticated',p.oid,'execute')and has_function_privilege('service_role',p.oid,'execute'))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and left(p.proname,9)='staffing_') as function_permissions_correct;
commit;
