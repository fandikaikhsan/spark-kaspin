begin;
set local lock_timeout='5s';
set local statement_timeout='120s';
set local search_path=public;

-- Keep the existing immutable ledger; manual balance edits append signed entries.
alter table staffing_discipline drop constraint staffing_discipline_entry_kind_check;
alter table staffing_discipline add constraint staffing_discipline_entry_kind_check
 check(entry_kind in('legacy','warning','reduction','reversal','adjustment'));
alter table staffing_discipline drop constraint staffing_discipline_points_check;
alter table staffing_discipline add constraint staffing_discipline_points_check check(
 (entry_kind in('legacy','warning')and points between 1 and 4)
 or(entry_kind in('reduction','reversal')and points between -1000000 and -1)
 or(entry_kind='adjustment'and points<>0));

alter function staffing_warning_manage(uuid,boolean,text,jsonb)rename to staffing_warning_manage_v1;
create function staffing_warning_manage(p_actor uuid,p_bootstrap boolean,p_action text,p_data jsonb)
returns jsonb language plpgsql set search_path=public as $$
declare st staffing_staff;summary jsonb;actor text:=coalesce(p_actor::text,'bootstrap-super-admin');
 key_id uuid:=(p_data->>'client_id')::uuid;cache staffing_operation_keys;balance integer;target integer;delta integer;note text;v_result jsonb;
begin
 if p_action<>'adjust_points'then return staffing_warning_manage_v1(p_actor,p_bootstrap,p_action,p_data);end if;
 st:=staffing_require_staff(p_actor,p_bootstrap,(p_data->>'staff_id')::uuid);
 select * into st from staffing_staff where id=st.id for update;
 perform staffing_require_staff(p_actor,p_bootstrap,st.id);
 if key_id is null then raise exception 'Identitas perubahan wajib diisi';end if;
 insert into staffing_operation_keys(key,actor,action,data_hash)
 values(key_id,actor,'warning:adjust_points',md5((p_data-'client_id')::text))on conflict do nothing;
 if not found then
  select * into cache from staffing_operation_keys where key=key_id;
  if cache.actor<>actor or cache.action<>'warning:adjust_points' or cache.data_hash<>md5((p_data-'client_id')::text)then
   raise exception 'Permintaan sudah tercatat dengan data lain; muat ulang';
  end if;
  return cache.result;
 end if;
 summary:=staffing_points_summary(st.id);balance:=(summary->>'balance')::integer;
 if p_data->>'points_version'is distinct from summary->>'version'then raise exception 'POINTS_STALE';end if;
 -- Reject decimals rather than silently rounding a supplied JSON number.
 if coalesce(p_data->>'new_balance','')!~'^\d{1,7}$'then raise exception 'Isi total poin baru berupa bilangan bulat 0 sampai 1000000';end if;
 target:=(p_data->>'new_balance')::integer;note:=trim(p_data->>'reason');
 if target<0 or target>1000000 then raise exception 'Total poin baru harus antara 0 dan 1000000';end if;
 if target=balance then raise exception 'Total poin baru masih sama';end if;
 if length(coalesce(note,''))not between 5 and 2000 then raise exception 'Isi alasan perubahan minimal 5 karakter';end if;
 delta:=target-balance;
 insert into staffing_discipline(staff_id,points,reason,entry_kind,actor,context)
 values(st.id,delta,note,'adjustment',actor,jsonb_build_object('before',balance,'after',target));
 perform staffing_warning_log(null,st.id,actor,'points_adjusted',jsonb_build_object('points',delta,'before',balance,'after',target,'reason',note));
 v_result:=jsonb_build_object('id',null,'points',staffing_points_summary(st.id));
 update staffing_operation_keys set result=v_result where key=key_id;
 return v_result;
end $$;
revoke all on function staffing_warning_manage_v1(uuid,boolean,text,jsonb),staffing_warning_manage(uuid,boolean,text,jsonb)from public,anon,authenticated;
grant execute on function staffing_warning_manage_v1(uuid,boolean,text,jsonb),staffing_warning_manage(uuid,boolean,text,jsonb)to service_role;
commit;
