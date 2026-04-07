/**
 * @fileoverview Cloud learning store — Supabase-backed persistence for audit outcomes,
 * pass effectiveness, false positive patterns, prompt variants, and bandit state.
 * Falls back to local-only mode if SUPABASE_AUDIT_URL is not set.
 * @module scripts/learning-store
 */

// Quiet dotenv load — keeps CLI stdout clean for JSON output from debt-resolve, etc.
import dotenv from 'dotenv';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });

let _supabase = null;
let _userId = null;
let _hasClassificationColumns = null;

/**
 * Initialize the cloud learning store.
 * @returns {Promise<boolean>} true if cloud mode active, false if local-only
 */
export async function initLearningStore() {
  if (!process.env.SUPABASE_AUDIT_URL || !process.env.SUPABASE_AUDIT_ANON_KEY) {
    process.stderr.write('  [learning] Cloud store not configured — using local mode\n');
    return false;
  }

  try {
    const { createClient } = await import('@supabase/supabase-js');
    _supabase = createClient(
      process.env.SUPABASE_AUDIT_URL,
      process.env.SUPABASE_AUDIT_ANON_KEY
    );

    // Check connection
    const { error } = await _supabase.from('audit_repos').select('id').limit(1);
    if (error) {
      process.stderr.write(`  [learning] Supabase connection failed: ${error.message}\n`);
      _supabase = null;
      return false;
    }

    process.stderr.write('  [learning] Cloud store connected\n');
    return true;
  } catch (err) {
    process.stderr.write(`  [learning] Failed to init: ${err.message}\n`);
    _supabase = null;
    return false;
  }
}

/** Check if cloud store is available. */
export function isCloudEnabled() {
  return _supabase !== null;
}

// ── Repo Management ─────────────────────────────────────────────────────────

/**
 * Upsert a repo profile to the cloud store.
 * @param {object} profile - From generateRepoProfile()
 * @param {string} repoName - Human-readable repo name
 */
export async function upsertRepo(profile, repoName) {
  if (!_supabase) return null;

  const { data, error } = await _supabase
    .from('audit_repos')
    .upsert({
      fingerprint: profile.repoFingerprint,
      name: repoName,
      stack: profile.stack,
      file_breakdown: profile.fileBreakdown,
      focus_areas: profile.focusAreas,
      last_audited_at: new Date().toISOString()
    }, { onConflict: 'fingerprint' })
    .select('id')
    .single();

  if (error) {
    process.stderr.write(`  [learning] upsertRepo failed: ${error.message}\n`);
    return null;
  }
  return data?.id;
}

// ── Audit Run Recording ─────────────────────────────────────────────────────

/**
 * Record the start of an audit run.
 * @returns {string|null} run ID
 */
export async function recordRunStart(repoId, planFile, mode) {
  if (!_supabase) return null;

  const { data, error } = await _supabase
    .from('audit_runs')
    .insert({
      repo_id: repoId,
      plan_file: planFile,
      mode,
      rounds: 0,
      total_findings: 0,
      accepted_count: 0,
      dismissed_count: 0,
      fixed_count: 0
    })
    .select('id')
    .single();

  if (error) {
    process.stderr.write(`  [learning] recordRunStart failed: ${error.message}\n`);
    return null;
  }
  return data?.id;
}

/**
 * Update a completed audit run with final stats.
 */
export async function recordRunComplete(runId, stats) {
  if (!_supabase || !runId) return;

  const { error } = await _supabase
    .from('audit_runs')
    .update({
      rounds: stats.rounds,
      total_findings: stats.totalFindings,
      accepted_count: stats.accepted,
      dismissed_count: stats.dismissed,
      fixed_count: stats.fixed,
      gemini_verdict: stats.geminiVerdict,
      total_cost_estimate: stats.costEstimate,
      total_duration_ms: stats.durationMs
    })
    .eq('id', runId);

  if (error) process.stderr.write(`  [learning] recordRunComplete failed: ${error.message}\n`);
}

