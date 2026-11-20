-- READ ONLY. Run after 20261120140000_staffing_group_attendance.sql.
-- All columns must be true. This checks installed definitions and permissions;
-- complete a real Telegram check-in / checkout to verify delivery and evidence.
begin transaction read only;
with definitions as (
 select pg_get_functiondef('public.staffing_attendance_update_v13(jsonb)'::regprocedure) as attendance,
        (pg_get_functiondef('public.staffing_apply_update(jsonb)'::regprocedure)||coalesce(pg_get_functiondef(to_regprocedure('public.staffing_apply_update_v20(jsonb)')),'')) as dispatcher,
        pg_get_functiondef('public.staffing_notify_personal_result()'::regprocedure) as notification
)
select
 current_setting('transaction_read_only')='on' as read_only,
 position('v_effective+interval ''10 minutes'',v_chat)' in attendance)>0 as new_attempts_verify_in_group,
 position('coalesce(v_attempt.verification_chat_id,v_chat)is distinct from v_response_chat' in attendance)>0 as verification_destination_bound,
 position('''reply_parameters'',jsonb_build_object(''message_id'',v_attempt.request_message_id)' in attendance)>0 as group_evidence_replies_target_command,
 position('a.verification_chat_id=(p_update->>''chatId'')::bigint' in attendance)>0 as existing_private_attempts_supported,
 position('staffing_attendance_update_v13' in dispatcher)>0
  and position('Konfirmasi shift, lokasi, dan foto dikirim di grup ini.' in dispatcher)>0 as dispatcher_current,
 exists(select 1 from pg_trigger where tgrelid='public.staffing_sessions'::regclass
  and tgname='staffing_attendance_review_notification' and tgenabled<>'D'
  and tgfoid='public.staffing_notify_personal_result()'::regprocedure) as review_notification_enabled,
 position('select telegram_user_id into uid from staffing_staff where id=new.staff_id and active' in notification)>0
  and position('jsonb_build_object(''chat_id'',uid,''text'',body)' in notification)>0
  and position('staffing_groups' in notification)=0 as review_notification_private,
 (select bool_and(not has_function_privilege('anon',p.oid,'execute')
   and not has_function_privilege('authenticated',p.oid,'execute')
   and has_function_privilege('service_role',p.oid,'execute'))
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in('staffing_attendance_update_v13','staffing_apply_update','staffing_notify_personal_result')) as function_permissions_correct
from definitions;
commit;
