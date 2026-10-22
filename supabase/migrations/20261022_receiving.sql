-- Quantity-only receiving, separate from purchasing and physical stock counts.
begin;
create table if not exists public.receivings (
  id uuid primary key,
  store_id uuid not null references public.stores(id) on delete restrict,
  received_by text not null check (received_by in ('Andi Salsa','Chandra','Erel Faizar','Erlina','Fathir','Hanifatun','Hikma','Ihza Nataya','Nabila','Niatri','Shalsa Audri','Vizhal','Wardana','Zulkifli')),
  submitted_by text not null check (length(btrim(submitted_by)) between 1 and 200),
  received_at timestamptz not null default clock_timestamp()
);
create index if not exists receivings_store_recent on public.receivings(store_id,received_at desc,id desc);
create table if not exists public.receiving_lines (
  receiving_id uuid not null references public.receivings(id) on delete cascade,
  line_number integer not null check (line_number between 1 and 100),
  item_id text not null references public.items(id) on delete restrict,
  quantity numeric not null check (quantity between 0.000000001 and 1000000000000),
  -- Retain the item/unit definition at receipt time, even after catalog edits.
  item_name text not null,
  purchase_unit_id uuid not null references public.units(id) on delete restrict,
  purchase_unit_name text not null,
  base_uom text not null,
  purchase_conversion numeric not null check (purchase_conversion between 0.000000001 and 1000000000000),
  item_updated_at timestamptz not null,
  primary key (receiving_id,line_number),
  unique (receiving_id,item_id)
);
create or replace function public.validate_receiving(p_id uuid)
returns void language plpgsql set search_path=public as $$
begin
  if exists(select 1 from public.receivings where id=p_id)
    and (select count(*) from public.receiving_lines where receiving_id=p_id) not between 1 and 100 then
    raise exception 'Receiving requires 1 to 100 items' using errcode='23514';
  end if;
end;
$$;
create or replace function public.check_receiving_complete()
returns trigger language plpgsql set search_path=public as $$
begin
  if tg_table_name='receivings' then perform public.validate_receiving(new.id);
  else
    if tg_op<>'DELETE' then perform public.validate_receiving(new.receiving_id); end if;
    if tg_op<>'INSERT' then perform public.validate_receiving(old.receiving_id); end if;
  end if;
  return null;
end;
$$;
drop trigger if exists receivings_complete on public.receivings;
create constraint trigger receivings_complete after insert or update on public.receivings
  deferrable initially deferred for each row execute function public.check_receiving_complete();
drop trigger if exists receiving_lines_complete on public.receiving_lines;
create constraint trigger receiving_lines_complete after insert or update or delete on public.receiving_lines
  deferrable initially deferred for each row execute function public.check_receiving_complete();

create or replace function public.submit_receiving(p_id uuid,p_store uuid,p_receiver text,p_submitted_by text,p_lines jsonb)
returns jsonb language plpgsql set search_path=public as $$
declare v_inserted uuid; v_previous public.receivings%rowtype; v_existing jsonb; v_request jsonb; v_row record; v_item record;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'Items required' using errcode='22023'; end if;
  if jsonb_array_length(p_lines) not between 1 and 100 then raise exception 'Add 1 to 100 items' using errcode='23514'; end if;
  perform 1 from public.stores where id=p_store and active=true for share;
  if not found then raise exception 'Active store required' using errcode='23514'; end if;
  insert into public.receivings(id,store_id,received_by,submitted_by)
    values(p_id,p_store,p_receiver,p_submitted_by) on conflict(id) do nothing returning id into v_inserted;
  if v_inserted is null then
    select * into v_previous from public.receivings where id=p_id for update;
    select jsonb_agg(jsonb_build_object('item',item_id,'qty',quantity,'revision',item_updated_at) order by item_id)
      into v_existing from public.receiving_lines where receiving_id=p_id;
    select jsonb_agg(jsonb_build_object('item',value->>'itemId','qty',(value->>'quantity')::numeric,'revision',(value->>'itemUpdatedAt')::timestamptz) order by value->>'itemId')
      into v_request from jsonb_array_elements(p_lines);
    if v_previous.store_id=p_store and v_previous.received_by=p_receiver and v_previous.submitted_by=p_submitted_by and v_existing=v_request then
      return jsonb_build_object('id',p_id,'replayed',true);
    end if;
    raise exception 'Receiving ID already used with different items' using errcode='23505';
  end if;
  -- Stable lock order avoids deadlocks between deliveries containing the same items.
  for v_row in select value,ordinality from jsonb_array_elements(p_lines) with ordinality order by value->>'itemId' loop
    select i.id,i.name,i.base_uom,i.updated_at,i.purchase_unit_id,u.name as unit_name,u.conversion
      into v_item from public.items i join public.units u on u.item_id=i.id and u.id=i.purchase_unit_id
      where i.id=v_row.value->>'itemId' for share of i,u;
    if not found then raise exception 'Existing item required' using errcode='P0002'; end if;
    if (v_row.value->>'itemUpdatedAt')::timestamptz is distinct from v_item.updated_at then
      raise exception 'Item changed since form was loaded' using errcode='40001';
    end if;
    insert into public.receiving_lines(receiving_id,line_number,item_id,quantity,item_name,purchase_unit_id,purchase_unit_name,base_uom,purchase_conversion,item_updated_at)
      values(p_id,v_row.ordinality,v_item.id,(v_row.value->>'quantity')::numeric,v_item.name,v_item.purchase_unit_id,v_item.unit_name,v_item.base_uom,v_item.conversion,v_item.updated_at);
  end loop;
  perform public.validate_receiving(p_id);
  return jsonb_build_object('id',p_id,'replayed',false);
end;
$$;
alter table public.receivings enable row level security;
alter table public.receiving_lines enable row level security;
revoke all on public.receivings,public.receiving_lines from public,anon,authenticated;
grant all on public.receivings,public.receiving_lines to service_role;
revoke all on function public.validate_receiving(uuid),public.check_receiving_complete(),public.submit_receiving(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.validate_receiving(uuid),public.check_receiving_complete(),public.submit_receiving(uuid,uuid,text,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
