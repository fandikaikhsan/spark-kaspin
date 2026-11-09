begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';
set local search_path = public;

-- Never silently choose which historical group to keep.
do $$ begin
  if exists(select 1 from staffing_groups group by store_id having count(*)>1) then
    raise exception 'STAFFING_GROUP_DUPLICATE: resolve multiple groups for a store before this migration';
  end if;
end $$;
create unique index staffing_one_group_per_store on staffing_groups(store_id);

-- Serialize mapping changes with webhook handling and outgoing group messages.
-- Try-locks fail quickly instead of creating a staff-row/group-lock deadlock.
create function staffing_lock_group(p_chat bigint)returns void language plpgsql set search_path=public as $$begin
  if p_chat<0 and not pg_try_advisory_xact_lock(hashtext('staffing-group'),hashtext(p_chat::text)) then
    raise exception 'Grup sedang memproses aktivitas lain. Coba lagi setelah proses selesai.';
  end if;
end $$;
alter function staffing_apply_update(jsonb)rename to staffing_apply_update_v4;
create function staffing_apply_update(p_update jsonb)returns void language plpgsql set search_path=public as $$begin
  perform staffing_lock_group((p_update->>'chatId')::bigint);
  perform staffing_apply_update_v4(p_update);
end $$;
create function staffing_guard_group_outbox()returns trigger language plpgsql set search_path=public as $$
declare chat bigint:=(new.payload->>'chat_id')::bigint;begin
  if chat<0 then
    perform staffing_lock_group(chat);
    -- Expired requests may still be finalized after their group has changed.
    -- Keep personal notifications, but never enqueue messages to an old group.
    if not exists(select 1 from staffing_groups where chat_id=chat)then return null;end if;
  end if;
  return new;
end $$;
create trigger staffing_group_outbox_guard before insert on staffing_outbox
for each row execute function staffing_guard_group_outbox();
revoke all on function staffing_lock_group(bigint),staffing_apply_update(jsonb),staffing_guard_group_outbox()from public,anon,authenticated;
grant execute on function staffing_lock_group(bigint),staffing_apply_update(jsonb),staffing_guard_group_outbox()to service_role;

create function staffing_save_group(
  p_actor uuid,p_bootstrap boolean,p_store uuid,p_chat bigint,
  p_previous_chat bigint default null,p_note text default ''
) returns jsonb language plpgsql set search_path=public as $$
declare previous staffing_groups; selected_store stores;
begin
  perform staffing_actor_stores(p_actor,p_bootstrap);
  if not (p_bootstrap or exists(select 1 from app_users where id=p_actor and active and role='admin')) then
    raise exception 'FORBIDDEN';
  end if;
  if p_chat is null or p_chat>=0 or p_chat < -9007199254740991 then
    raise exception 'ID grup Telegram harus berupa angka negatif yang valid';
  end if;
  select * into selected_store from stores where id=p_store for update;
  if selected_store.id is null or not selected_store.active
    or not exists(select 1 from staffing_store_regions where store_id=p_store) then
    raise exception 'Pilih store aktif yang sudah terhubung ke region';
  end if;
  select * into previous from staffing_groups where store_id=p_store for update;
  perform staffing_lock_group(p_chat);
  perform staffing_lock_group(previous.chat_id);
  if p_previous_chat is null then
    if previous.chat_id is not null then raise exception 'Grup store sudah terdaftar. Gunakan Ubah grup.';end if;
    insert into staffing_groups(chat_id,store_id)values(p_chat,p_store);
  else
    if previous.chat_id is null or previous.chat_id<>p_previous_chat then
      raise exception 'Mapping grup sudah berubah. Perbarui halaman dan coba lagi.';
    end if;
    if p_chat=previous.chat_id then return jsonb_build_object('id',p_store,'chat_id',p_chat);end if;
    if p_note is null or length(trim(p_note))not between 5 and 500 then
      raise exception 'Isi alasan perubahan grup, 5 sampai 500 karakter';
    end if;
    -- Avoid stranding attendance, peer consent, or queued messages in the old group.
    if exists(select 1 from staffing_attempts where chat_id=previous.chat_id
        and state in('confirmation','location','photo') and expires_at>now())
      or exists(select 1 from staffing_shift_requests where chat_id=previous.chat_id
        and status in('pending_peer','pending_manager') and expires_at>now())
      or exists(select 1 from staffing_swap_flows where chat_id=previous.chat_id and expires_at>now())
      or exists(select 1 from staffing_outbox where delivered_at is null and payload->>'chat_id'=previous.chat_id::text) then
      raise exception 'Grup masih memiliki proses atau pesan yang belum selesai. Selesaikan sebelum mengganti grup.';
    end if;
    update staffing_groups set chat_id=p_chat where store_id=p_store;
  end if;
  insert into staffing_audit(actor,action,entity_id,details)values(
    coalesce(p_actor::text,'bootstrap-super-admin'),'group_mapping',p_store::text,
    jsonb_build_object('previous_chat_id',previous.chat_id,'chat_id',p_chat,'note',trim(p_note)));
  return jsonb_build_object('id',p_store,'chat_id',p_chat);
end $$;
revoke all on function staffing_save_group(uuid,boolean,uuid,bigint,bigint,text)from public,anon,authenticated;
grant execute on function staffing_save_group(uuid,boolean,uuid,bigint,bigint,text)to service_role;
commit;
