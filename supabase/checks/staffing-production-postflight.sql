-- READ ONLY. Run after all seven Staffing migrations have succeeded.
-- Every result column should be true. This does not send Telegram messages.
begin transaction read only;
with required_functions(signature)as(values
  ('public.staffing_dashboard(uuid,boolean)'),
  ('public.staffing_schedule_week(uuid,boolean,uuid,date)'),
  ('public.staffing_commit_week(uuid,boolean,uuid,date,text,jsonb)'),
  ('public.staffing_operations(uuid,boolean,text,jsonb)'),
  ('public.staffing_create_staff(uuid,boolean,jsonb)'),
  ('public.staffing_review_attendance(uuid,boolean,jsonb)'),
  ('public.staffing_decide_shift(uuid,boolean,uuid,text,text)'),
  ('public.staffing_save_group(uuid,boolean,uuid,bigint,bigint,text)'),
  ('public.staffing_apply_update(jsonb)'),
  ('public.staffing_apply_update_v4(jsonb)'),
  ('public.staffing_attendance_update_v3(jsonb)')
), tables_checked as(
  select c.oid,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public'and left(c.relname,9)='staffing_'and c.relkind in('r','p')
), functions_checked as(
  select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public'and left(p.proname,9)='staffing_'
)
select
  current_setting('transaction_read_only')='on' as read_only,
  (select bool_and(to_regprocedure(signature)is not null)from required_functions)as required_functions_present,
  (select count(*)>0 and coalesce(bool_and(relrowsecurity),false)from tables_checked)as tables_have_rls,
  (select count(*)>0 and coalesce(bool_and(
    not has_table_privilege('anon',oid,'select,insert,update,delete')
    and not has_table_privilege('authenticated',oid,'select,insert,update,delete')
  ),false)from tables_checked)as client_table_access_blocked,
  (select count(*)>0 and coalesce(bool_and(
    not has_function_privilege('anon',oid,'execute')
    and not has_function_privilege('authenticated',oid,'execute')
    and has_function_privilege('service_role',oid,'execute')
  ),false)from functions_checked)as function_permissions_correct,
  coalesce(
    position('staffing_apply_update_v4'in pg_get_functiondef(to_regprocedure('public.staffing_apply_update(jsonb)')))>0
    and position('staffing_lock_group'in pg_get_functiondef(to_regprocedure('public.staffing_apply_update(jsonb)')))>0
    and position('staffing_attendance_update_v3'in pg_get_functiondef(to_regprocedure('public.staffing_apply_update_v4(jsonb)')))>0,
    false
  )as telegram_dispatcher_current,
  exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public'and c.relname='staffing_one_group_per_store'and i.indisunique and i.indisvalid
      and i.indrelid=to_regclass('public.staffing_groups'))as one_group_per_store_enforced;
commit;
