#!/usr/bin/env node
// Read-only checks. No database connection, deployment, or history repair.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function migrationPlan(directory, history, staffingOnly = false) {
  const errors = [], warnings = [];
  const files = readdirSync(directory).filter(name => name.endsWith('.sql')).sort();
  const entries = files.map(file => {
    const match = /^(\d+)_(.+)\.sql$/.exec(file);
    if (!match) { errors.push(`Invalid migration filename: ${file}`); return null; }
    return { file, version: match[1], name: match[2], sha256: createHash('sha256').update(readFileSync(resolve(directory, file))).digest('hex') };
  }).filter(Boolean);
  const staff = entries.filter(entry => entry.name.startsWith('staffing_'));
  if (!staff.length) errors.push('No Staffing migrations found.');
  for (const entry of staff) if (entry.version.length !== 14) errors.push(`Staffing version must contain 14 digits: ${entry.file}`);
  if (staff[0]?.name !== 'staffing_attendance') errors.push('Staffing attendance foundation must sort before every dependent Staffing migration.');
  const versions = new Map();
  for (const entry of entries) {
    if (versions.has(entry.version)) {
      const message = `Duplicate version ${entry.version}: ${versions.get(entry.version)} and ${entry.file}. For CLI deployment reconcile source/history; do not rename applied migrations blindly.`;
      (staffingOnly && !entry.name.startsWith('staffing_') && !versions.get(entry.version).includes('_staffing_') ? warnings : errors).push(message);
    }
    versions.set(entry.version, entry.file);
  }
  const pending = [];
  if (history !== undefined) {
    if (!Array.isArray(history) || history.some(row => !row || typeof row.version !== 'string' || !/^\d+$/.test(row.version) || (row.name !== undefined && row.name !== null && typeof row.name !== 'string'))) {
      errors.push('History must be an array of {version: string, name: string|null} from supabase_migrations.schema_migrations.');
    } else {
      const remote = new Map();
      for (const row of history) {
        if (remote.has(row.version)) errors.push(`Duplicate remote history version: ${row.version}`);
        remote.set(row.version, row);
        const local = entries.find(entry => entry.version === row.version);
        if (!local) errors.push(`Applied version ${row.version} (${row.name || 'unnamed'}) is absent locally. Use the actual CI migration source before rollout.`);
        else if (row.name && row.name !== local.name) errors.push(`History name mismatch at ${row.version}: remote ${row.name}, local ${local.name}.`);
      }
      for (const entry of entries) {
        if (!entry.name.startsWith('staffing_') && !remote.has(entry.version)) {
          errors.push(`Unapplied non-Staffing migration ${entry.file}. A Staffing rollout must not replay or silently baseline POS/other migrations.`);
        }
      }
      let missingEarlier = false;
      for (const entry of staff) {
        if (remote.has(entry.version)) {
          if (missingEarlier) errors.push(`Non-contiguous Staffing history: ${entry.file} is applied after an unapplied dependency.`);
        } else { missingEarlier = true; pending.push(entry); }
      }
      const newest = [...remote.keys()].reduce((latest, version) => BigInt(version) > BigInt(latest) ? version : latest, '0');
      for (const entry of pending) if (BigInt(entry.version) < BigInt(newest)) {
        errors.push(`Pending migration ${entry.file} predates applied version ${newest}. Review the canonical CI order; do not force --include-all.`);
      }
    }
  } else if (!staffingOnly) errors.push('Remote history is required for a rollout plan. Export version/name from the existing CI project and pass --history FILE.');
  if (staffingOnly) warnings.push('Staffing-only check does not authorize production rollout or validate the deployed schema/history.');
  return { ok: errors.length === 0, scope: staffingOnly ? 'staffing-source-only' : 'full-history', errors, warnings, migrations: staff, pending: history === undefined ? null : pending,
    historyVerified: history !== undefined && errors.length === 0,
    nextStep: errors.length ? 'Resolve reported conflicts using the existing CI source. No history was changed.' : staffingOnly ? 'Verify the full history and catalog before deployment.' : 'Review the existing CI Supabase db push --dry-run output. This plan does not verify SQL definitions in the remote catalog.' };
}

