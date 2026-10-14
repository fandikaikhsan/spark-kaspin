-- Store-scoped recipe catalog. Run after the multi-store and dashboard-auth migrations.
begin;

create table if not exists public.engineering_items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  type text not null check (type in ('raw_material', 'base', 'addon', 'menu_item', 'variant')),
  code text not null check (length(btrim(code)) between 1 and 200),
  name text not null check (length(btrim(name)) between 1 and 200),
  purchase_price numeric check (purchase_price >= 0 and purchase_price <= 1000000000000),
  purchase_quantity numeric check (purchase_quantity > 0 and purchase_quantity <= 1000000000000),
  uom text check (uom in ('g', 'kg', 'ml', 'l', 'pcs')),
  supplier text,
  yield_portions numeric check (yield_portions > 0 and yield_portions <= 1000000000000),
  category text,
  suggested_price numeric check (suggested_price > 0 and suggested_price <= 1000000000000),
  parent_id uuid,
  pos_item_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, id),
  foreign key (store_id, parent_id) references public.engineering_items(store_id, id) on delete restrict,
  check (parent_id is null or parent_id <> id),
  check (
    (type = 'raw_material' and purchase_price is not null and purchase_quantity is not null and uom is not null
      and yield_portions is null and category is null and suggested_price is null and parent_id is null and pos_item_code is null)
    or (type in ('base', 'addon') and yield_portions is not null and purchase_price is null and purchase_quantity is null
      and uom is null and supplier is null and category is null and suggested_price is null and parent_id is null and pos_item_code is null)
    or (type in ('menu_item', 'variant') and length(btrim(category)) > 0 and category is not null and suggested_price is not null
      and purchase_price is null and purchase_quantity is null and uom is null and supplier is null and yield_portions is null
      and ((type = 'variant' and parent_id is not null) or (type = 'menu_item' and parent_id is null)))
  )
);
create unique index if not exists engineering_items_store_code_idx on public.engineering_items(store_id, lower(code));
create unique index if not exists engineering_items_pos_code_idx on public.engineering_items(store_id, pos_item_code) where pos_item_code is not null;
create index if not exists engineering_items_parent_idx on public.engineering_items(store_id, parent_id);

create table if not exists public.engineering_ingredients (
  store_id uuid not null,
  recipe_id uuid not null,
  ingredient_id uuid not null,
  quantity numeric not null check (quantity > 0 and quantity <= 1000000000000),
  uom text not null check (uom in ('g', 'kg', 'ml', 'l', 'pcs', 'porsi')),
  position integer not null check (position >= 0),
  primary key (recipe_id, ingredient_id),
  foreign key (store_id, recipe_id) references public.engineering_items(store_id, id) on delete cascade,
  foreign key (store_id, ingredient_id) references public.engineering_items(store_id, id) on delete restrict,
  check (recipe_id <> ingredient_id)
);
create index if not exists engineering_ingredients_reference_idx on public.engineering_ingredients(store_id, ingredient_id);
alter table public.engineering_items enable row level security;
alter table public.engineering_ingredients enable row level security;
revoke all on public.engineering_items, public.engineering_ingredients from anon, authenticated;
grant all on public.engineering_items, public.engineering_ingredients to service_role;

create or replace view public.pos_menu_categories with (security_invoker = true) as
select distinct store_id, category from public.pos_transaction_items where btrim(category) <> '';
revoke all on public.pos_menu_categories from anon, authenticated;
grant select on public.pos_menu_categories to service_role;

-- One transaction replaces the item and its ingredient rows. Locking the store serializes
-- catalog writes, including edits/deletes of ingredients referenced by concurrent saves.
create or replace function public.save_engineering_item(p_store_id uuid, p_id uuid, p_input jsonb)
returns uuid language plpgsql set search_path = public as $$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
  v_type text := p_input->>'type';
  v_old_type text;
  v_code text;
