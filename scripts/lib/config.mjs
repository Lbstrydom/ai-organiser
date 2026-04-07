/**
 * @fileoverview Centralized, validated runtime configuration.
 * All environment variable reads and defaults live here — no scattered process.env
 * reads across modules. Import the config object you need.
 * @module scripts/lib/config
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { safeInt } from './file-io.mjs';

// ── .env Discovery (worktree-safe) ──────────────────────────────────────────

/**
 * Find .env file by walking up from CWD, then checking git main worktree root.
 * Handles git worktrees where .env only exists in the main checkout.
 * Sets DOTENV_CONFIG_PATH so `import 'dotenv/config'` picks it up.
 */
function discoverDotenv() {
  // Already found or explicitly set
  if (process.env.DOTENV_CONFIG_PATH) return;

  // Walk up from CWD
  let dir = process.cwd();
  while (dir) {
    const envPath = path.join(dir, '.env');
    if (fs.existsSync(envPath)) {
      process.env.DOTENV_CONFIG_PATH = envPath;
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Try git main worktree root (handles worktrees and branches)
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const envPath = path.join(gitRoot, '.env');
    if (fs.existsSync(envPath)) {
      process.env.DOTENV_CONFIG_PATH = envPath;
      return;
    }

    // For worktrees: check the main worktree's .env
    const gitCommonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const mainRoot = path.resolve(gitCommonDir, '..');
    const mainEnvPath = path.join(mainRoot, '.env');
    if (mainEnvPath !== envPath && fs.existsSync(mainEnvPath)) {
      process.env.DOTENV_CONFIG_PATH = mainEnvPath;
    }
  } catch { /* not a git repo — dotenv will use CWD default */ }
}

// Run discovery then load .env (uses dotenv package directly, not 'dotenv/config')
discoverDotenv();
import dotenv from 'dotenv';
dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });

// ── Validation helpers ──────────────────────────────────────────────────────

const VALID_REASONING = new Set(['low', 'medium', 'high']);

function validatedEnum(envVar, validSet, fallback) {
  const val = process.env[envVar];
  if (val && !validSet.has(val)) {
    process.stderr.write(`  [config] WARNING: Invalid ${envVar}="${val}" — using "${fallback}"\n`);
    return fallback;
  }
  return val || fallback;
}

// ── OpenAI / GPT-5.4 Audit Config ──────────────────────────────────────────

export const openaiConfig = Object.freeze({
  model: process.env.OPENAI_AUDIT_MODEL || 'gpt-5.4',
  reasoning: validatedEnum('OPENAI_AUDIT_REASONING', VALID_REASONING, 'high'),
  maxOutputTokensCap: safeInt(process.env.OPENAI_AUDIT_MAX_TOKENS, 32000),
  timeoutMsCap: safeInt(process.env.OPENAI_AUDIT_TIMEOUT_MS, 300000),
  backendSplitThreshold: safeInt(process.env.OPENAI_AUDIT_SPLIT_THRESHOLD, 12),
  mapReduceThreshold: safeInt(process.env.OPENAI_AUDIT_MAP_REDUCE_THRESHOLD, 15),
  mapReduceTokenThreshold: safeInt(process.env.OPENAI_AUDIT_MAP_REDUCE_TOKEN_THRESHOLD, 50000),
});

// ── Gemini / Final Review Config ────────────────────────────────────────────

export const geminiConfig = Object.freeze({
  model: process.env.GEMINI_REVIEW_MODEL || 'gemini-3.1-pro-preview',
  timeoutMs: safeInt(process.env.GEMINI_REVIEW_TIMEOUT_MS, 120000),
  maxOutputTokens: safeInt(process.env.GEMINI_REVIEW_MAX_TOKENS, 16000),
});

// ── Claude Opus Fallback Config ─────────────────────────────────────────────

export const claudeConfig = Object.freeze({
  finalReviewModel: process.env.CLAUDE_FINAL_REVIEW_MODEL || 'claude-opus-4-1',
});

// ── Brief Generation Config ─────────────────────────────────────────────────

export const briefConfig = Object.freeze({
  geminiModel: process.env.BRIEF_MODEL_GEMINI || 'gemini-2.5-flash',
  claudeModel: process.env.BRIEF_MODEL_CLAUDE || 'claude-haiku-4-5-20251001',
});

// ── Suppression Config ──────────────────────────────────────────────────────

export const suppressionConfig = Object.freeze({
  similarityThreshold: parseFloat(process.env.SUPPRESS_SIMILARITY_THRESHOLD || '0.35'),
});

// ── Learning System v2 Constants ────────────────────────────────────────────

/** Sentinel constants — used instead of NULL for DB uniqueness constraints. */
export const GLOBAL_CONTEXT_BUCKET = 'global';
export const GLOBAL_REPO_ID = '00000000-0000-0000-0000-000000000000';
export const UNKNOWN_FILE_EXT = 'unknown';

/** Canonical list of audit pass names. */
export const PASS_NAMES = Object.freeze(['structure', 'wiring', 'backend', 'frontend', 'sustainability']);

/** Normalized language enum for bandit context bucketing. */
export const LANGUAGES = Object.freeze(['js', 'ts', 'py', 'go', 'java', 'rust', 'mixed', 'other']);

/**
 * Normalize a language string to canonical enum value.
 * Handles common aliases (javascript -> js, typescript -> ts, etc.).
 */
export function normalizeLanguage(lang) {
  if (!lang) return 'other';
  const lower = lang.toLowerCase().trim();
  const aliases = {
    javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    typescript: 'ts', tsx: 'ts',
    python: 'py', python3: 'py',
    golang: 'go',
    'c#': 'other', csharp: 'other', cpp: 'other', c: 'other',
    ruby: 'other', php: 'other', swift: 'other', kotlin: 'other'
  };
  const normalized = aliases[lower] || lower;
  return LANGUAGES.includes(normalized) ? normalized : 'other';
}

// ── Learning System v2 Config ───────────────────────────────────────────────

export const learningConfig = Object.freeze({
  outcomeHalfLifeMs: safeInt(process.env.OUTCOME_HALF_LIFE_DAYS, 30) * 24 * 60 * 60 * 1000,
  outcomeMaxAgeMs: safeInt(process.env.OUTCOME_MAX_AGE_DAYS, 180) * 24 * 60 * 60 * 1000,
  outcomePruneEnabled: process.env.OUTCOME_PRUNE_ENABLED !== 'false',
  ucbMinPulls: safeInt(process.env.UCB_MIN_PULLS, 3),
  minBucketSamples: safeInt(process.env.MIN_BUCKET_SAMPLES, 5),
  minFpSamples: safeInt(process.env.MIN_FP_SAMPLES, 5),
  minExamplesThreshold: safeInt(process.env.MIN_EXAMPLES_THRESHOLD, 3),
});