export function manualMigrationPlan(directory, rawPreflight, history) {
  const source = migrationPlan(directory, undefined, true);
  const errors = [...source.errors];
  const warnings = source.warnings.filter(message => !message.startsWith('Duplicate version') && !message.startsWith('Staffing-only check'));
  warnings.push('Manual SQL Editor rollout: historical POS timestamp collisions do not select pending Staffing files. Never replay the historical POS scripts.');
  const rows = Array.isArray(rawPreflight) && rawPreflight.length === 1 ? rawPreflight[0] : rawPreflight;
  const snapshot = rows?.staffing_preflight ?? rows;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    errors.push('A read-only catalog preflight is required: pass --preflight FILE containing the staffing_preflight JSON cell or SQL Editor JSON export.');
  } else {
    if (snapshot.read_only !== 'on') errors.push('Preflight must come from the read-only catalog check.');
    const required = ['stores.id', 'stores.name', 'stores.active', 'stores.time_zone', 'app_users.id', 'app_users.username', 'app_users.role', 'app_users.active'];
    const columns = Array.isArray(snapshot.required_columns) ? snapshot.required_columns : [];
    if (required.some(name => !columns.some(column => `${column.table_name}.${column.column_name}` === name && column.ok === true))) errors.push('Required existing Spark columns/types are missing or incompatible.');
    if (snapshot.single_column_id_primary_keys?.stores !== true || snapshot.single_column_id_primary_keys?.app_users !== true) errors.push('stores and app_users must have their expected UUID id primary keys.');
    if (snapshot.incompatible_app_user_roles !== 0 || !Array.isArray(snapshot.additional_role_constraints) || snapshot.additional_role_constraints.length) errors.push('Review incompatible app_users roles or additional role constraints before rollout.');
    if (snapshot.service_can_read_dependencies?.stores !== true || snapshot.service_can_read_dependencies?.app_users !== true) errors.push('service_role must be able to read the existing stores/app_users dependencies.');
    if (snapshot.unsupported_store_time_zones !== 0 || snapshot.uuid_generator_available !== true) errors.push('Check supported store time zones and UUID generator availability.');
    if (!Array.isArray(snapshot.existing_staffing_relations) || !Array.isArray(snapshot.existing_staffing_functions)) errors.push('Catalog snapshot must include Staffing relations and functions.');
    else if (snapshot.existing_staffing_relations.length || snapshot.existing_staffing_functions.length) errors.push('Staffing objects already exist. A first-install plan cannot infer completed migrations from table presence; review actual definitions and apply only verified remaining changes.');
    if (typeof snapshot.cli_history_present !== 'boolean') errors.push('Catalog snapshot must state whether CLI history exists.');
    else if (snapshot.cli_history_present) {
      if (!Array.isArray(history)) errors.push('A CLI history table exists. Export and review it with --history FILE before mixing deployment methods.');
      else if (history.length) errors.push('Non-empty CLI history exists. Review the deployment source and baseline before a manual rollout; do not ignore or repair it automatically.');
    } else if (history !== undefined && (!Array.isArray(history) || history.length)) errors.push('Provided history conflicts with the catalog snapshot; verify the target project.');
  }
  return { ok: errors.length === 0, scope: 'manual-first-install', errors, warnings, migrations: source.migrations,
    pending: errors.length ? null : source.migrations, preflightAccepted: errors.length === 0,
    historyVerified: false, databaseAccessed: false,
    nextStep: errors.length ? 'Resolve the catalog findings. No database or history was changed.' : 'Review the target project, fresh catalog snapshot and staging results; apply only these Staffing files in order via SQL Editor, recording each successful file and hash. No production SQL was executed.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); let directory = resolve('supabase/migrations'), history, preflight, manual = false, staffingOnly = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--staffing-only') staffingOnly = true;
      else if (args[i] === '--manual') manual = true;
      else if (args[i] === '--preflight' && args[i + 1]) preflight = JSON.parse(readFileSync(args[++i], 'utf8'));
      else if (args[i] === '--history' && args[i + 1]) history = JSON.parse(readFileSync(args[++i], 'utf8'));
      else if (args[i] === '--migrations-dir' && args[i + 1]) directory = resolve(args[++i]);
      else throw new Error('Usage: node scripts/staffing-migrations.mjs [--staffing-only | --manual --preflight FILE | --history FILE] [--migrations-dir DIR]');
    }
    if ((manual && staffingOnly) || (preflight !== undefined && !manual)) throw new Error('Use --preflight with --manual, separately from --staffing-only.');
    if (staffingOnly && history !== undefined) throw new Error('Use a full-history check when providing --history; do not combine it with --staffing-only.');
    const result = manual ? manualMigrationPlan(directory, preflight, history) : migrationPlan(directory, history, staffingOnly);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch { console.error('Migration check failed. Verify arguments, migration directory, and history JSON. No database was accessed.'); process.exitCode = 1; }
}
