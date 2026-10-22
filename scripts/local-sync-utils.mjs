export const TRANSACTION_COLUMNS = "store_id,transaction_code,receipt_number,business_date,business_hour,occurred_at,subtotal,grand_total,payment_type,synced_at";
export const ITEM_COLUMNS = "store_id,transaction_code,line_number,item_code,item_name,category,quantity,returned_quantity,gross_sales";
const STORE_COLUMNS = "id,name,time_zone,utc_offset,is_default,active,created_at,updated_at";
const AUDIT_COLUMNS = "store_id,business_date,completed_at,transaction_count,item_count,started_at";
export function parseSyncOptions(args) {
  let watch = false;
  let interval = 30;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--watch") watch = true;
    else if (args[index] === "--interval") {
      interval = Number(args[++index]);
      if (!Number.isInteger(interval) || interval < 10 || interval > 3600) throw new Error("--interval must be 10–3600 seconds");
    } else throw new Error(`Unknown option: ${args[index]}. Use --watch and optionally --interval 30.`);
  }
  return { watch, interval };
}
function changedFilter(cursor, alias = "t") {
  if (!cursor) return "true";
  const parsed = new Date(cursor);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Invalid source snapshot timestamp");
  // Replay one minute to include overlapping ingestion transactions and timestamp precision.
  // The existing POS writer does not update synced_at on every upsert. Re-read today
  // and yesterday in each store's timezone to capture refunds, edits and removed lines.
  return `(${alias}.synced_at >= '${new Date(parsed.getTime() - 60000).toISOString()}'::timestamptz OR EXISTS (SELECT 1 FROM public.stores s WHERE s.id=${alias}.store_id AND ${alias}.business_date >= (transaction_timestamp() AT TIME ZONE s.time_zone)::date - 1))`;
}
function copyBlock(name, columns, select) {
  return `SELECT 'COPY pg_temp.${name} (${columns}) FROM stdin;';\nCOPY (${select}) TO STDOUT;\nSELECT chr(92) || '.';`;
}
export function sourceSnapshotSql(cursor = null) {
  const changed = changedFilter(cursor);
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout = '120s';
${copyBlock("mirror_meta", "snapshot_at", "SELECT transaction_timestamp()")}
${copyBlock("mirror_stores", STORE_COLUMNS, `SELECT ${STORE_COLUMNS} FROM public.stores ORDER BY id`)}
${copyBlock("mirror_transactions", TRANSACTION_COLUMNS, `SELECT ${TRANSACTION_COLUMNS} FROM public.pos_transactions t WHERE ${changed} ORDER BY store_id,transaction_code`)}
${copyBlock("mirror_items", ITEM_COLUMNS, `SELECT ${ITEM_COLUMNS.split(",").map((column) => `i.${column}`).join(",")} FROM public.pos_transaction_items i WHERE EXISTS (SELECT 1 FROM public.pos_transactions t WHERE t.store_id=i.store_id AND t.transaction_code=i.transaction_code AND ${changed}) ORDER BY i.store_id,i.transaction_code,i.line_number`)}
${copyBlock("mirror_audits", AUDIT_COLUMNS, `SELECT DISTINCT ON (store_id,business_date) ${AUDIT_COLUMNS} FROM public.sync_runs WHERE status='success' AND completed_at IS NOT NULL ORDER BY store_id,business_date,completed_at DESC,id DESC`)}
COMMIT;\n`;
}
export function stagingSql() {
  return `CREATE TEMP TABLE mirror_meta (snapshot_at timestamptz NOT NULL);
CREATE TEMP TABLE mirror_stores (LIKE public.stores);
CREATE TEMP TABLE mirror_transactions (LIKE public.pos_transactions);
CREATE TEMP TABLE mirror_items (LIKE public.pos_transaction_items);
CREATE TEMP TABLE mirror_audits (store_id uuid,business_date date,completed_at timestamptz,transaction_count integer,item_count integer,started_at timestamptz);\n`;
}
export function applySnapshotSql(full) {
  return `
-- Existing branch settings and default-store selection remain local.
INSERT INTO public.stores (${STORE_COLUMNS})
SELECT id,name,time_zone,utc_offset,false,active,created_at,updated_at FROM mirror_stores
ON CONFLICT (id) DO NOTHING;
${full ? "DELETE FROM public.pos_transaction_items;\nDELETE FROM public.pos_transactions;" : `DELETE FROM public.pos_transaction_items i USING mirror_transactions t WHERE i.store_id=t.store_id AND i.transaction_code=t.transaction_code;`}
INSERT INTO public.pos_transactions (${TRANSACTION_COLUMNS}) SELECT ${TRANSACTION_COLUMNS} FROM mirror_transactions
ON CONFLICT (store_id,transaction_code) DO UPDATE SET
receipt_number=excluded.receipt_number,business_date=excluded.business_date,business_hour=excluded.business_hour,
occurred_at=excluded.occurred_at,subtotal=excluded.subtotal,grand_total=excluded.grand_total,
payment_type=excluded.payment_type,synced_at=excluded.synced_at;
INSERT INTO public.pos_transaction_items (${ITEM_COLUMNS}) SELECT ${ITEM_COLUMNS} FROM mirror_items;
-- Only mirror-created audit summaries are replaced. Use the source completion time,
-- so a stalled production worker never appears fresh just because mirroring is running.
DELETE FROM public.sync_runs WHERE trigger='local-production-mirror';
INSERT INTO public.sync_runs (store_id,business_date,trigger,status,successful_cycles,failed_cycles,transaction_count,item_count,started_at,completed_at)
SELECT store_id,business_date,'local-production-mirror','success',1,0,transaction_count,item_count,started_at,completed_at FROM mirror_audits;
SELECT json_build_object('sourceTime',(SELECT snapshot_at FROM mirror_meta),
'mode','${full ? "full" : "incremental"}','transactions',(SELECT count(*) FROM mirror_transactions),
'items',(SELECT count(*) FROM mirror_items),'totalTransactions',(SELECT count(*) FROM public.pos_transactions),
'totalItems',(SELECT count(*) FROM public.pos_transaction_items));\n`;
}
