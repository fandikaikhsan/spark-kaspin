-- Products share the current-recipe infrastructure with Bases. No POS writes.
begin;
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200)
);
create unique index if not exists categories_name_idx on public.categories(lower(btrim(name)));
create table if not exists public.products (
  id text primary key default gen_random_uuid()::text check (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  name text not null check (length(btrim(name)) between 1 and 200),
  type text not null check (type in ('menu','variant','addon')),
  parent_product_id text references public.products(id) on delete restrict,
  category_id uuid references public.categories(id) on delete restrict,
  sales_price numeric not null check (sales_price >= 0 and sales_price <= 1000000000000),
  recipe_id uuid not null unique,
  updated_at timestamptz not null default clock_timestamp(),
  check ((type = 'variant') = (parent_product_id is not null)),
  check (parent_product_id is null or parent_product_id <> id)
);
create index if not exists products_name_idx on public.products(lower(name),id);
create index if not exists products_parent_idx on public.products(parent_product_id);
create index if not exists products_category_idx on public.products(category_id);
alter table public.recipes alter column output_base_id drop not null;
alter table public.recipes add column if not exists output_product_id text unique references public.products(id) on delete cascade;
alter table public.recipes drop constraint if exists recipes_output_required;
alter table public.recipes add constraint recipes_output_required check (num_nonnulls(output_base_id,output_product_id) = 1);
alter table public.recipes drop constraint if exists recipes_product_yield;
do $$ begin
  -- Newer schemas allow batch yields; do not restore the old limit on replay.
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='products' and column_name='base_uom') then
    alter table public.recipes add constraint recipes_product_yield check (output_product_id is null or yield_qty = 1);
  end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid='public.recipes'::regclass and conname='recipes_id_product_key') then
    alter table public.recipes add constraint recipes_id_product_key unique(id,output_product_id);
  end if;
  if not exists (select 1 from pg_constraint where conrelid='public.products'::regclass and conname='products_recipe_fk') then
    alter table public.products add constraint products_recipe_fk foreign key(recipe_id,id)
      references public.recipes(id,output_product_id) deferrable initially deferred;
  end if;
end $$;
alter table public.recipe_ingredients alter column item_id drop not null;
alter table public.recipe_ingredients add column if not exists base_id text references public.bases(id) on delete restrict;
alter table public.recipe_ingredients drop constraint if exists recipe_ingredients_source_required;
alter table public.recipe_ingredients add constraint recipe_ingredients_source_required check(num_nonnulls(item_id,base_id) = 1);
create index if not exists recipe_ingredients_base_idx on public.recipe_ingredients(base_id);
drop trigger if exists products_updated_at on public.products;
create trigger products_updated_at before update on public.products for each row execute function public.touch_inventory_item();

create or replace function public.prepared_base_factor(p_base text,p_uom text)
returns numeric language plpgsql stable set search_path=public as $$
declare v_unit text; v_factor numeric;
begin
  select base_uom into v_unit from public.bases where id=p_base;
  if not found then raise exception 'Base not found' using errcode='23503'; end if;
  if v_unit='porsi' then
    if lower(btrim(p_uom))='porsi' then return 1; end if;
    raise exception 'Portions cannot be converted to weight or volume without a measured conversion' using errcode='23514';
  end if;
  v_factor:=public.inventory_standard_conversion(p_uom,v_unit);
  if v_factor is null then raise exception 'Invalid base ingredient unit' using errcode='23514'; end if;
  return v_factor;
end;
$$;
-- Preserve the original function name used by the Bases RPC and deferred triggers.
create or replace function public.validate_base_recipe(p_recipe uuid)
returns void language plpgsql set search_path=public as $$
declare v_row record; v_count integer; v_base text;
begin
  select output_base_id into v_base from public.recipes where id=p_recipe;
  if not found then return; end if;
  select count(*) into v_count from public.recipe_ingredients where recipe_id=p_recipe;
  if v_count < 1 or v_count > 200 then raise exception 'Recipe needs 1 to 200 ingredients' using errcode='23514'; end if;
  for v_row in select item_id,base_id,uom from public.recipe_ingredients where recipe_id=p_recipe loop
    if v_row.item_id is not null then perform public.base_ingredient_factor(v_row.item_id,v_row.uom);
    else
      if v_base is not null then raise exception 'Base recipes only accept raw materials' using errcode='23514'; end if;
      perform public.prepared_base_factor(v_row.base_id,v_row.uom);
    end if;
  end loop;
