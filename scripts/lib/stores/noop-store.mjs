/**
 * @fileoverview noop adapter — default when no AUDIT_STORE is configured.
 * Routes debt + learningState to local files. run + globalState unsupported.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';

// Lazy-load file-based implementations to avoid circular deps
let _debtLedger = null;
async function debtLedger() {
  if (!_debtLedger) _debtLedger = await import('../debt-ledger.mjs');
  return _debtLedger;
}

const DEBT_PATH = '.audit/tech-debt.json';
const DEBT_EVENTS_PATH = '.audit/local/debt-events.jsonl';
const BANDIT_PATH = '.audit/bandit-state.json';
const FP_PATH = '.audit/fp-tracker.json';

export const adapter = {
  name: 'noop',
  capabilities: {
    debt: true,
    run: false,
    learningState: true,
    globalState: false,
    repo: true,
    scopeIsolation: false, // noop is cwd-scoped, not per-repoId
  },

  async init() {
    return true; // noop always succeeds
  },

  debt: {
    async upsertDebtEntries(repoId, entries) {
      const dl = await debtLedger();
      if (typeof dl.batchWriteLedger === 'function') {
        return dl.batchWriteLedger(DEBT_PATH, entries);
      }
      // Fallback: manual write
      return { ok: true, inserted: 0, updated: 0 };
    },

    async readDebtEntries(repoId) {
      const dl = await debtLedger();
      if (typeof dl.readLedger === 'function') {
        const ledger = dl.readLedger(DEBT_PATH);
        return ledger?.entries || [];
      }
      if (!fs.existsSync(DEBT_PATH)) return [];
      try {
        return JSON.parse(fs.readFileSync(DEBT_PATH, 'utf-8')).entries || [];
      } catch { return []; }
    },

    async removeDebtEntry(repoId, topicId) {
      const dl = await debtLedger();
      if (typeof dl.removeEntry === 'function') {
        const result = dl.removeEntry(DEBT_PATH, topicId);
        return { ok: true, removed: !!result };
      }
      return { ok: true, removed: false };
    },

    async appendDebtEvents(repoId, events) {
      try {
        fs.mkdirSync(path.dirname(DEBT_EVENTS_PATH), { recursive: true });
        const lines = events.map(e => JSON.stringify(e)).join('\n') + '\n';
        fs.appendFileSync(DEBT_EVENTS_PATH, lines);
        return { inserted: events.length };
      } catch {
        return { inserted: 0 };
      }
    },

    async readDebtEvents(repoId, sinceTs) {
      if (!fs.existsSync(DEBT_EVENTS_PATH)) return [];
      try {
        const lines = fs.readFileSync(DEBT_EVENTS_PATH, 'utf-8')
          .split('\n').filter(Boolean);
        const events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        if (sinceTs) {
          return events.filter(e => e.ts >= sinceTs);
        }
        return events;
      } catch { return []; }
    },
  },

  learningState: {
    async syncBanditArms(repoId, arms) {
      try {
        fs.mkdirSync(path.dirname(BANDIT_PATH), { recursive: true });
        atomicWriteFileSync(BANDIT_PATH, JSON.stringify(arms, null, 2));
      } catch { /* best effort */ }
    },

    async loadBanditArms(repoId) {
      if (!fs.existsSync(BANDIT_PATH)) return null;
      try {
        return JSON.parse(fs.readFileSync(BANDIT_PATH, 'utf-8'));
      } catch { return null; }
    },

    async syncFalsePositivePatterns(repoId, patterns) {
      try {
        fs.mkdirSync(path.dirname(FP_PATH), { recursive: true });
        atomicWriteFileSync(FP_PATH, JSON.stringify(patterns, null, 2));
      } catch { /* best effort */ }
    },

    async loadFalsePositivePatterns(repoId) {
      if (!fs.existsSync(FP_PATH)) return { repoPatterns: {}, globalPatterns: {} };
      try {
        const data = JSON.parse(fs.readFileSync(FP_PATH, 'utf-8'));
        return { repoPatterns: data, globalPatterns: {} };
      } catch { return { repoPatterns: {}, globalPatterns: {} }; }
    },
  },

  repo: {
    async upsertRepo(profile, repoName) {
      // Synthesize repoId deterministically from fingerprint
      return profile?.repoFingerprint || 'local';
    },

    async getRepoByFingerprint(fingerprint) {
      return { id: fingerprint, fingerprint };
    },
  },
};
