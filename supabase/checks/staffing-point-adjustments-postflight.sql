-- READ ONLY. Run after 20261111190000_staffing_point_adjustments.sql. All columns true.
begin transaction read only;
select
 to_regprocedure('public.staffing_warning_manage_v1(uuid,boolean,text,jsonb)')is not null as previous_warning_actions_preserved,
 position('adjust_points'in pg_get_functiondef('public.staffing_warning_manage(uuid,boolean,text,jsonb)'::regprocedure))>0 as balance_adjustment_available,
 exists(select 1 from pg_constraint where conrelid='public.staffing_discipline'::regclass and conname='staffing_discipline_points_check'and position('adjustment'in pg_get_constraintdef(oid))>0)as signed_adjustments_supported,
 exists(select 1 from pg_trigger where tgrelid='public.staffing_discipline'::regclass and tgname='staffing_points_guard'and tgenabled<>'D')as immutable_points_enabled,
 (select bool_and(not has_function_privilege('anon',p.oid,'execute')and not has_function_privilege('authenticated',p.oid,'execute')and has_function_privilege('service_role',p.oid,'execute'))from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'and left(p.proname,9)='staffing_')as function_permissions_correct;
commit;
