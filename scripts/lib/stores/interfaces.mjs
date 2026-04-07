/**
 * @fileoverview Storage adapter interfaces for the audit-loop learning system.
 * 5 split interfaces by concern. Adapters implement subsets.
 *
 * These are documented contracts (JSDoc), not runtime-enforced abstract classes.
 * The facade checks capabilities and routes accordingly.
 */

/**
 * @typedef {Object} DebtStoreInterface
 * Persistent debt ledger + events (Phase D data).
 *
 * @property {function(string, object[]): Promise<{ok: boolean, inserted: number, updated: number}>} upsertDebtEntries
 * @property {function(string): Promise<object[]>} readDebtEntries
 * @property {function(string, string): Promise<{ok: boolean, removed: boolean}>} removeDebtEntry
 * @property {function(string, object[]): Promise<{inserted: number}>} appendDebtEvents
 * @property {function(string, string?): Promise<object[]>} readDebtEvents
 */

/**
 * @typedef {Object} RunStoreInterface
 * Per-audit-run history (Phase 3/4 learning system).
 *
 * @property {function(string, string, string): Promise<string|null>} recordRunStart
 * @property {function(string, object): Promise<void>} recordRunComplete
 * @property {function(string, object[], string, number): Promise<void>} recordFindings
 * @property {function(string, string, object): Promise<void>} recordPassStats
 * @property {function(string, string, object): Promise<void>} recordAdjudicationEvent
 * @property {function(string, object): Promise<void>} recordSuppressionEvents
 */

/**
 * @typedef {Object} LearningStateStoreInterface
 * Per-repo + global learning state (Phase 2 bandit/FP).
 *
 * @property {function(string, object): Promise<void>} syncBanditArms
 * @property {function(string): Promise<object|null>} loadBanditArms
 * @property {function(string, object): Promise<void>} syncFalsePositivePatterns
 * @property {function(string): Promise<{repoPatterns: object, globalPatterns: object}>} loadFalsePositivePatterns
 */

/**
 * @typedef {Object} GlobalStateStoreInterface
 * Codebase-agnostic audit-loop state.
 *
 * @property {function(string, string, string): Promise<void>} syncPromptRevision
 * @property {function(): Promise<object[]>} listGlobalPromptVariants
 */

/**
 * @typedef {Object} RepoStoreInterface
 * Fingerprint-based repo registry.
 *
 * @property {function(object, string): Promise<string|null>} upsertRepo
 * @property {function(string): Promise<object|null>} getRepoByFingerprint
 */

/**
 * @typedef {Object} AdapterCapabilities
 * @property {boolean} debt
 * @property {boolean} run
 * @property {boolean} learningState
 * @property {boolean} globalState
 * @property {boolean} repo
 * @property {boolean} [scopeIsolation] - true if adapter enforces per-repo data isolation
 */

/**
 * @typedef {Object} StorageAdapter
 * @property {string} name
 * @property {AdapterCapabilities} capabilities
 * @property {function(): Promise<boolean>} [init]
 * @property {DebtStoreInterface} [debt]
 * @property {RunStoreInterface} [run]
 * @property {LearningStateStoreInterface} [learningState]
 * @property {GlobalStateStoreInterface} [globalState]
 * @property {RepoStoreInterface} [repo]
 */

export const GLOBAL_REPO_ID = '00000000-0000-0000-0000-000000000000';