begin
  perform 1 from public.stores where id = p_store_id for update;
  if not found then raise exception 'Store not found'; end if;
  if p_id is not null then
    select type into v_old_type from public.engineering_items where id = p_id and store_id = p_store_id;
    if not found then raise exception 'Item not found'; end if;
    if v_old_type <> v_type then raise exception 'An existing item type cannot be changed'; end if;
  end if;
  if jsonb_typeof(p_input->'ingredients') is distinct from 'array' then raise exception 'Ingredients must be an array'; end if;
  if (v_type = 'raw_material' and jsonb_array_length(p_input->'ingredients') <> 0)
    or (v_type <> 'raw_material' and jsonb_array_length(p_input->'ingredients') not between 1 and 200) then
    raise exception 'Recipes require between 1 and 200 ingredients; raw materials have none';
  end if;
  v_code := nullif(btrim(p_input->>'code'), '');
  if v_code is null and v_type = 'raw_material' then raise exception 'Material ID is required'; end if;
  v_code := coalesce(v_code, upper(v_type) || '-' || v_id::text);
  if v_type = 'variant' and not exists (
    select 1 from public.engineering_items where id = (p_input->>'parentId')::uuid
      and store_id = p_store_id and type = 'menu_item'
  ) then raise exception 'Select a main menu item from this store'; end if;

  insert into public.engineering_items (
    id, store_id, type, code, name, purchase_price, purchase_quantity, uom, supplier,
    yield_portions, category, suggested_price, parent_id, pos_item_code
  ) values (
    v_id, p_store_id, v_type, v_code, btrim(p_input->>'name'), (p_input->>'purchasePrice')::numeric,
    (p_input->>'purchaseQuantity')::numeric, p_input->>'uom', p_input->>'supplier',
    (p_input->>'yieldPortions')::numeric, p_input->>'category', (p_input->>'suggestedPrice')::numeric,
    (p_input->>'parentId')::uuid, p_input->>'posItemCode'
  ) on conflict (id) do update set
    code = excluded.code, name = excluded.name, purchase_price = excluded.purchase_price,
    purchase_quantity = excluded.purchase_quantity, uom = excluded.uom, supplier = excluded.supplier,
    yield_portions = excluded.yield_portions, category = excluded.category,
    suggested_price = excluded.suggested_price, parent_id = excluded.parent_id,
    pos_item_code = excluded.pos_item_code, updated_at = now();

  delete from public.engineering_ingredients where recipe_id = v_id and store_id = p_store_id;
  insert into public.engineering_ingredients (store_id, recipe_id, ingredient_id, quantity, uom, position)
  select p_store_id, v_id, (entry->>'itemId')::uuid, (entry->>'quantity')::numeric, entry->>'uom', (ordinality - 1)::integer
  from jsonb_array_elements(p_input->'ingredients') with ordinality as rows(entry, ordinality);

  -- Validate all affected relationships after edits, including a material's changed UOM.
  if exists (
    select 1 from public.engineering_ingredients r
    join public.engineering_items recipe on recipe.id = r.recipe_id
    join public.engineering_items ingredient on ingredient.id = r.ingredient_id
    where r.store_id = p_store_id and (
      recipe.type = 'raw_material'
      or (recipe.type in ('base', 'addon') and ingredient.type <> 'raw_material')
      or (recipe.type in ('menu_item', 'variant') and ingredient.type not in ('raw_material', 'base', 'addon'))
      or not (
        (ingredient.type in ('base', 'addon') and r.uom = 'porsi')
        or (ingredient.type = 'raw_material' and (
          (ingredient.uom in ('g', 'kg') and r.uom in ('g', 'kg'))
          or (ingredient.uom in ('ml', 'l') and r.uom in ('ml', 'l'))
          or (ingredient.uom = 'pcs' and r.uom = 'pcs')
        ))
      )
    )
  ) then raise exception 'Invalid ingredient type or incompatible unit. Check recipes using this material before changing its unit.'; end if;
  return v_id;
end;
$$;

create or replace function public.delete_engineering_item(p_store_id uuid, p_id uuid)
returns void language plpgsql set search_path = public as $$
begin
  perform 1 from public.stores where id = p_store_id for update;
  if not found then raise exception 'Store not found'; end if;
  if exists (select 1 from public.engineering_ingredients where store_id = p_store_id and ingredient_id = p_id)
    or exists (select 1 from public.engineering_items where store_id = p_store_id and parent_id = p_id) then
    raise exception 'This item is used by a recipe or variant. Remove those references before deleting it.';
  end if;
  delete from public.engineering_items where store_id = p_store_id and id = p_id;
  if not found then raise exception 'Item not found'; end if;
end;
$$;

revoke all on function public.save_engineering_item(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.delete_engineering_item(uuid, uuid) from public, anon, authenticated;
grant execute on function public.save_engineering_item(uuid, uuid, jsonb) to service_role;
grant execute on function public.delete_engineering_item(uuid, uuid) to service_role;
commit;
