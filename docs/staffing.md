# Staffing: operations, schedules and payroll

This release adds `/staffing` to Spark Intelligence and a separately deployed
staffing bot. It does not run migrations, register a webhook, or deploy anything
automatically. The existing POS bot and polling stack keep their own configuration.

## Scope

- Admin/super-admin sets up regions, connects existing stores, creates manager
  accounts under Settings, grants region access, and registers one store per group.
- Managers only see `/staffing` and their assigned regions. They can create staff,
  issue invitations, publish individual shifts, inspect evidence, correct attendance,
  and resolve coworker reports within that scope.
- Existing admin access remains global. Existing managed-account sessions are
  revalidated against the current account role/active state on protected requests.
  A role change invalidates the old role cookie and requires a new login.
- A staff identity links to one Telegram user through a private, single-use,
  24-hour invitation. Reissuing an unused invitation invalidates the old one.
- `/masuk@bot` and `/pulang@bot` work in registered groups. Confirmation -> manually
  reply with location -> reply with photo -> public result. Each attempt belongs
  to the requesting user, group and shift and expires after ten minutes.
- BOTH check-in and checkout currently require location and photo. This is the agreed group-verification flow.
- For attempts created by the Telegram workflows migration, the initial command message's Telegram timestamp is the effective attendance time, conditional on location/photo completion within ten minutes. Historical records are unchanged.
  Request time, server-received time, completion time and source remain available.
  The bot does not infer an offline device's original button-press time.
- Check-in can start two hours before a scheduled shift and before its end. There
  must be exactly one eligible assignment. Checkout uses the existing open session,
  even after midnight. Missing/ambiguous schedules require manager intervention.
- Displayed lateness rounds UP to whole minutes. Financial penalties are disabled
  unless explicitly configured in the staff payroll rule; see payroll below.
- `/jadwal` in private chat shows up to ten upcoming personal shifts. Read-only personal menus for attendance, balances, leave/cash history, final payroll, bonuses and SP are available through `/menu`. Group shift exchange is available through `/tukar`; personal request creation remains a future slice. The manager
  dashboard can now record and review leave/cash requests on behalf of staff.
- Temporary cross-store/region shifts are supported. A manager can create shifts
  only if authorized for both the staff's home store and destination store; a
  global admin coordinates cross-region assignments otherwise. Destination managers
  can monitor the shift/session without seeing the guest's full home-store roster.
- Existing store-region mappings and group-store bindings cannot be reassigned
  through this UI. Transfers need a separately reviewed history/access design.
- Coworker reports do not change attendance. Manager corrections require a reason;
  original events/evidence stay intact. A time correction resets its review state
  to pending. Finalized payroll snapshots remain immutable; later corrections need
  an explicit adjustment in an open payroll period.

## Database and activation

Use a local or staging Supabase project. Never point development at production.
First reconcile the existing schema/migration history with the deployed project.
Apply `supabase/migrations/20261107180000_staffing_attendance.sql` after the existing
schema/auth migrations. New tables use `public.staffing_*` to work with the existing
server-only Data API setup. No extra exposed schema is required. All staffing
objects revoke client grants; RPCs are executable only by `service_role`. Actor
parameters are derived from verified server sessions, never request JSON.

There is one migration source of truth in this repo. Do not replay the complete
`schema.sql` over production; the new migration is additive except for extending
the managed-account role constraint to accept `manager`.

Add these server-only variables in the development/staging environment:

```
STAFFING_TELEGRAM_BOT_USERNAME=
STAFFING_TELEGRAM_BOT_TOKEN=
STAFFING_TELEGRAM_WEBHOOK_SECRET=
```

The dashboard needs the username to issue invitations and bot token to proxy
photos. The Lambda needs all three plus the existing Supabase URL and server-only
secret. Create a NEW staffing bot, with no `@` in its configured username. Its one
webhook handles both store groups and private chats. Keep the existing POS bot's
webhook/token untouched.

Deploy the separate SAM stack using `staffing-template.yaml`, then register its
Function URL using Telegram `setWebhook`, `secret_token`, and allowed updates
`["message","callback_query"]`. Keep bot privacy mode enabled and do not grant
admin privileges unless another agreed function needs them. The UI requires a
group's negative chat ID; obtain it during controlled setup, without logging
private messages or tokens.

