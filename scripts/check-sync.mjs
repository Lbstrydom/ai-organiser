#!/usr/bin/env node
/**
 * @fileoverview Check whether this repo is syncing audit data to the Supabase cloud store.
 * Reports: env config, connection status, repo record, audit run history, and learning state.
 *
 * Usage:  node scripts/check-sync.mjs [--json]
 */

import 'dotenv/config';
import path from 'node:path';
import { generateRepoProfile } from './lib/context.mjs';

const JSON_MODE = process.argv.includes('--json');

// ── Helpers ────────────────────────────────────────────────────────────────────

function log(msg) { if (!JSON_MODE) process.stdout.write(msg + '\n'); }

function pass(label) { log(`  [PASS] ${label}`); }
function fail(label) { log(`  [FAIL] ${label}`); }
function info(label) { log(`  [INFO] ${label}`); }

// ── Main ───────────────────────────────────────────────────────────────────────

async function checkSync() {
  const report = {
    timestamp: new Date().toISOString(),
    repoName: path.basename(path.resolve('.')),
    env: { url: false, key: false },
    connection: false,
    repo: null,
    runs: { total: 0, recent: [] },
    learning: { banditArms: 0, fpPatterns: 0 },
    verdict: 'NOT_SYNCING',
  };

  log('');
  log('═══════════════════════════════════════');
  log('  SUPABASE SYNC CHECK');
  log('═══════════════════════════════════════');
  log('');

  // 1. Check env vars
  log('  1. Environment Variables');
  report.env.url = !!process.env.SUPABASE_AUDIT_URL;
  report.env.key = !!process.env.SUPABASE_AUDIT_ANON_KEY;

  if (report.env.url) pass('SUPABASE_AUDIT_URL is set');
  else fail('SUPABASE_AUDIT_URL is not set');

  if (report.env.key) pass('SUPABASE_AUDIT_ANON_KEY is set');
  else fail('SUPABASE_AUDIT_ANON_KEY is not set');

  if (!report.env.url || !report.env.key) {
    log('');
    fail('Missing env vars — add both to your .env file');
    log('');
    report.verdict = 'NOT_CONFIGURED';
    return finish(report);
  }

  // 2. Connection
  log('');
  log('  2. Supabase Connection');
  let sb;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    sb = createClient(process.env.SUPABASE_AUDIT_URL, process.env.SUPABASE_AUDIT_ANON_KEY);
    const { error } = await sb.from('audit_repos').select('id').limit(1);
    if (error) throw new Error(error.message);
    report.connection = true;
    pass('Connected to Supabase');
  } catch (err) {
    fail(`Connection failed: ${err.message}`);
    report.verdict = 'CONNECTION_FAILED';
    return finish(report);
  }

  // 3. Repo record
  log('');
  log('  3. Repo Record');
  const profile = generateRepoProfile();
  const fingerprint = profile.repoFingerprint;
  info(`Fingerprint: ${fingerprint}`);

  const { data: repoRow } = await sb
    .from('audit_repos')
    .select('id, name, fingerprint, last_audited_at, stack')
    .eq('fingerprint', fingerprint)
    .maybeSingle();

  if (repoRow) {
    report.repo = repoRow;
    pass(`Found: "${repoRow.name}" (id: ${repoRow.id})`);
    info(`Last audited: ${repoRow.last_audited_at || 'never'}`);
    info(`Stack: ${JSON.stringify(repoRow.stack)}`);
  } else {
    fail('Repo not found in Supabase — run an audit to register it');
    report.verdict = 'NOT_REGISTERED';
    return finish(report);
  }

  // 4. Audit runs
  log('');
  log('  4. Audit Runs');
  const { count: runCount } = await sb
    .from('audit_runs')
    .select('*', { count: 'exact', head: true })
    .eq('repo_id', repoRow.id);

  report.runs.total = runCount ?? 0;
  info(`Total runs: ${report.runs.total}`);

  const { data: recentRuns } = await sb
    .from('audit_runs')
    .select('id, plan_file, mode, started_at, verdict, rounds, total_findings')
    .eq('repo_id', repoRow.id)
    .order('started_at', { ascending: false })
    .limit(5);

  if (recentRuns?.length) {
    report.runs.recent = recentRuns;
    log('');
    log('  Recent runs:');
    for (const r of recentRuns) {
      const date = r.started_at ? new Date(r.started_at).toLocaleDateString() : '?';
      const plan = r.plan_file ? path.basename(r.plan_file) : '?';
      log(`    ${date}  ${r.mode || '?'}  ${plan}  R:${r.rounds ?? '?'}  F:${r.total_findings ?? '?'}  ${r.verdict || ''}`);
    }
  } else {
    info('No audit runs recorded yet');
  }

  // 5. Learning state
  log('');
  log('  5. Learning State');

  const { count: armCount } = await sb
    .from('bandit_arms')
    .select('*', { count: 'exact', head: true })
    .eq('repo_id', repoRow.id);
  report.learning.banditArms = armCount ?? 0;

  const { count: fpCount } = await sb
    .from('false_positive_patterns')
    .select('*', { count: 'exact', head: true })
    .eq('repo_id', repoRow.id);
  report.learning.fpPatterns = fpCount ?? 0;

  info(`Bandit arms: ${report.learning.banditArms}`);
  info(`FP patterns: ${report.learning.fpPatterns}`);

  // 6. Verdict
  report.verdict = report.runs.total > 0 ? 'SYNCING' : 'CONNECTED_NO_RUNS';

  return finish(report);
}

function finish(report) {
  if (!JSON_MODE) {
    log('');
    log('═══════════════════════════════════════');
    const icon = report.verdict === 'SYNCING' ? 'SYNCING' : report.verdict;
    log(`  Verdict: ${icon}`);
    if (report.verdict === 'NOT_CONFIGURED') {
      log('  Fix: Add SUPABASE_AUDIT_URL and SUPABASE_AUDIT_ANON_KEY to .env');
    } else if (report.verdict === 'CONNECTION_FAILED') {
      log('  Fix: Check your Supabase URL and anon key');
    } else if (report.verdict === 'NOT_REGISTERED') {
      log('  Fix: Run an audit to register this repo');
    } else if (report.verdict === 'CONNECTED_NO_RUNS') {
      log('  Connected but no audit runs yet — run an audit');
    }
    log('═══════════════════════════════════════');
    log('');
  } else {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }

  const exitCode = report.verdict === 'SYNCING' ? 0 : 1;
  process.exit(exitCode);
}

checkSync().catch(err => {
  log(`\n  [ERROR] ${err.message}\n`);
  process.exit(3);
});