// ── Finding & Adjudication Recording ────────────────────────────────────────

/**
 * Detect whether the audit_findings table has Phase B classification columns.
 * Cached after first probe — column shape doesn't change mid-run.
 */
async function detectClassificationColumns() {
  if (_hasClassificationColumns !== null) return _hasClassificationColumns;
  if (!_supabase) {
    _hasClassificationColumns = false;
    return false;
  }
  try {
    const { error } = await _supabase.from('audit_findings').select('sonar_type').limit(0);
    _hasClassificationColumns = !error;
  } catch {
    _hasClassificationColumns = false;
  }
  if (!_hasClassificationColumns) {
    process.stderr.write('  [learning] classification columns not present — run migration to enable\n');
  }
  return _hasClassificationColumns;
}

/** Test-only reset for detection cache. */
export function _resetClassificationColumnCache() { _hasClassificationColumns = null; }

/**
 * Record a batch of findings from an audit pass.
 */
export async function recordFindings(runId, findings, passName, round) {
  if (!_supabase || !runId) return;

  const hasClassification = await detectClassificationColumns();
  const rows = findings.map(f => {
    const base = {
      run_id: runId,
      finding_fingerprint: f._hash || 'unknown',
      pass_name: passName,
      severity: f.severity,
      category: f.category,
      primary_file: f._primaryFile || f.section,
      detail_snapshot: f.detail?.slice(0, 600),
      round_raised: round
    };
    if (!hasClassification) return base;
    return {
      ...base,
      sonar_type: f.classification?.sonarType ?? null,
      effort: f.classification?.effort ?? null,
      source_kind: f.classification?.sourceKind ?? null,
      source_name: f.classification?.sourceName ?? null,
    };
  });

  const { error } = await _supabase.from('audit_findings').insert(rows);
  if (error) process.stderr.write(`  [learning] recordFindings failed: ${error.message}\n`);
}

/**
 * Record pass-level stats.
 */
export async function recordPassStats(runId, passName, stats) {
  if (!_supabase || !runId) return;

  const { error } = await _supabase
    .from('audit_pass_stats')
    .insert({
      run_id: runId,
      pass_name: passName,
      findings_raised: stats.raised || 0,
      findings_accepted: stats.accepted || 0,
      findings_dismissed: stats.dismissed || 0,
      findings_compromised: stats.compromised || 0,
      input_tokens: stats.inputTokens,
      output_tokens: stats.outputTokens,
      latency_ms: stats.latencyMs,
      reasoning_effort: stats.reasoning,
      prompt_variant_id: stats.promptVariantId
    });

  if (error) process.stderr.write(`  [learning] recordPassStats failed: ${error.message}\n`);
}

/**
 * Record suppression events from R2+ post-processing.
 */
export async function recordSuppressionEvents(runId, suppressionResult) {
  if (!_supabase || !runId) return;

  const rows = [
    ...suppressionResult.suppressed.map(s => ({
      run_id: runId,
      finding_fingerprint: s.finding?._hash || 'unknown',
      matched_topic_id: s.matchedTopic,
      match_score: s.matchScore,
      action: 'suppressed',
      reason: s.reason
    })),
    ...suppressionResult.reopened.map(f => ({
      run_id: runId,
      finding_fingerprint: f._hash || 'unknown',
      matched_topic_id: f._matchedTopic,
      match_score: f._matchScore,
      action: 'reopened',
      reason: 'Scope changed'
    }))
  ];

  if (rows.length === 0) return;
  const { error } = await _supabase.from('suppression_events').insert(rows);
  if (error) process.stderr.write(`  [learning] recordSuppressionEvents failed: ${error.message}\n`);
}

// ── Debt Ledger (Phase D) ───────────────────────────────────────────────────

