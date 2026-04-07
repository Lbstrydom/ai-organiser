/**
 * @fileoverview Supabase adapter for the audit-loop learning system.
 * Wraps the existing learning-store.mjs Supabase client code behind
 * the split-interface adapter contract.
 *
 * Phase G.1 ships this as a structural refactor — the Supabase client
 * init and method implementations are extracted from learning-store.mjs.
 * Full method migration happens incrementally as callers move to the facade.
 */

import { GLOBAL_REPO_ID } from './interfaces.mjs';

let _client = null;

async function getClient() {
  if (_client) return _client;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.SUPABASE_AUDIT_URL;
    const key = process.env.SUPABASE_AUDIT_ANON_KEY;
    if (!url || !key) return null;
    _client = createClient(url, key);
    return _client;
  } catch {
    return null;
  }
}

export const adapter = {
  name: 'supabase',
  capabilities: {
    debt: true,
    run: true,
    learningState: true,
    globalState: true,
    repo: true,
    scopeIsolation: true,
  },

  async init() {
    const client = await getClient();
    if (!client) return false;
    try {
      // Quick connectivity check
      const { error } = await client.from('audit_repos').select('id').limit(1);
      return !error;
    } catch {
      return false;
    }
  },

  debt: {
    async upsertDebtEntries(repoId, entries) {
      const client = await getClient();
      if (!client) return { ok: false, inserted: 0, updated: 0 };
      try {
        const { data, error } = await client.from('debt_entries')
          .upsert(entries.map(e => ({ ...e, repo_id: repoId })), { onConflict: 'topic_id,repo_id' });
        if (error) return { ok: false, inserted: 0, updated: 0, error: error.message };
        return { ok: true, inserted: entries.length, updated: 0 };
      } catch (err) {
        return { ok: false, inserted: 0, updated: 0, error: err.message };
      }
    },

    async readDebtEntries(repoId) {
      const client = await getClient();
      if (!client) return [];
      try {
        const { data, error } = await client.from('debt_entries')
          .select('*').eq('repo_id', repoId);
        return error ? [] : (data || []);
      } catch { return []; }
    },

    async removeDebtEntry(repoId, topicId) {
      const client = await getClient();
      if (!client) return { ok: false, removed: false };
      try {
        const { error } = await client.from('debt_entries')
          .delete().eq('repo_id', repoId).eq('topic_id', topicId);
        return { ok: !error, removed: !error };
      } catch { return { ok: false, removed: false }; }
    },

    async appendDebtEvents(repoId, events) {
      const client = await getClient();
      if (!client) return { inserted: 0 };
      try {
        const rows = events.map(e => ({ ...e, repo_id: repoId }));
        const { error } = await client.from('debt_events').insert(rows);
        return { inserted: error ? 0 : events.length };
      } catch { return { inserted: 0 }; }
    },

    async readDebtEvents(repoId, sinceTs) {
      const client = await getClient();
      if (!client) return [];
      try {
        let q = client.from('debt_events').select('*').eq('repo_id', repoId);
        if (sinceTs) q = q.gte('ts', sinceTs);
        const { data, error } = await q;
        return error ? [] : (data || []);
      } catch { return []; }
    },
  },

  run: {
    async recordRunStart(repoId, planFile, mode) {
      const client = await getClient();
      if (!client) return null;
      try {
        const { data, error } = await client.from('audit_runs')
          .insert({ repo_id: repoId, plan_file: planFile, mode, started_at: new Date().toISOString() })
          .select('id').single();
        return error ? null : data?.id;
      } catch { return null; }
    },

    async recordRunComplete(runId, stats) {
      const client = await getClient();
      if (!client) return;
      try {
        await client.from('audit_runs')
          .update({ ...stats, completed_at: new Date().toISOString() })
          .eq('id', runId);
      } catch { /* best effort */ }
    },

    async recordFindings(runId, findings, passName, round) {
      const client = await getClient();
      if (!client) return;
      try {
        const rows = findings.map(f => ({
          run_id: runId, pass_name: passName, round,
          finding_id: f.id, severity: f.severity, category: f.category,
          detail: f.detail?.slice(0, 500),
        }));
        await client.from('audit_findings').insert(rows);
      } catch { /* best effort */ }
    },

    async recordPassStats(runId, passName, stats) {
      const client = await getClient();
      if (!client) return;
      try {
        await client.from('audit_pass_stats')
          .insert({ run_id: runId, pass_name: passName, ...stats });
      } catch { /* best effort */ }
    },

    async recordAdjudicationEvent(runId, fingerprint, event) {
      const client = await getClient();
      if (!client) return;
      try {
        await client.from('finding_adjudication_events')
          .insert({ run_id: runId, fingerprint, ...event });
      } catch { /* best effort */ }
    },

    async recordSuppressionEvents(runId, result) {
      const client = await getClient();
      if (!client) return;
      try {
        await client.from('suppression_events')
          .insert({ run_id: runId, ...result });
      } catch { /* best effort */ }
    },
  },

  learningState: {
    async syncBanditArms(repoId, arms) {
      const client = await getClient();
      if (!client) return;
      try {
        await client.from('bandit_arms')
          .upsert({ repo_id: repoId, arms: JSON.stringify(arms), updated_at: new Date().toISOString() },
            { onConflict: 'repo_id' });
      } catch { /* best effort */ }
    },

    async loadBanditArms(repoId) {
      const client = await getClient();
      if (!client) return null;
      try {
        const { data, error } = await client.from('bandit_arms')
          .select('arms').eq('repo_id', repoId).single();
        if (error || !data) return null;
        return typeof data.arms === 'string' ? JSON.parse(data.arms) : data.arms;
      } catch { return null; }
    },

    async syncFalsePositivePatterns(repoId, patterns) {
      const client = await getClient();
      if (!client) return;
      try {
        await client.from('false_positive_patterns')
          .upsert({ repo_id: repoId, patterns: JSON.stringify(patterns), updated_at: new Date().toISOString() },
            { onConflict: 'repo_id' });
      } catch { /* best effort */ }
    },

    async loadFalsePositivePatterns(repoId) {
      const client = await getClient();
      if (!client) return { repoPatterns: {}, globalPatterns: {} };
      try {
        const { data: repoData } = await client.from('false_positive_patterns')
          .select('patterns').eq('repo_id', repoId).single();
        const { data: globalData } = await client.from('false_positive_patterns')
          .select('patterns').eq('repo_id', GLOBAL_REPO_ID).single();
        const repoPatterns = repoData?.patterns
          ? (typeof repoData.patterns === 'string' ? JSON.parse(repoData.patterns) : repoData.patterns)
          : {};
        const globalPatterns = globalData?.patterns
          ? (typeof globalData.patterns === 'string' ? JSON.parse(globalData.patterns) : globalData.patterns)
          : {};
        return { repoPatterns, globalPatterns };
      } catch { return { repoPatterns: {}, globalPatterns: {} }; }
    },
  },

  globalState: {
    async syncPromptRevision(passName, revisionId, text) {
      if (!passName || !revisionId) return;
      const client = await getClient();
      if (!client) return;
      try {
        await client.from('prompt_revisions')
          .upsert({ pass_name: passName, revision_id: revisionId, text, updated_at: new Date().toISOString() },
            { onConflict: 'pass_name,revision_id' });
      } catch { /* best effort */ }
    },

    async listGlobalPromptVariants() {
      const client = await getClient();
      if (!client) return [];
      try {
        const { data, error } = await client.from('prompt_variants').select('*');
        return error ? [] : (data || []);
      } catch { return []; }
    },
  },

  repo: {
    async upsertRepo(profile, repoName) {
      const client = await getClient();
      if (!client) return null;
      try {
        const fingerprint = profile?.repoFingerprint;
        if (!fingerprint) return null;
        // Check existing
        const { data: existing } = await client.from('audit_repos')
          .select('id').eq('fingerprint', fingerprint).single();
        if (existing) return existing.id;
        // Insert new
        const { data, error } = await client.from('audit_repos')
          .insert({ fingerprint, name: repoName, profile: JSON.stringify(profile) })
          .select('id').single();
        return error ? null : data?.id;
      } catch { return null; }
    },

    async getRepoByFingerprint(fingerprint) {
      const client = await getClient();
      if (!client) return null;
      try {
        const { data, error } = await client.from('audit_repos')
          .select('id, fingerprint').eq('fingerprint', fingerprint).single();
        return error ? null : data;
      } catch { return null; }
    },
  },
};