The outbox retries through both webhook processing and the scheduled drain. The
worker has reserved concurrency 1. Database changes and queue insertion are atomic;
update IDs deduplicate repeated deliveries. Sending to Telegram is at-least-once:
a crash after Telegram accepts a message but before recording its message ID can
produce a duplicate notification, never a duplicate attendance event. There is no
claim of exactly-once delivery across Telegram and PostgreSQL.

Photos remain on Telegram; the database stores file IDs and metadata. An authorized
photo request proxies the image through the server so the bot token never reaches
the browser. File references are not an independent evidence archive. Location and
photos do not guarantee physical presence or capture time. Retention/backup policy,
automatic geofence decisions and anti-spoofing are not claimed by this release.

## Validation

`pnpm test` includes isolated PostgreSQL integration tests using PGlite, alongside
normalization, authorization, timezone and Lambda transport tests. No production
credentials are loaded. `pnpm lint` and `pnpm build` should also pass. Build and test
with a staging/local environment; Next.js loads project `.env` files automatically.

Before production activation, test with a staging bot, a real store group and two
staff accounts: invite -> shift -> confirmation -> location -> photo -> dashboard
-> checkout -> correction/report review. Verify privacy-mode replies, concurrent
staff, mobile clients, photo proxying, region restrictions, Lambda URL authentication,
notification retry schedule and deployed Supabase grants. Those external checks are
separate from local tests. Validate the SAM template/build in the deployment account.


## Weekly timetable editor

Open `/staffing/schedule/edit` (or choose Edit/Buat jadwal from Scheduling). The left roster shows weekly hours and working days,
including assignments at other stores for the authorized roster. Drag a person
onto a day/time to create a local draft. Move cards across days, resize their top
or bottom edges, or select a card and edit exact times in the right-hand panel.
Keyboard arrows move a focused card by 30 minutes or one day. Wide view keeps parallel cards readable with horizontal scrolling; Compact view shows a weekly overview. The add button and
edit form are alternatives to drag/drop. Undo restores the previous draft state.

Choose the target hours, default shift start/duration and allowed random days.
Random fills the remaining weekly target for staff currently visible in the
roster, with at most one automatic shift starting per day (overnight continuations do not block the next night). It counts assignments
elsewhere, avoids overlaps and preserves existing cards. If capacity is insufficient,
it reports remaining hours. This is a planning convenience, not an automatic
coverage optimizer. The default target is an editable 40 calendar hours and does
not establish a pay, break or statutory-hours policy.

Nothing is published until **Commit jadwal**. A single transactional RPC validates
scope, individual overlaps across stores and week boundaries, and attendance locks;
then applies the week's additions, edits and deletions together with an audit record.
A version token prevents a stale editor from overwriting changes from another
editor. A failed commit retains the local draft. Unsaved drafts live in the current
page only; leaving/reloading prompts before discarding them.

Apply `supabase/migrations/20261107193000_staffing_weekly_schedule.sql` after the
attendance migration in local/staging before enabling the planner. Store timezones
are used for Monday/Sunday boundaries, including overnight cards. Only hours inside
the selected week count in its summary. Carry-in cards from the previous week,
assignments outside the manager's roster scope, and shifts with attendance or
verification evidence cannot be moved/deleted by this editor. There is no implicit
reassignment of historical attendance when editing a schedule.


## Operations entry points

- `/staffing`: Staff Management, Scheduling and Current Activities, scoped counts
  and an action queue. Admin configuration remains at `/staffing/settings`.
- `/staffing/staff`: searchable active/inactive roster. A staff profile contains
  committed shifts, attendance, leave/sick requests and ledger, fixed kasbon ceiling,
  disbursement/repayment ledger, manual bonus/THR, SP history and automatic payroll.
- `/staffing/schedule`: committed weekly schedule; PDF export reads the same scoped
  committed database records. Editor drafts are never exported. PDF pages repeat
  table headers and split long rosters; unsupported font characters are marked and
  staff codes remain the reference.
- `/staffing/activities`: per-store/day scheduled coverage, attendance confirmation
  or rejection, correction/evidence and pending leave/cash requests. Locations are
  the last submitted attendance evidence, with its timestamp, not live tracking.
  Host managers see a guest's coverage status, never their private reason/finances.

