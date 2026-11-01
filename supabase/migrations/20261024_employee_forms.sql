-- Public HTTP forms still write through the server role. No anonymous DB grants.
begin;
create or replace function public.submit_stock_opname_now(p_id uuid,p_store uuid,p_counter text,p_submitted_by text,p_lines jsonb)
returns jsonb language plpgsql set search_path=public as $$
declare v_zone text; v_time timestamptz; v_date date; v_result jsonb;
begin
  -- Serialize retries with this same id, including two simultaneous requests.
  perform pg_advisory_xact_lock(hashtextextended('stock-opname:'||p_id::text,0));
  select time_zone into v_zone from public.stores where id=p_store and active for share;
  if v_zone is null then raise exception 'Active store required' using errcode='23514'; end if;
  select counted_at,count_date into v_time,v_date from public.stock_opnames where id=p_id;
  if not found then
    v_time:=clock_timestamp();
    v_date:=(v_time at time zone v_zone)::date;
  elsif v_time is null then
    raise exception 'Existing date-only submission cannot change its count time' using errcode='23505';
  end if;
  v_result:=public.submit_stock_opname_at(p_id,p_store,v_date,p_counter,p_submitted_by,p_lines,v_time);
  if not (v_result->>'replayed')::boolean then
    -- Exactly the same server timestamp for submission and the MVP count cutoff.
    update public.stock_opnames set submitted_at=v_time where id=p_id;
  end if;
  return v_result;
end;
$$;
revoke all on function public.submit_stock_opname_now(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.submit_stock_opname_now(uuid,uuid,text,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
