#!/usr/bin/env node
/**
 * @fileoverview Phase 7 readiness check — counts audit runs and notifies
 * when enough data has accumulated for predictive strategy implementation.
 */

import 'dotenv/config';
import { loadOutcomes } from './lib/findings.mjs';

const PHASE7_THRESHOLD = 50; // audit runs needed

async function checkReadiness() {
  const outcomes = loadOutcomes('.audit/outcomes.jsonl');

  // Count unique runs (group by timestamp proximity — within 5 min = same run)
  const runs = new Set();
  let lastTs = 0;
  let runCounter = 0;
  for (const o of outcomes) {
    if (o.timestamp - lastTs > 300000) { // 5 min gap = new run
      runCounter++;
      runs.add(runCounter);
    }
    lastTs = o.timestamp;
  }

  const runCount = runs.size;
  const progress = Math.min(100, Math.round(runCount / PHASE7_THRESHOLD * 100));

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  PHASE 7 READINESS CHECK`);
  console.log(`  Audit runs: ${runCount} / ${PHASE7_THRESHOLD}`);
  console.log(`  Progress: ${'█'.repeat(Math.floor(progress / 5))}${'░'.repeat(20 - Math.floor(progress / 5))} ${progress}%`);

  if (runCount >= PHASE7_THRESHOLD) {
    console.log(`  STATUS: ✓ READY — enough data for predictive strategy`);
    console.log(`  Action: Implement Phase 7 (ML-based pass selection)`);
  } else {
    const remaining = PHASE7_THRESHOLD - runCount;
    console.log(`  STATUS: ${remaining} more audit runs needed`);
    console.log(`  Estimated: ~${remaining} audits at current pace`);
  }
  console.log(`═══════════════════════════════════════\n`);

  // Also check cloud store if available
  if (process.env.SUPABASE_AUDIT_URL && process.env.SUPABASE_AUDIT_ANON_KEY) {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const sb = createClient(process.env.SUPABASE_AUDIT_URL, process.env.SUPABASE_AUDIT_ANON_KEY);
      const { count } = await sb.from('audit_runs').select('*', { count: 'exact', head: true });
      console.log(`  Cloud store: ${count ?? 0} runs recorded in Supabase`);

      // Per-repo breakdown
      const { data: repos } = await sb.from('audit_repos').select('name, last_audited_at');
      if (repos?.length) {
        console.log(`  Repos: ${repos.map(r => r.name).join(', ')}`);
      }
    } catch (err) {
      console.log(`  Cloud store: unavailable (${err.message})`);
    }
  }

  return { runCount, threshold: PHASE7_THRESHOLD, ready: runCount >= PHASE7_THRESHOLD };
}

checkReadiness();