Apply `20261107203000_staffing_operations_payroll.sql` AFTER the attendance and
weekly schedule migrations, in local/staging. It adds finance/request tables and
service-only RPCs. Actor identity comes from the signed, revalidated server session.
Home-store scope controls financial details; destination-store scope controls
attendance. Cross-region leave affecting an unmanaged shift requires a global
admin. Client operation UUIDs deduplicate retried financial submissions. Approval,
disbursement and payroll posting also have transactional status/uniqueness guards.

## Automatic payroll

Configure a versioned rule in each staff profile before previewing payroll. Rate
fields start unset; the source PDF is an internal draft and does not establish
final policy. Choose normal/night rates, night cutoff, approved overtime multiplier,
paid-leave/sick daily rates, standard leave-day hours, optional lateness tiers and
loan installment ceiling. Rules are selected as of the first day of the period;
split periods at an effective rule change. Posted results preserve the source data.

The calculator clips confirmed actual attendance to scheduled time and separately
approved overtime, in the work-store timezone. No implicit break deduction applies;
unpaid breaks require explicit intervals. Overtime overlapping scheduled hours adds
only the premium. Crossing midnight/payroll boundaries is split, and money uses
integer rupiah with per-component rounding. Late minutes round upward; optional
frequency penalties use a single highest attained tier per chosen payroll period.
This period basis is visible in the rule form and must match the agreed policy.

Approved paid/sick leave uses the explicitly selected dates and half/full-day units.
Emergency requests require a payment choice; paid emergency leave consumes leave
balance. Paid work plus leave cannot exceed the configured standard day. Leave
balance adjustments are manual pending a final accrual/expiry policy. No automatic
SP, dismissal, absence fine or sick-document penalty runs. Bonus/THR amounts are
manual entries included automatically in their dated payroll; no THR entitlement
formula, tax or statutory contribution calculation is implemented.

Kasbon follows a MANAGER-SET FIXED CEILING PER STAFF, as requested by the user, not
PDF proposed earned wages. Approval reserves capacity; confirming actual cash
handover creates debt. Payroll deducts outstanding debt up to available net income
and the rule's installment ceiling (blank = available income; zero = defer).
Disbursements and finalized payrolls are bookkeeping, not bank transfers.

Preview is read-only. Finalization is blocked by missing rules, pending/open
attendance, overlapping sessions, leave/work conflicts, an unfinished local day,
policy changes, or overlapping posted payroll periods. Finalization recalculates
server-side and validates the source version under a staff lock; changed previews
must be refreshed. The immutable snapshot, bonus allocation and loan repayment are
one transaction. Repeating finalization returns the existing payroll without
posting deductions twice. Backdated bonuses, leave approvals and time approvals
cannot enter a finalized period. Use an explicitly dated adjustment in an open
period rather than rewriting a posted result.

Local development may use a loopback-only PGlite PostgREST fixture with synthetic
staff/rates/loans. It is intentionally isolated from production and resets when
that fixture process restarts. These sample rates are not operational defaults.

## Staff management record lists

The roster's **Create staff** button opens a dialog for name, active home store,
initial leave balance and fixed cash-advance ceiling. Empty numeric fields mean
zero; the placeholder is not an entitlement policy. Codes are generated server-side
using a sequence. `20261107220000_staffing_create_staff.sql` must follow the operations
migration. Creation, opening leave credit and the ceiling are atomic, region scoped,
and deduplicated by a client operation UUID. An explicitly initialized zero leave
balance is displayed as zero rather than an unknown balance.

Staff profiles have four main tabs: Jadwal, Absensi, Izin & sakit and Keuangan.
Attendance and leave start as tables. Row detail buttons open native dialogs for
review/evidence/corrections or approval/rejection. Managers can create leave/sick
requests from the list toolbar. Keuangan combines cash-advance requests, repayments,
bonus/THR, SP and finalized payroll in a filterable record table; creation and payroll
processing/settings open dialogs. Cash advances still require approval and actual
cash handover confirmation before creating debt for payroll deductions.

The dialogs support Escape, focus trapping and focus restoration. Historical dummy
attendance is added only to the isolated local fixture and labeled as demo shifts;
no production seed migration is included.

## Profile and activity monitoring layout