end;
$$;
create or replace function public.check_base_recipe()
returns trigger language plpgsql set search_path=public as $$
declare v_recipe uuid;
begin
  if tg_table_name='recipes' then
    if tg_op<>'INSERT' then perform public.validate_base_recipe(old.id); end if;
    if tg_op<>'DELETE' then perform public.validate_base_recipe(new.id); end if;
  elsif tg_table_name='recipe_ingredients' then
    if tg_op<>'INSERT' then perform public.validate_base_recipe(old.recipe_id); end if;
    if tg_op<>'DELETE' then perform public.validate_base_recipe(new.recipe_id); end if;
  elsif tg_table_name='bases' then
    for v_recipe in select distinct recipe_id from public.recipe_ingredients where base_id=new.id loop perform public.validate_base_recipe(v_recipe); end loop;
  elsif tg_table_name='items' then
    for v_recipe in select distinct recipe_id from public.recipe_ingredients where item_id=new.id loop perform public.validate_base_recipe(v_recipe); end loop;
  else
    for v_recipe in select distinct recipe_id from public.recipe_ingredients where item_id=old.item_id or item_id=new.item_id loop perform public.validate_base_recipe(v_recipe); end loop;
  end if;
  return null;
end;
$$;
drop trigger if exists bases_protect_product_recipes on public.bases;
create constraint trigger bases_protect_product_recipes after update on public.bases deferrable initially deferred for each row execute function public.check_base_recipe();
create or replace function public.validate_product_parent()
returns trigger language plpgsql set search_path=public as $$
declare v_product public.products%rowtype;
begin
  select * into v_product from public.products where id=new.id;
  if not found then return null; end if;
  if v_product.type='variant' then
    perform 1 from public.products where id=v_product.parent_product_id and type='menu' for share;
    if not found then raise exception 'A variant must reference a main menu product' using errcode='23514'; end if;
  end if;
  if v_product.type<>'menu' and exists(select 1 from public.products where parent_product_id=v_product.id) then
    raise exception 'A main menu product with variants must remain a menu product' using errcode='23514';
  end if;
  return null;
end;
$$;
drop trigger if exists products_validate_parent on public.products;
create constraint trigger products_validate_parent after insert or update on public.products deferrable initially deferred for each row execute function public.validate_product_parent();

create or replace function public.create_product_category(p_name text)
returns jsonb language plpgsql set search_path=public as $$
declare v_category public.categories%rowtype;
begin
  insert into public.categories(name) values(btrim(p_name))
    on conflict (lower(btrim(name))) do update set name=categories.name returning * into v_category;
  return jsonb_build_object('id',v_category.id,'name',v_category.name);
end;
$$;
create or replace function public.save_catalog_product(p_id text,p_input jsonb)
returns text language plpgsql set search_path=public as $$
declare v_id text; v_recipe uuid; v_row record;
begin
  if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Product must be an object' using errcode='22023'; end if;
  if jsonb_typeof(p_input->'ingredients') is distinct from 'array' then raise exception 'Ingredients required' using errcode='22023'; end if;
  if jsonb_array_length(p_input->'ingredients') not between 1 and 200 then raise exception 'Add 1 to 200 ingredients' using errcode='23514'; end if;
  if p_id is null then
    v_id:=coalesce(nullif(btrim(p_input->>'id'),''),gen_random_uuid()::text); v_recipe:=gen_random_uuid();
    insert into public.products(id,name,type,parent_product_id,category_id,sales_price,recipe_id)
      values(v_id,btrim(p_input->>'name'),p_input->>'type',nullif(p_input->>'parentProductId',''),nullif(p_input->>'categoryId','')::uuid,(p_input->>'salesPrice')::numeric,v_recipe);
    insert into public.recipes(id,output_product_id,yield_qty) values(v_recipe,v_id,1);
  else
    if nullif(btrim(p_input->>'id'),'') is not null and btrim(p_input->>'id')<>p_id then raise exception 'Product ID cannot change' using errcode='22023'; end if;
    select id,recipe_id into v_id,v_recipe from public.products where id=p_id for update;
    if not found then raise exception 'Product not found' using errcode='P0002'; end if;
    update public.products set name=btrim(p_input->>'name'),type=p_input->>'type',parent_product_id=nullif(p_input->>'parentProductId',''),
      category_id=nullif(p_input->>'categoryId','')::uuid,sales_price=(p_input->>'salesPrice')::numeric where id=v_id;
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
create or replace function public.delete_catalog_product(p_id text)
returns void language plpgsql set search_path=public as $$
begin
  delete from public.products where id=p_id;
  if not found then raise exception 'Product not found' using errcode='P0002'; end if;
end;
$$;
alter table public.categories enable row level security;
alter table public.products enable row level security;
revoke all on public.categories,public.products from public,anon,authenticated;
grant all on public.categories,public.products to service_role;
revoke all on function public.prepared_base_factor(text,text), public.validate_product_parent(), public.create_product_category(text), public.save_catalog_product(text,jsonb), public.delete_catalog_product(text) from public,anon,authenticated;
grant execute on function public.prepared_base_factor(text,text), public.validate_product_parent(), public.create_product_category(text), public.save_catalog_product(text,jsonb), public.delete_catalog_product(text) to service_role;
notify pgrst,'reload schema';
commit;
