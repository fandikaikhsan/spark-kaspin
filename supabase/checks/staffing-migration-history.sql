-- READ ONLY: run through the existing CI database connection / SQL client.
-- Copy the migration_history JSON cell (not credentials) to a local history.json.
begin transaction read only;
select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name)order by version),'[]'::jsonb)as migration_history
from supabase_migrations.schema_migrations;
commit;