The profile disclosure is **Pengaturan Profil**. Save and the Telegram-blue invitation
button share one action row. Invitations use the existing private linking flow;
linked or inactive staff cannot issue a new invitation from this button. Local
previews without a bot configuration report the existing setup error rather than
inventing invitation links.

**Jadwal & Absensi** combines committed shifts above a bounded, independently
scrollable attendance history. Search matches shift/store/local schedule date;
review status and inclusive local date filters apply together. Headers remain
visible inside the scroll area. Old `?tab=absensi` links still open the combined tab.
The leave balance action is labeled **Penyesuaian**.

Activities separates **Kehadiran** and **Antrean Review** with clickable summary
filters, search and status filters. Presence and verification are separate columns:
a pending check-in is never displayed as manager-confirmed. Open sessions beyond
the scheduled end display **Belum checkout** rather than **Sedang bekerja**. Review
priority sorts pending attendance first, then overdue sessions and missing check-in.
Details, evidence, decisions and corrections open in dialogs. Guest employees keep
the existing destination-store review scope and home-store profile restrictions.

Attendance and pending attendance follow the selected store/day (today is evaluated
per store timezone); open leave/cash requests include all dates in that store scope.
This distinction is stated in the review queue. Changing scope hides old rows until
the matching response arrives; failed refreshes identify retained data and offer a
retry. Refresh timestamps use the selected store timezone, or explicitly WIB when
viewing multiple stores. Locations remain submitted attendance evidence, not live
tracking. No production data or bot configuration is changed by this UI update.

## Unified attendance review, replacement history and time colors

Apply `20261108003000_staffing_review_replacement.sql` after the create-staff
migration. The attendance dialog now shows actual times (pencil edit), evidence,
review status and note together, with one bottom-right save action. Save is disabled
until fields change and validation passes. Changes use one atomic RPC, an optimistic
session/shift version and a retry key. Original event timestamps stay intact. Posted
payroll attendance is read-only in this flow.

Confirming the actual times also approves time outside the published shift as
overtime. No separate overtime interval form is required. Pending/rejected sessions
remain excluded from payroll. Existing confirmed sessions keep their previous
financial interpretation until reviewed through the new flow; finalized snapshots
are never recalculated. Existing manual overtime and unpaid-break intervals remain
supported for historical data. This replaces the earlier separate approval UX.

Attendance chips show time outside the scheduled interval (Lembur), missed scheduled
time (Kurang dari jadwal), and the previous assignment owner (Menggantikan). A late
arrival followed by late checkout may show both overtime and a shortfall; these are
separate intervals rather than offsetting them silently.

In the weekly editor, select an unlocked assignment, choose **Tukar / ganti staff**,
pick the replacement, apply the draft and Commit. This moves that assignment to the
new staff member. The previous owner is stored by a database trigger and the commit
audit preserves both versions. Attendance/attempt locks, scope and overlap checks
still apply. Newly created drafts have no published previous owner.

Timetable card fills follow actual store-local time segments: 00–06 black, 06–12
yellow, 12–18 orange, 18–24 red. Cards crossing a boundary contain proportional
color segments, including overnight fragments. These display bands do not change
configured payroll night-rate boundaries.

## Central settings and shared controls

`/staffing/settings` is the canonical administration hub; `/settings` redirects to
its Store section. The left sidebar selects Region, Store, Akun pengguna, Akses
manager, Telegram or Aturan payroll. The center contains only the selected setup
workflow. Store/account editing reuses the existing endpoints and credential-safe
summary types. No tokens are sent back as settings props. Only administrators load
these summaries; regional managers are redirected before account/store setup data
is read. Personal staff configuration remains accessible from the staff profile.

The former settings dashboard's operational staff, schedule and attendance cards
are replaced by the dedicated operational pages. Coworker reports and their existing
resolution action appear in Activities' review queue, including a report-type filter.

Scheduled and actual timestamps use colored time chips matching the store-local
schedule bands. Chip labels keep the day/month/year date convention; time-only
variants are used in attendance history. Color legends are omitted. Inputs and
selects share a 44px height, filter labels align to the same baseline, and paired
form grids use shared caption/control tracks where CSS subgrid is supported.


## Telegram workflows activation

See [Telegram Staffing setup](staffing-telegram-setup.md) for the additive migration, bot commands, consent/security rules, operator setup script and staged end-to-end checks. No bot or webhook is configured automatically.