/**
 * Upsert debt entries to the cloud debt_entries table. Per-entry idempotent
 * via (repo_id, topic_id) UNIQUE constraint. Caller handles local persistence;
 * this writer only mirrors approved entries to the cloud.
 *
 * @param {string|null} repoId - from upsertRepo(); null skips the call
 * @param {object[]} entries - PersistedDebtEntry-shaped
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function upsertDebtEntries(repoId, entries) {
  if (!_supabase || !repoId || !Array.isArray(entries) || entries.length === 0) {
    return { ok: true };
  }
  const rows = entries.map(e => ({
    repo_id: repoId,
    topic_id: e.topicId,
    semantic_hash: e.semanticHash,
    severity: e.severity,
    category: e.category,
    section: e.section,
    detail_snapshot: e.detailSnapshot,
    affected_files: e.affectedFiles,
    affected_principles: e.affectedPrinciples,
    pass: e.pass,
    sonar_type: e.classification?.sonarType ?? null,
    effort: e.classification?.effort ?? null,
    source_kind: e.classification?.sourceKind ?? null,
    source_name: e.classification?.sourceName ?? null,
    deferred_reason: e.deferredReason,
    deferred_at: e.deferredAt,
    deferred_run: e.deferredRun,
    deferred_rationale: e.deferredRationale,
    blocked_by: e.blockedBy ?? null,
    followup_pr: e.followupPr ?? null,
    approver: e.approver ?? null,
    approved_at: e.approvedAt ?? null,
    policy_ref: e.policyRef ?? null,
    owner: e.owner ?? null,
    content_aliases: e.contentAliases || [],
    sensitive: e.sensitive ?? false,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await _supabase
    .from('debt_entries')
    .upsert(rows, { onConflict: 'repo_id,topic_id' });
  if (error) {
    process.stderr.write(`  [learning] upsertDebtEntries failed: ${error.message}\n`);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Read all debt entries for a repo from the cloud.
 * Returns PersistedDebtEntry-shaped objects (no derived fields — derive via events).
 * @param {string|null} repoId
 * @returns {Promise<object[]>}
 */
export async function readDebtEntriesCloud(repoId) {
  if (!_supabase || !repoId) return [];
  const { data, error } = await _supabase
    .from('debt_entries')
    .select('*')
    .eq('repo_id', repoId);
  if (error) {
    process.stderr.write(`  [learning] readDebtEntriesCloud failed: ${error.message}\n`);
    return [];
  }
  return (data || []).map(row => ({
    source: 'debt',
    topicId: row.topic_id,
    semanticHash: row.semantic_hash,
    severity: row.severity,
    category: row.category,
    section: row.section,
    detailSnapshot: row.detail_snapshot,
    affectedFiles: row.affected_files || [],
    affectedPrinciples: row.affected_principles || [],
    pass: row.pass,
    classification: row.sonar_type
      ? { sonarType: row.sonar_type, effort: row.effort, sourceKind: row.source_kind, sourceName: row.source_name }
      : null,
    deferredReason: row.deferred_reason,
    deferredAt: row.deferred_at,
    deferredRun: row.deferred_run,
    deferredRationale: row.deferred_rationale,
    blockedBy: row.blocked_by ?? undefined,
    followupPr: row.followup_pr ?? undefined,
    approver: row.approver ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    policyRef: row.policy_ref ?? undefined,
    owner: row.owner ?? undefined,
    contentAliases: row.content_aliases || [],
    sensitive: row.sensitive ?? false,
  }));
}

/**
 * Delete a debt entry from the cloud by topicId.
 * Idempotent — no-op when the row doesn't exist.
 */
