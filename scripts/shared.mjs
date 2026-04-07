/**
 * @fileoverview Barrel re-export for shared utilities.
 * All functionality has been split into focused modules under lib/.
 * This file preserves backwards compatibility — consumers can import from
 * './shared.mjs' or directly from './lib/<module>.mjs'.
 * @module scripts/shared
 */

// ── Schemas ─────────────────────────────────────────────────────────────────
export {
  FindingSchema,
  FindingJsonSchema,
  ClassificationSchema,
  ProducerFindingSchema,
  PersistedFindingSchema,
  WiringIssueSchema,
  LedgerEntrySchema,
  AdjudicationLedgerSchema,
  PersistedDebtEntrySchema,
  HydratedDebtEntrySchema,
  DebtEntrySchema,
  DebtEventSchema,
  DebtLedgerSchema,
  DeferredReasonEnum,
  ClusterSchema,
  RefactorCandidateSchema,
  DebtReviewResultSchema,
  zodToGeminiSchema
} from './lib/schemas.mjs';

// ── File I/O ────────────────────────────────────────────────────────────────
export {
  atomicWriteFileSync,
  normalizePath,
  safeInt,
  readFileOrDie,
  isSensitiveFile,
  readFilesAsContext,
  readFilesAsAnnotatedContext,
  writeOutput,
  parseDiffFile,
  extractPlanPaths,
  classifyFiles
} from './lib/file-io.mjs';

// ── Ledger & R2+ Suppression ────────────────────────────────────────────────
export {
  generateTopicId,
  writeLedgerEntry,
  batchWriteLedger,
  populateFindingMetadata,
  jaccardSimilarity,
  suppressReRaises,
  buildRulingsBlock,
  R2_ROUND_MODIFIER,
  buildR2SystemPrompt,
  computeImpactSet
} from './lib/ledger.mjs';

// ── Code Analysis & Chunking ────────────────────────────────────────────────
export {
  estimateTokens,
  extractImportBlock,
  splitAtFunctionBoundaries,
  chunkLargeFile,
  extractExportsOnly,
  buildDependencyGraph,
  buildAuditUnits,
  REDUCE_SYSTEM_PROMPT,
  measureContextChars
} from './lib/code-analysis.mjs';

// ── Findings & Learning ─────────────────────────────────────────────────────
export {
  semanticId,
  formatFindings,
  appendOutcome,
  loadOutcomes,
  computePassEffectiveness,
  computePassEWR,
  applyLazyDecay,
  effectiveSampleSize,
  recordWithDecay,
  extractDimensions,
  buildPatternKey,
  FalsePositiveTracker,
  setRepoProfileCache,
  compactOutcomes,
  createRemediationTask,
  trackEdit,
  verifyTask,
  persistTask,
  loadTasks,
  updateTask
} from './lib/findings.mjs';

// ── Project Context & Repo Profiling ────────────────────────────────────────
export {
  generateRepoProfile,
  initAuditBrief,
  readProjectContext,
  readProjectContextForPass,
  extractPlanForPass,
  buildHistoryContext
} from './lib/context.mjs';

// ── Linter Pre-Pass (Phase C) ───────────────────────────────────────────────
export {
  runTool,
  executeTools,
  normalizeExternalFinding,
  normalizeToolResults,
  formatLintSummary,
  parseEslintOutput,
  parseRuffOutput,
  parseTscOutput,
  parseFlake8PylintOutput,
} from './lib/linter.mjs';

export { RULE_METADATA, getRuleMetadata } from './lib/rule-metadata.mjs';

// ── Debt Memory (Phase D) ───────────────────────────────────────────────────
export {
  DEFAULT_DEBT_LEDGER_PATH,
  readDebtLedger,
  writeDebtEntries,
  removeDebtEntry,
  mergeLedgers,
  findDebtByAlias,
} from './lib/debt-ledger.mjs';

export {
  DEFAULT_DEBT_EVENTS_PATH,
  appendDebtEventsLocal,
  readDebtEventsLocal,
  deriveMetricsFromEvents,
} from './lib/debt-events.mjs';

export {
  EventSource,
  selectEventSource,
  loadDebtLedger,
  appendEvents,
  persistDebtEntries,
  removeDebt,
  reconcileLocalToCloud,
} from './lib/debt-memory.mjs';

// Phase D secret scanner — more surgical than sanitizer.mjs's redactSecrets
// (which redacts any 20+ char token). Phase D version preserves context for
// debt-capture readability while still redacting known secret shapes.
export {
  SECRET_PATTERNS,
  scanForSecrets,
  redactSecrets as redactKnownSecrets,
  redactFields,
} from './lib/secret-patterns.mjs';

export {
  computeSensitivity,
  buildDebtEntry,
  suggestDeferralCandidate,
} from './lib/debt-capture.mjs';

export {
  EFFORT_WEIGHTS,
  SONAR_TYPE_WEIGHTS,
  computeLeverage,
  rankRefactorsByLeverage,
  findStaleEntries,
  oldestEntryDays,
  buildLocalClusters,
  findRecurringEntries,
  findBudgetViolations,
  countDebtByFile,
} from './lib/debt-review-helpers.mjs';

// ── Ownership (Phase D.5) ───────────────────────────────────────────────────
export {
  findCodeownersFile,
  loadCodeownersEntries,
  resolveOwner,
  resolveOwners,
} from './lib/owner-resolver.mjs';

// ── Git-history debt derivation (Phase D.8) ─────────────────────────────────
export {
  countCommitsTouchingTopic,
  findFirstDeferCommit,
  detectGitHubRepoUrl,
  buildCommitUrl,
  deriveOccurrencesFromGit,
} from './lib/debt-git-history.mjs';

// ── File Store ──────────────────────────────────────────────────────────────
export {
  MutexFileStore,
  AppendOnlyStore,
  readJsonlFile
} from './lib/file-store.mjs';

// ── Config (Learning v2) ────────────────────────────────────────────────────
export {
  GLOBAL_CONTEXT_BUCKET,
  GLOBAL_REPO_ID,
  UNKNOWN_FILE_EXT,
  PASS_NAMES,
  normalizeLanguage
} from './lib/config.mjs';

// ── RNG ─────────────────────────────────────────────────────────────────────
export { createRNG, reservoirSample } from './lib/rng.mjs';

// ── Prompt Registry ─────────────────────────────────────────────────────────
export {
  revisionId,
  saveRevision,
  loadRevision,
  getActiveRevisionId,
  getActivePrompt,
  promoteRevision,
  abandonRevision,
  bootstrapFromConstants
} from './lib/prompt-registry.mjs';

// ── Sanitizer ───────────────────────────────────────────────────────────────
export { sanitizeOutcomes, sanitizePath, redactSecrets } from './lib/sanitizer.mjs';

// ── Suppression Policy ──────────────────────────────────────────────────────
export {
  resolveSuppressionPolicy,
  formatPolicyForPrompt,
  shouldSuppressFinding
} from './lib/suppression-policy.mjs';

// ── Language Profiles (Phase A) ─────────────────────────────────────────────
export {
  getAllProfiles,
  getProfile,
  getProfileForFile,
  countFilesByLanguage,
  detectDominantLanguage,
  buildLanguageContext,
  detectPythonPackageRoots,
  pythonBoundaryScanner,
  buildFileReferenceRegex,
  ALL_SUPPORTED_EXTENSIONS,
  ALL_EXTENSIONS_PATTERN
} from './lib/language-profiles.mjs';
