-- Product batch yields and item-compatible receiving units. No public access changes.
begin;
alter table public.recipes drop constraint if exists recipes_product_yield;
alter table public.products add column if not exists base_uom text not null default 'porsi';
alter table public.products drop constraint if exists products_output_unit;
alter table public.products add constraint products_output_unit check(base_uom in ('porsi','g','kg','ml','l','pcs'));
create or replace function public.save_catalog_product(p_id text,p_input jsonb)
returns text language plpgsql set search_path=public as $$
declare v_id text; v_recipe uuid; v_row record;
begin
  if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Product must be an object' using errcode='22023'; end if;
  if jsonb_typeof(p_input->'ingredients') is distinct from 'array' then raise exception 'Ingredients required' using errcode='22023'; end if;
  if jsonb_array_length(p_input->'ingredients') not between 1 and 200 then raise exception 'Add 1 to 200 ingredients' using errcode='23514'; end if;
  if p_id is null then
    v_id:=coalesce(nullif(btrim(p_input->>'id'),''),gen_random_uuid()::text); v_recipe:=gen_random_uuid();
    insert into public.products(id,name,type,parent_product_id,category_id,sales_price,base_uom,recipe_id)
      values(v_id,btrim(p_input->>'name'),p_input->>'type',nullif(p_input->>'parentProductId',''),nullif(p_input->>'categoryId','')::uuid,(p_input->>'salesPrice')::numeric,coalesce(p_input->>'baseUom','porsi'),v_recipe);
    insert into public.recipes(id,output_product_id,yield_qty) values(v_recipe,v_id,coalesce((p_input->>'yieldQuantity')::numeric,1));
  else
    if nullif(btrim(p_input->>'id'),'') is not null and btrim(p_input->>'id')<>p_id then raise exception 'Product ID cannot change' using errcode='22023'; end if;
    select id,recipe_id into v_id,v_recipe from public.products where id=p_id for update;
    if not found then raise exception 'Product not found' using errcode='P0002'; end if;
    update public.products set name=btrim(p_input->>'name'),type=p_input->>'type',parent_product_id=nullif(p_input->>'parentProductId',''),
      category_id=nullif(p_input->>'categoryId','')::uuid,sales_price=(p_input->>'salesPrice')::numeric,base_uom=coalesce(p_input->>'baseUom','porsi') where id=v_id;
    update public.recipes set yield_qty=coalesce((p_input->>'yieldQuantity')::numeric,1) where id=v_recipe;
    delete from public.recipe_ingredients where recipe_id=v_recipe;
  end if;
  for v_row in select value,ordinality from jsonb_array_elements(p_input->'ingredients') with ordinality loop
    if coalesce(v_row.value->>'kind','') not in ('item','base') then raise exception 'Only raw material or base ingredients allowed' using errcode='23514'; end if;
    insert into public.recipe_ingredients(recipe_id,line_number,item_id,base_id,quantity,uom)
      values(v_recipe,v_row.ordinality,case when v_row.value->>'kind'='item' then v_row.value->>'ingredientId' end,
        case when v_row.value->>'kind'='base' then v_row.value->>'ingredientId' end,(v_row.value->>'quantity')::numeric,btrim(v_row.value->>'uom'));
  end loop;
  perform public.validate_base_recipe(v_recipe);
  return v_id;
end;
$$;

alter table public.receiving_lines add column if not exists received_uom text;
alter table public.receiving_lines add column if not exists received_conversion numeric;
-- Existing receipts were recorded in their saved purchase unit. Preserve those amounts.
update public.receiving_lines set received_uom=purchase_unit_name,received_conversion=purchase_conversion where received_uom is null;
alter table public.receiving_lines alter column received_uom set not null;
alter table public.receiving_lines alter column received_conversion set not null;
alter table public.receiving_lines drop constraint if exists receiving_lines_received_unit;
alter table public.receiving_lines add constraint receiving_lines_received_unit check(length(btrim(received_uom)) between 1 and 80 and received_conversion between 0.000000001 and 1000000000000);
alter table public.receiving_lines add column if not exists quantity_base numeric generated always as (quantity*received_conversion) stored;
create or replace function public.submit_receiving(p_id uuid,p_store uuid,p_receiver text,p_submitted_by text,p_lines jsonb)
returns jsonb language plpgsql set search_path=public as $$
declare v_inserted uuid; v_previous public.receivings%rowtype; v_existing jsonb; v_request jsonb; v_row record; v_item record; v_uom text; v_factor numeric;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' then raise exception 'Items required' using errcode='22023'; end if;
  if jsonb_array_length(p_lines) not between 1 and 100 then raise exception 'Add 1 to 100 items' using errcode='23514'; end if;
  perform 1 from public.stores where id=p_store and active=true for share;
  if not found then raise exception 'Active store required' using errcode='23514'; end if;
  insert into public.receivings(id,store_id,received_by,submitted_by)
    values(p_id,p_store,p_receiver,p_submitted_by) on conflict(id) do nothing returning id into v_inserted;
  if v_inserted is null then
    select * into v_previous from public.receivings where id=p_id for update;
    select jsonb_agg(jsonb_build_object('item',item_id,'qty',quantity,'revision',item_updated_at,'uom',lower(received_uom)) order by item_id)
      into v_existing from public.receiving_lines where receiving_id=p_id;
    select jsonb_agg(jsonb_build_object('item',l.value->>'itemId','qty',(l.value->>'quantity')::numeric,'revision',(l.value->>'itemUpdatedAt')::timestamptz,'uom',lower(btrim(coalesce(l.value->>'uom',s.received_uom)))) order by l.value->>'itemId')
      into v_request from jsonb_array_elements(p_lines) l(value) left join public.receiving_lines s on s.receiving_id=p_id and s.item_id=l.value->>'itemId';
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
    v_uom:=btrim(coalesce(v_row.value->>'uom',v_item.unit_name));
    v_factor:=public.inventory_standard_conversion(v_uom,v_item.base_uom);
    if v_factor is null then
      if lower(v_uom)<>lower(v_item.unit_name) then raise exception 'Unknown receiving unit' using errcode='23514'; end if;
      v_factor:=v_item.conversion; v_uom:=v_item.unit_name;
    else v_uom:=lower(v_uom); end if;
    insert into public.receiving_lines(receiving_id,line_number,item_id,quantity,item_name,purchase_unit_id,purchase_unit_name,base_uom,purchase_conversion,item_updated_at,received_uom,received_conversion)
      values(p_id,v_row.ordinality,v_item.id,(v_row.value->>'quantity')::numeric,v_item.name,v_item.purchase_unit_id,v_item.unit_name,v_item.base_uom,v_item.conversion,v_item.updated_at,v_uom,v_factor);
  end loop;
  perform public.validate_receiving(p_id);
  return jsonb_build_object('id',p_id,'replayed',false);
end;
$$;

notify pgrst,'reload schema';
commit;