export async function removeDebtEntryCloud(repoId, topicId) {
  if (!_supabase || !repoId) return { ok: true };
  const { error } = await _supabase
    .from('debt_entries')
    .delete()
    .eq('repo_id', repoId)
    .eq('topic_id', topicId);
  if (error) {
    process.stderr.write(`  [learning] removeDebtEntryCloud failed: ${error.message}\n`);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Append debt events to the cloud. Idempotent via the
 * (repo_id, topic_id, run_id, event) UNIQUE constraint — duplicate inserts
 * are silently dropped, which enables the offline→cloud reconciler.
 *
 * @param {string|null} repoId
 * @param {object[]} events - DebtEvent-shaped
 * @returns {Promise<{inserted: number, error?: string}>}
 */
export async function appendDebtEventsCloud(repoId, events) {
  if (!_supabase || !repoId || !Array.isArray(events) || events.length === 0) {
    return { inserted: 0 };
  }
  const rows = events.map(e => ({
    repo_id: repoId,
    topic_id: e.topicId ?? null,
    event: e.event,
    run_id: e.runId,
    ts: e.ts,
    match_count: e.matchCount ?? null,
    rationale: e.rationale ?? null,
    resolution_rationale: e.resolutionRationale ?? null,
    resolved_by: e.resolvedBy ?? null,
  }));
  // Use upsert with ignoreDuplicates to get idempotent inserts.
  const { data, error } = await _supabase
    .from('debt_events')
    .upsert(rows, {
      onConflict: 'repo_id,topic_id,run_id,event',
      ignoreDuplicates: true,
    })
    .select('id');
  if (error) {
    process.stderr.write(`  [learning] appendDebtEventsCloud failed: ${error.message}\n`);
    return { inserted: 0, error: error.message };
  }
  return { inserted: (data || []).length };
}

/**
 * Read all debt events for a repo.
 * @param {string|null} repoId
 * @returns {Promise<object[]>} DebtEvent[] (normalized camelCase)
 */
export async function readDebtEventsCloud(repoId) {
  if (!_supabase || !repoId) return [];
  const { data, error } = await _supabase
    .from('debt_events')
    .select('*')
    .eq('repo_id', repoId)
    .order('ts', { ascending: true });
  if (error) {
    process.stderr.write(`  [learning] readDebtEventsCloud failed: ${error.message}\n`);
    return [];
  }
  return (data || []).map(row => ({
    ts: row.ts,
    runId: row.run_id,
    topicId: row.topic_id ?? undefined,
    event: row.event,
    matchCount: row.match_count ?? undefined,
    rationale: row.rationale ?? undefined,
    resolutionRationale: row.resolution_rationale ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
  }));
}

// ── Adjudication Events ────────────────────────────────────────────────────

/**
 * Record adjudication events for findings after deliberation.
 * @param {string} findingId - The audit_findings row ID (or fingerprint for lookup)
 * @param {object} event - { adjudicationOutcome, remediationState, ruling, rulingRationale, round }
 */
export async function recordAdjudicationEvent(runId, findingFingerprint, event) {
  if (!_supabase || !runId) return;

  // Look up the finding ID using run_id + fingerprint + pass_name for unique resolution
  let query = _supabase
    .from('audit_findings')
    .select('id')
    .eq('run_id', runId)
    .eq('finding_fingerprint', findingFingerprint);

  // Include pass_name and round for unique identity when available
  if (event.passName) query = query.eq('pass_name', event.passName);
  if (event.round) query = query.eq('round_raised', event.round);

  const { data: finding } = await query.limit(1).single();

  if (!finding?.id) return;

  const { error } = await _supabase
    .from('finding_adjudication_events')
    .insert({
      finding_id: finding.id,
      adjudication_outcome: event.adjudicationOutcome,
      remediation_state: event.remediationState,
      ruling: event.ruling,
      ruling_rationale: event.rulingRationale,
      round: event.round
    });

  if (error) process.stderr.write(`  [learning] recordAdjudicationEvent failed: ${error.message}\n`);
}

// ── Bandit Arms Sync ───────────────────────────────────────────────────────

/**
 * Sync local bandit arm state to Supabase.
 * @param {object} arms - The bandit arms map from PromptBandit
 */
export async function syncBanditArms(arms) {
  if (!_supabase) return;

  const rows = Object.values(arms).map(arm => ({
    pass_name: arm.passName,
    variant_id: arm.variantId,
    alpha: arm.alpha,
    beta: arm.beta,
    pulls: arm.pulls,
    context_bucket: arm.contextBucket || null,
    updated_at: new Date().toISOString()
  }));

  if (rows.length === 0) return;

  const { error } = await _supabase
    .from('bandit_arms')
    .upsert(rows, { onConflict: 'pass_name,variant_id,context_bucket' });

  if (error) process.stderr.write(`  [learning] syncBanditArms failed: ${error.message}\n`);
  else process.stderr.write(`  [learning] Synced ${rows.length} bandit arms to cloud\n`);
}

/**
 * Load bandit arm state from Supabase (for seeding local state).
 * @returns {object|null} arms map keyed by passName:variantId
 */
export async function loadBanditArms() {
  if (!_supabase) return null;

  const { data, error } = await _supabase
    .from('bandit_arms')
    .select('*');

  if (error) {
    process.stderr.write(`  [learning] loadBanditArms failed: ${error.message}\n`);
    return null;
  }

  if (!data?.length) return null;

  const arms = {};
  for (const row of data) {
    const bucket = row.context_bucket || 'global';
    const key = `${row.pass_name}:${row.variant_id}:${bucket}`;
    arms[key] = {
      passName: row.pass_name,
      variantId: row.variant_id,
      alpha: Number(row.alpha),
      beta: Number(row.beta),
      pulls: row.pulls,
      contextBucket: bucket
    };
  }
  return arms;
}

// ── Prompt Variants ────────────────────────────────────────────────────────

/**
 * Upsert a prompt variant record with updated effectiveness stats.
 */
export async function upsertPromptVariant(repoId, passName, variantName, promptHash, stats) {
  if (!_supabase) return;

  const { error } = await _supabase
    .from('prompt_variants')
    .upsert({
      repo_id: repoId || null,
      pass_name: passName,
      variant_name: variantName,
      prompt_hash: promptHash,
      total_uses: stats.totalUses || 1,
      avg_acceptance_rate: stats.avgAcceptanceRate,
      avg_findings_per_use: stats.avgFindingsPerUse,
      is_active: true
    }, { onConflict: 'pass_name,variant_name' });

  if (error) process.stderr.write(`  [learning] upsertPromptVariant failed: ${error.message}\n`);
}

// ── False Positive Pattern Sync ────────────────────────────────────────────

/**
 * Sync local FP tracker patterns to Supabase.
 * @param {string|null} repoId - The repo UUID
 * @param {object} patterns - The local FP tracker patterns map
 */
export async function syncFalsePositivePatterns(repoId, patterns) {
  if (!_supabase) return;

  const rows = Object.entries(patterns).map(([key, p]) => {
    return {
      repo_id: repoId || null,
      pattern_type: 'category',
      pattern_value: key,
      dismissal_count: p.dismissed,
      last_dismissed_at: new Date().toISOString(),
      auto_suppress: (p.accepted + p.dismissed) >= 5 && p.ema < 0.15,
      suppress_threshold: 5
    };
  });

  if (rows.length === 0) return;

  const { error } = await _supabase
    .from('false_positive_patterns')
    .upsert(rows, { onConflict: 'repo_id,pattern_type,pattern_value' });

  if (error) process.stderr.write(`  [learning] syncFalsePositivePatterns failed: ${error.message}\n`);
  else process.stderr.write(`  [learning] Synced ${rows.length} FP patterns to cloud\n`);
}

// ── Experiment Sync ──────────────────────────────────────────────────────────

/**
 * Sync experiment records using deterministic experimentId as upsert key.
 * @param {object[]} experiments
 */
export async function syncExperiments(experiments) {
  if (!_supabase) return;

  const rows = experiments.map(e => ({
    experiment_id: e.experimentId,
    pass_name: e.pass,
    revision_id: e.revisionId,
    parent_revision_id: e.parentRevisionId,
    parent_ewr: e.parentEWR,
    parent_confidence: e.parentConfidence,
    parent_effective_sample_size: e.parentEffectiveSampleSize,
    rationale: e.rationale,
    status: e.status,
    final_ewr: e.finalEWR || null,
    final_confidence: e.finalConfidence || null,
    total_pulls: e.totalPulls || 0
  }));

  if (rows.length === 0) return;

  const { error } = await _supabase
    .from('prompt_experiments')
    .upsert(rows, { onConflict: 'experiment_id' });

  if (error) process.stderr.write(`  [learning] syncExperiments failed: ${error.message}\n`);
  else process.stderr.write(`  [learning] Synced ${rows.length} experiments to cloud\n`);
}

// ── Prompt Revision Sync ────────────────────────────────────────────────────

/**
 * Sync a promoted prompt revision to cloud.
 * @param {string} passName
 * @param {string} revisionId
 * @param {string} promptText
 */
export async function syncPromptRevision(passName, revisionId, promptText) {
  if (!_supabase) return;

  const { createHash } = await import('node:crypto');
  const checksum = createHash('sha256').update(promptText).digest('hex');

  const { error } = await _supabase
    .from('prompt_revisions')
    .upsert({
      pass_name: passName,
      revision_id: revisionId,
      prompt_text: promptText,
      checksum,
      promoted_at: new Date().toISOString()
    }, { onConflict: 'pass_name,revision_id' });

  if (error) process.stderr.write(`  [learning] syncPromptRevision failed: ${error.message}\n`);
}

// ── Hierarchical FP Pattern Loading ─────────────────────────────────────────

/**
 * Load FP patterns from cloud with structured dimensions.
 * @param {string} repoId
 * @returns {{ repoPatterns: object[], globalPatterns: object[] }}
 */
export async function loadFalsePositivePatterns(repoId) {
  if (!_supabase) return { repoPatterns: [], globalPatterns: [] };

  const GLOBAL_REPO_ID = '00000000-0000-0000-0000-000000000000';
  const columns = 'category, severity, principle, repo_id, file_extension, scope, dismissed, accepted, ema, auto_suppress';

  const { data: repo } = await _supabase
    .from('false_positive_patterns')
    .select(columns)
    .eq('repo_id', repoId).eq('auto_suppress', true);

  const { data: global } = await _supabase
    .from('false_positive_patterns')
    .select(columns)
    .eq('repo_id', GLOBAL_REPO_ID).eq('auto_suppress', true);

  return {
    repoPatterns: repo || [],
    globalPatterns: global || []
  };
}

// ── Querying (for Phase 4-6) ────────────────────────────────────────────────

/**
 * Get pass effectiveness stats for a repo.
 */
export async function getPassEffectiveness(repoId) {
  if (!_supabase) return [];

  // Two-step query: get run IDs for repo, then get pass stats
  const { data: runs, error: runErr } = await _supabase
    .from('audit_runs')
    .select('id')
    .eq('repo_id', repoId);

  if (runErr || !runs?.length) {
    if (runErr) process.stderr.write(`  [learning] getPassEffectiveness runs query failed: ${runErr.message}\n`);
    return [];
  }

  const runIds = runs.map(r => r.id);
  const { data, error } = await _supabase
    .from('audit_pass_stats')
    .select('pass_name, findings_raised, findings_accepted, findings_dismissed')
    .in('run_id', runIds);

  if (error) {
    process.stderr.write(`  [learning] getPassEffectiveness failed: ${error.message}\n`);
    return [];
  }
  return data || [];
}

/**
 * Get false positive patterns for a repo.
 */
export async function getFalsePositivePatterns(repoId) {
  if (!_supabase) return [];

  const { data, error } = await _supabase
    .from('false_positive_patterns')
    .select('*')
    .eq('repo_id', repoId)
    .eq('auto_suppress', true);

  if (error) {
    process.stderr.write(`  [learning] getFalsePositivePatterns failed: ${error.message}\n`);
    return [];
  }
  return data || [];
}
