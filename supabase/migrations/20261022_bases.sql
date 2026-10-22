-- Global prepared bases, with one required current recipe per base.
begin;
create table if not exists public.bases (
  id text primary key default gen_random_uuid()::text check (id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$'),
  name text not null check (length(btrim(name)) between 1 and 200),
  base_uom text not null check (base_uom in ('porsi','g','kg','ml','l','pcs')),
  recipe_id uuid not null unique,
  updated_at timestamptz not null default clock_timestamp()
);
create table if not exists public.recipes (
  id uuid primary key default gen_random_uuid(),
  output_base_id text not null unique references public.bases(id) on delete cascade,
  yield_qty numeric not null check (yield_qty >= 0.000000001 and yield_qty <= 1000000000000),
  unique (id, output_base_id)
);
create table if not exists public.recipe_ingredients (
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  line_number integer not null check (line_number between 1 and 200),
  item_id text not null references public.items(id) on delete restrict,
  quantity numeric not null check (quantity >= 0.000000001 and quantity <= 1000000000000),
  uom text not null check (length(btrim(uom)) between 1 and 80),
  primary key (recipe_id, line_number)
);
create index if not exists recipe_ingredients_item_idx on public.recipe_ingredients(item_id);
create index if not exists bases_name_idx on public.bases(lower(name), id);
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.bases'::regclass and conname = 'bases_recipe_fk') then
    alter table public.bases add constraint bases_recipe_fk foreign key (recipe_id, id)
      references public.recipes(id, output_base_id) deferrable initially deferred;
  end if;
end $$;
drop trigger if exists bases_updated_at on public.bases;
create trigger bases_updated_at before update on public.bases for each row execute function public.touch_inventory_item();

create or replace function public.base_ingredient_factor(p_item text, p_uom text)
returns numeric language plpgsql stable set search_path = public as $$
declare v_base text; v_factor numeric;
begin
  select base_uom into v_base from public.items where id = p_item;
  if not found then raise exception 'Raw material not found' using errcode = '23503'; end if;
  v_factor := public.inventory_standard_conversion(p_uom, v_base);
  if v_factor is not null then return v_factor; end if;
  select conversion into v_factor from public.units where item_id = p_item and lower(btrim(name)) = lower(btrim(p_uom));
  if not found then raise exception 'Invalid ingredient unit' using errcode = '23514'; end if;
  return v_factor;
end;
$$;
create or replace function public.validate_base_recipe(p_recipe uuid)
returns void language plpgsql set search_path = public as $$
declare v_row record; v_count integer;
begin
  if not exists (select 1 from public.recipes where id = p_recipe) then return; end if;
  select count(*) into v_count from public.recipe_ingredients where recipe_id = p_recipe;
  if v_count < 1 or v_count > 200 then raise exception 'Recipe needs 1 to 200 raw materials' using errcode = '23514'; end if;
  for v_row in select item_id, uom from public.recipe_ingredients where recipe_id = p_recipe loop
    perform public.base_ingredient_factor(v_row.item_id, v_row.uom);
  end loop;
end;
$$;
create or replace function public.check_base_recipe()
returns trigger language plpgsql set search_path = public as $$
declare v_recipe uuid;
begin
  if tg_table_name = 'recipes' then
    if tg_op <> 'INSERT' then perform public.validate_base_recipe(old.id); end if;
    if tg_op <> 'DELETE' then perform public.validate_base_recipe(new.id); end if;
  elsif tg_table_name = 'recipe_ingredients' then
    if tg_op <> 'INSERT' then perform public.validate_base_recipe(old.recipe_id); end if;
    if tg_op <> 'DELETE' then perform public.validate_base_recipe(new.recipe_id); end if;
  else
    -- Keep recipes valid when a referenced item's base unit or pack definition changes.
    if tg_table_name = 'items' then
      for v_recipe in select distinct recipe_id from public.recipe_ingredients where item_id = new.id loop
        perform public.validate_base_recipe(v_recipe);
      end loop;
    else
      for v_recipe in select distinct recipe_id from public.recipe_ingredients where item_id = old.item_id or item_id = new.item_id loop
        perform public.validate_base_recipe(v_recipe);
      end loop;
    end if;
  end if;
  return null;
end;
$$;
drop trigger if exists recipes_require_ingredients on public.recipes;
create constraint trigger recipes_require_ingredients after insert or update or delete on public.recipes
  deferrable initially deferred for each row execute function public.check_base_recipe();
drop trigger if exists ingredients_require_valid_recipe on public.recipe_ingredients;
create constraint trigger ingredients_require_valid_recipe after insert or update or delete on public.recipe_ingredients
  deferrable initially deferred for each row execute function public.check_base_recipe();
drop trigger if exists items_protect_base_recipes on public.items;
create constraint trigger items_protect_base_recipes after update on public.items
  deferrable initially deferred for each row execute function public.check_base_recipe();
drop trigger if exists units_protect_base_recipes on public.units;
create constraint trigger units_protect_base_recipes after update on public.units
  deferrable initially deferred for each row execute function public.check_base_recipe();

create or replace function public.save_prepared_base(p_id text, p_input jsonb)
returns text language plpgsql set search_path = public as $$
declare v_id text; v_recipe uuid; v_row record;
begin
  if jsonb_typeof(p_input) is distinct from 'object' then raise exception 'Base must be an object' using errcode = '22023'; end if;
  if jsonb_typeof(p_input->'ingredients') is distinct from 'array' then raise exception 'Ingredients required' using errcode = '22023'; end if;
  if jsonb_array_length(p_input->'ingredients') not between 1 and 200 then raise exception 'Add 1 to 200 ingredients' using errcode = '23514'; end if;
  if p_id is null then
    v_id := coalesce(nullif(btrim(p_input->>'id'), ''), gen_random_uuid()::text); v_recipe := gen_random_uuid();
    insert into public.bases(id, name, base_uom, recipe_id) values(v_id, btrim(p_input->>'name'), p_input->>'baseUom', v_recipe);
    insert into public.recipes(id, output_base_id, yield_qty) values(v_recipe, v_id, (p_input->>'yieldQuantity')::numeric);
  else
    if nullif(btrim(p_input->>'id'), '') is not null and btrim(p_input->>'id') <> p_id then raise exception 'Base ID cannot change' using errcode = '22023'; end if;
    select id, recipe_id into v_id, v_recipe from public.bases where id = p_id for update;
    if not found then raise exception 'Base not found' using errcode = 'P0002'; end if;
    update public.bases set name = btrim(p_input->>'name'), base_uom = p_input->>'baseUom' where id = v_id;
    update public.recipes set yield_qty = (p_input->>'yieldQuantity')::numeric where id = v_recipe;
    delete from public.recipe_ingredients where recipe_id = v_recipe;
  end if;
  for v_row in select value, ordinality from jsonb_array_elements(p_input->'ingredients') with ordinality loop
    insert into public.recipe_ingredients(recipe_id, line_number, item_id, quantity, uom)
      values(v_recipe, v_row.ordinality, v_row.value->>'itemId', (v_row.value->>'quantity')::numeric, btrim(v_row.value->>'uom'));
  end loop;
  perform public.validate_base_recipe(v_recipe);
  return v_id;
end;
$$;
create or replace function public.delete_prepared_base(p_id text)
returns void language plpgsql set search_path = public as $$
begin
  delete from public.bases where id = p_id;
  if not found then raise exception 'Base not found' using errcode = 'P0002'; end if;
end;
$$;
alter table public.bases enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
revoke all on public.bases, public.recipes, public.recipe_ingredients from public, anon, authenticated;
grant all on public.bases, public.recipes, public.recipe_ingredients to service_role;
revoke all on function public.base_ingredient_factor(text,text), public.validate_base_recipe(uuid), public.check_base_recipe(), public.save_prepared_base(text,jsonb), public.delete_prepared_base(text) from public, anon, authenticated;
grant execute on function public.base_ingredient_factor(text,text), public.validate_base_recipe(uuid), public.check_base_recipe(), public.save_prepared_base(text,jsonb), public.delete_prepared_base(text) to service_role;
notify pgrst, 'reload schema';
commit;
