-- READ ONLY. Run on the existing Spark database before deploying Staffing.
-- Prerequisite: public.stores and public.app_users already exist.
-- This inspects catalogs/history presence; it never applies/repairs migrations.
begin transaction read only;

with required_columns(table_name, column_name, expected_type) as (values
  ('stores','id','uuid'), ('stores','name','text'),
  ('stores','active','boolean'), ('stores','time_zone','text'),
  ('app_users','id','uuid'), ('app_users','username','text'),
  ('app_users','role','text'), ('app_users','active','boolean')
), columns_checked as (
  select r.*, format_type(a.atttypid,a.atttypmod) as actual_type,
    coalesce(format_type(a.atttypid,a.atttypmod)=r.expected_type,false) as ok
  from required_columns r
  left join pg_namespace n on n.nspname='public'
  left join pg_class c on c.relnamespace=n.oid and c.relname=r.table_name
  left join pg_attribute a on a.attrelid=c.oid and a.attname=r.column_name
    and a.attnum>0 and not a.attisdropped
)
select jsonb_build_object(
  'read_only', current_setting('transaction_read_only'),
  'required_columns', (select jsonb_agg(to_jsonb(c) order by table_name,column_name) from columns_checked c),
  'single_column_id_primary_keys', (select jsonb_object_agg(t.name,exists(
    select 1 from pg_constraint co join pg_attribute a
      on a.attrelid=co.conrelid and a.attnum=co.conkey[1]
    where co.conrelid=to_regclass('public.'||t.name)
      and co.contype='p' and cardinality(co.conkey)=1 and a.attname='id'
  )) from (values ('stores'),('app_users'))t(name)),
  'app_user_role_counts', (select coalesce(jsonb_object_agg(role,total),'{}'::jsonb)
    from(select role,count(*) as total from public.app_users group by role)r),
  'incompatible_app_user_roles', (select count(*) from public.app_users where role is null or role not in ('admin','manager')),
  'additional_role_constraints', (select coalesce(jsonb_agg(co.conname),'[]'::jsonb)
    from pg_constraint co join pg_attribute a on a.attrelid=co.conrelid and a.attname='role'
    where co.conrelid='public.app_users'::regclass and co.contype='c'
      and a.attnum=any(co.conkey) and co.conname<>'app_users_role_check'),
  'app_user_check_constraints', (select coalesce(jsonb_agg(jsonb_build_object(
    'name',conname,'definition',pg_get_constraintdef(oid)) order by conname),'[]'::jsonb)
    from pg_constraint where conrelid='public.app_users'::regclass and contype='c'),
  'existing_staffing_relations', (select coalesce(jsonb_agg(jsonb_build_object(
    'name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity,
    'anon_access',case when c.relkind='r' then has_table_privilege('anon',c.oid,'select,insert,update,delete') else null end,
    'authenticated_access',case when c.relkind='r' then has_table_privilege('authenticated',c.oid,'select,insert,update,delete') else null end) order by c.relname),'[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and left(c.relname,9)='staffing_'),
  'existing_staffing_functions', (select coalesce(jsonb_agg(jsonb_build_object(
    'signature',p.oid::regprocedure::text,'security_definer',p.prosecdef,
    'anon_execute',has_function_privilege('anon',p.oid,'execute'),
    'authenticated_execute',has_function_privilege('authenticated',p.oid,'execute'),
    'service_execute',has_function_privilege('service_role',p.oid,'execute')
  ) order by p.oid::regprocedure::text),'[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and left(p.proname,9)='staffing_'),
  'service_can_read_dependencies', jsonb_build_object(
    'stores',has_table_privilege('service_role','public.stores','select'),
    'app_users',has_table_privilege('service_role','public.app_users','select')),
  'active_stores', (select count(*) from public.stores where active),
  'unsupported_store_time_zones', (select count(*) from public.stores
    where time_zone is null or time_zone not in ('Asia/Jakarta','Asia/Makassar')),
  'uuid_generator_available', to_regprocedure('gen_random_uuid()') is not null,
  'cli_history_present', to_regclass('supabase_migrations.schema_migrations') is not null
) as staffing_preflight;

commit;
