-- READ ONLY. Run after 20261111170000_staffing_warnings.sql. All columns must be true.
begin transaction read only;
with required_tables(name)as(values
 ('staffing_warnings'),('staffing_warning_sequences'),('staffing_warning_events'),('staffing_warning_deliveries')
), required_functions(signature)as(values
 ('public.staffing_warning_list(uuid,boolean,uuid)'),
 ('public.staffing_warning_detail(uuid,boolean,uuid)'),
 ('public.staffing_warning_document(uuid,boolean,uuid)'),
 ('public.staffing_warning_manage(uuid,boolean,text,jsonb)'),
 ('public.staffing_warning_download(uuid,boolean,uuid,text)'),
 ('public.staffing_warning_reserve_delivery(uuid,boolean,uuid,text,text)'),
 ('public.staffing_warning_finish_delivery(uuid,uuid,text,bigint)'),
 ('public.staffing_warning_resolve_delivery(uuid,boolean,uuid,jsonb)')
)
select
 current_setting('transaction_read_only')='on' as read_only,
 (select bool_and(to_regclass('public.'||name)is not null)from required_tables)as warning_tables_present,
 (select bool_and(coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.'||name)),false))from required_tables)as warning_tables_rls,
 (select bool_and(not has_table_privilege('anon',to_regclass('public.'||name),'select,insert,update,delete')and not has_table_privilege('authenticated',to_regclass('public.'||name),'select,insert,update,delete'))from required_tables)as client_table_access_blocked,
 (select bool_and(to_regprocedure(signature)is not null)from required_functions)as required_functions_present,
 (select bool_and(not has_function_privilege('anon',p.oid,'execute')and not has_function_privilege('authenticated',p.oid,'execute')and has_function_privilege('service_role',p.oid,'execute'))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and left(p.proname,9)='staffing_')as function_permissions_correct,
 exists(select 1 from pg_trigger where tgrelid='public.staffing_discipline'::regclass and tgname='staffing_points_guard'and tgenabled<>'D')as immutable_points_enabled,
 exists(select 1 from pg_trigger where tgrelid='public.staffing_staff'::regclass and tgname='staffing_warning_recipient_pin'and tgenabled<>'D')as recipient_pin_enabled,
 exists(select 1 from pg_index i where i.indexrelid=to_regclass('public.staffing_warning_points_once')and i.indisunique and i.indisvalid)as unique_warning_points,
 (position('warning_points'in pg_get_functiondef('public.staffing_staff_detail(uuid,boolean,uuid)'::regprocedure))>0 or(position('staffing_staff_detail_v14'in pg_get_functiondef('public.staffing_staff_detail(uuid,boolean,uuid)'::regprocedure))>0 and position('warning_points'in pg_get_functiondef(to_regprocedure('public.staffing_staff_detail_v14(uuid,boolean,uuid)')))>0))as staff_detail_current;
commit;
