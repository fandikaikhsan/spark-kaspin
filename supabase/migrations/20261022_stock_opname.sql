-- Fixed daily/weekly counting form. No inventory movements or costing are posted.
begin;
create or replace function public.stock_opname_field_section(p_key text)
returns text language sql immutable set search_path=public as $$
  select case
    when p_key in ('prep-bayam-krispi','prep-sambal','prep-ayam-suwir','prep-base-nasgor','prep-base-carbonara','prep-ayam-sous-vide') then 'prep'
    when p_key in ('beef-shortplate','dada-ayam-fillet','paha-ayam-fillet','sosis','nugget','kentang','kornet','roti-kadet','beras','telur','minyak-goreng','kaldu-jamur','lada-hitam','bawang-goreng','saus-tiram','saus-teriyaki','kecap-manis','saus-sambal','susu','stevia','mi-telur','chatramue') then 'inventory'
    when p_key in ('bawang-merah','bawang-putih','tomat','cabe-besar','cabe-rawit','bayam','daun-bawang','garam','gula','jinten','kencur','kemiri') then 'restock'
  end;
$$;
create table if not exists public.stock_opnames (
  id uuid primary key,
  store_id uuid not null references public.stores(id) on delete restrict,
  count_date date not null check (count_date between date '0001-01-01' and date '9999-12-31'),
  counted_by text not null check (counted_by in ('Andi Salsa','Chandra','Erel Faizar','Erlina','Fathir','Hanifatun','Hikma','Ihza Nataya','Nabila','Niatri','Shalsa Audri','Vizhal','Wardana','Zulkifli')),
  submitted_by text not null check (length(btrim(submitted_by)) between 1 and 200),
  submitted_at timestamptz not null default clock_timestamp()
);
create index if not exists stock_opnames_store_recent on public.stock_opnames(store_id,submitted_at desc,id desc);
create table if not exists public.stock_opname_lines (
  stock_opname_id uuid not null references public.stock_opnames(id) on delete cascade,
  field_key text not null,
  section text not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  uom text,
  note text not null default '',
  quantity numeric,
  needs_restock boolean,
  -- Optional catalog links; names/units are retained as counted, even before all bases exist.
  item_id text references public.items(id) on delete restrict,
  base_id text references public.bases(id) on delete restrict,
  primary key (stock_opname_id,field_key),
  check (public.stock_opname_field_section(field_key) is not null and section=public.stock_opname_field_section(field_key)),
  check ((section in ('prep','inventory') and quantity is not null and quantity>=0 and quantity<=1000000000000 and needs_restock is null and uom is not null and length(btrim(uom))>0)
    or (section='restock' and quantity is null and needs_restock is not null and uom is null)),
  check ((section='prep' and item_id is null) or (section in ('inventory','restock') and base_id is null))
);
create or replace function public.validate_stock_opname(p_id uuid)
returns void language plpgsql set search_path=public as $$
begin
  if exists(select 1 from public.stock_opnames where id=p_id)
    and (select count(*) from public.stock_opname_lines where stock_opname_id=p_id)<>40 then
    raise exception 'A stock opname must contain all 40 fields' using errcode='23514';
  end if;
end;
$$;
create or replace function public.check_stock_opname_complete()
returns trigger language plpgsql set search_path=public as $$
begin
  if tg_table_name='stock_opnames' then
    perform public.validate_stock_opname(new.id);
  else
    if tg_op<>'DELETE' then perform public.validate_stock_opname(new.stock_opname_id); end if;
    if tg_op<>'INSERT' then perform public.validate_stock_opname(old.stock_opname_id); end if;
  end if;
  return null;
end;
$$;
drop trigger if exists stock_opnames_complete on public.stock_opnames;
create constraint trigger stock_opnames_complete after insert or update on public.stock_opnames
  deferrable initially deferred for each row execute function public.check_stock_opname_complete();
drop trigger if exists stock_opname_lines_complete on public.stock_opname_lines;
create constraint trigger stock_opname_lines_complete after insert or update or delete on public.stock_opname_lines
  deferrable initially deferred for each row execute function public.check_stock_opname_complete();

create or replace function public.submit_stock_opname(p_id uuid,p_store uuid,p_date date,p_counter text,p_submitted_by text,p_lines jsonb)
returns jsonb language plpgsql set search_path=public as $$
declare v_inserted uuid; v_previous public.stock_opnames%rowtype; v_existing jsonb; v_answers jsonb;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'Lines required' using errcode='22023'; end if;
  if jsonb_array_length(p_lines)<>40 then raise exception 'All 40 fields required' using errcode='23514'; end if;
  perform 1 from public.stores where id=p_store and active=true for share;
  if not found then raise exception 'Active store required' using errcode='23514'; end if;
  insert into public.stock_opnames(id,store_id,count_date,counted_by,submitted_by)
    values(p_id,p_store,p_date,p_counter,p_submitted_by) on conflict(id) do nothing returning id into v_inserted;
  if v_inserted is null then
    select * into v_previous from public.stock_opnames where id=p_id for update;
    select jsonb_agg(jsonb_build_object('key',field_key,'qty',quantity,'restock',needs_restock) order by field_key)
      into v_existing from public.stock_opname_lines where stock_opname_id=p_id;
    select jsonb_agg(jsonb_build_object('key',value->>'field_key','qty',(value->>'quantity')::numeric,'restock',(value->>'needs_restock')::boolean) order by value->>'field_key')
      into v_answers from jsonb_array_elements(p_lines);
    if v_previous.store_id=p_store and v_previous.count_date=p_date and v_previous.counted_by=p_counter and v_previous.submitted_by=p_submitted_by and v_existing=v_answers then
      return jsonb_build_object('id',p_id,'replayed',true);
    end if;
    raise exception 'Submission ID already used with different answers' using errcode='23505';
  end if;
  insert into public.stock_opname_lines(stock_opname_id,field_key,section,name,uom,note,quantity,needs_restock,item_id,base_id)
    select p_id,value->>'field_key',value->>'section',value->>'name',value->>'uom',coalesce(value->>'note',''),
      (value->>'quantity')::numeric,(value->>'needs_restock')::boolean,value->>'item_id',value->>'base_id'
    from jsonb_array_elements(p_lines);
  perform public.validate_stock_opname(p_id);
  return jsonb_build_object('id',p_id,'replayed',false);
end;
$$;
alter table public.stock_opnames enable row level security;
alter table public.stock_opname_lines enable row level security;
revoke all on public.stock_opnames,public.stock_opname_lines from public,anon,authenticated;
grant all on public.stock_opnames,public.stock_opname_lines to service_role;
revoke all on function public.stock_opname_field_section(text),public.validate_stock_opname(uuid),public.check_stock_opname_complete(),public.submit_stock_opname(uuid,uuid,date,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.stock_opname_field_section(text),public.validate_stock_opname(uuid),public.check_stock_opname_complete(),public.submit_stock_opname(uuid,uuid,date,text,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
