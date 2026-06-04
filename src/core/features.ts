/**
 * Feature registry — the single source of truth (SSOT) for feature gating (FT-1/FT-4).
 *
 * Every gating site (command registration, settings tab, command picker, owned
 * surfaces, chat-mode entries, background-service init) reads the SAME `FeatureId`
 * union + the ownership maps below. Adding a feature = one `FEATURE_REGISTRY` entry +
 * one i18n label/description + tagging its register-fn / section / leaf / surface with
 * the `id`. Display copy lives ONLY in i18n (the registry holds `labelKey`/`descKey`
 * paths, never literal strings — L1 dedup).
 *
 * Pure data module: no Obsidian/runtime imports beyond the `ChatMode` type. Gating
 * logic lives in `services/featureService.ts`.
 *
 * NOTE: `teardown` (FT-12 stop-on-toggle-off) is intentionally NOT a registry field — it
 * would couple this pure data module to the plugin runtime. It lives as `teardownFeature`
 * on `AIOrganiserPlugin`, invoked by `applyFeatureFlags` on toggle-off (Cluster B), mirroring
 * how command/surface wiring lives in sibling maps (REGISTER_BY_FEATURE) rather than here.
 */

import type { ChatMode } from '../ui/chat/ChatModeHandler';
import type { AIOrganiserSettings } from './settings';
import type { WorkflowStage, FeatureBoundary } from './workflowStages';

/** The exhaustive set of gateable features. Fail-closed: an id absent here is disabled. */
export type FeatureId =
    | 'provider'
    | 'tagging'
    | 'chat'
    | 'summarize'
    | 'translate'
    | 'smart-note'
    | 'presentation'
    | 'minutes'
    | 'audio-narration'
    | 'semantic-search'
    | 'research'
    | 'web-reader'
    | 'quick-peek'
    | 'canvas'
    | 'mermaid-chat'
    | 'flashcards'
    | 'digitisation'
    | 'sketch'
    | 'kindle'
    | 'newsletter'
    | 'notebooklm'
    | 'bases'
    | 'export'
    | 'embed-scan';

export interface FeatureDef {
    id: FeatureId;
    /** i18n path into `t.features.*` — the SSOT for the toggle label (resolved by the Features UI). */
    labelKey: string;
    /** i18n path into `t.features.*` — the one-line "what it does" description. */
    descKey: string;
    /**
     * Primary workflow stage (shared taxonomy SSOT — `workflowStages.ts`). Drives the
     * feature's home for the settings projection (unless `core` wins, or `boundary`
     * floats it to Integrations). For `core` features the stage only ever feeds the
     * picker leaves they own (settings groups them under Core via the flag).
     */
    stage: WorkflowStage;
    /**
     * Declared trust/setup attributes (v1: `'external-account'` only). The presence of
     * `'external-account'` is the SOLE trigger for the settings "Integrations" float —
     * never an ad-hoc list. A local tool carries no boundary even if it relates to an
     * external product (Bases, NotebookLM). `readonly` — the registry is frozen (M6).
     */
    boundary?: readonly FeatureBoundary[];
    /** Features that must also be enabled (transitive). Acyclic — enforced by test. */
    requires: FeatureId[];
    /** Core features can't be disabled (toggle locked + "always on"). */
    core?: boolean;
    /** Default ON/OFF for the Lean default set (§5). */
    defaultOn: boolean;
    /**
     * A legacy `enable*` master switch this feature absorbs into `featureFlags` on
     * migration (FT-11). The flag then becomes the sole switch; the legacy field is
     * kept only as a back-compat read during migration.
     */
    absorbsLegacyFlag?: keyof AIOrganiserSettings;
}

/** Deep-freeze a feature definition (+ its `requires`/`boundary` arrays) so the SSOT can't be mutated. */
function freezeDef(f: FeatureDef): Readonly<FeatureDef> {
    return Object.freeze({
        ...f,
        requires: Object.freeze([...f.requires]) as FeatureId[],
        boundary: f.boundary ? (Object.freeze([...f.boundary]) as readonly FeatureBoundary[]) : undefined,
    });
}

/**
 * The registry (SSOT). Order within a cluster is the display order (heavy-use trio —
 * chat/research/presentation — sit first in their groups per §6, surfaced by the UI).
 * Deep-frozen — a static immutable source; no runtime code mutates it.
 */
export const FEATURE_REGISTRY: readonly Readonly<FeatureDef>[] = Object.freeze(([
    // ── Core (always on, locked — settings groups these under "Core" via the flag; the
    //    `stage` only feeds the picker leaves they own) ─────────────────────────────────
    { id: 'provider', labelKey: 'features.provider.label', descKey: 'features.provider.desc', stage: 'maintain', requires: [], core: true, defaultOn: true },
    { id: 'tagging', labelKey: 'features.tagging.label', descKey: 'features.tagging.desc', stage: 'refine', requires: [], core: true, defaultOn: true },
    { id: 'chat', labelKey: 'features.chat.label', descKey: 'features.chat.desc', stage: 'find', requires: [], core: true, defaultOn: true },
    // ── Capture (pull NEW content in) ─────────────────────────────────────────────────
    { id: 'research', labelKey: 'features.research.label', descKey: 'features.research.desc', stage: 'capture', requires: ['provider'], defaultOn: true },
    { id: 'web-reader', labelKey: 'features.web-reader.label', descKey: 'features.web-reader.desc', stage: 'capture', requires: ['provider'], defaultOn: false },
    // ── Create (produce a NEW artifact) ───────────────────────────────────────────────
    { id: 'summarize', labelKey: 'features.summarize.label', descKey: 'features.summarize.desc', stage: 'create', requires: ['provider'], defaultOn: true },
    { id: 'translate', labelKey: 'features.translate.label', descKey: 'features.translate.desc', stage: 'create', requires: ['provider'], defaultOn: true },
    { id: 'presentation', labelKey: 'features.presentation.label', descKey: 'features.presentation.desc', stage: 'create', requires: ['provider'], defaultOn: true },
    { id: 'minutes', labelKey: 'features.minutes.label', descKey: 'features.minutes.desc', stage: 'create', requires: ['provider'], defaultOn: true },
    { id: 'audio-narration', labelKey: 'features.audio-narration.label', descKey: 'features.audio-narration.desc', stage: 'create', requires: ['provider'], defaultOn: false },
    { id: 'canvas', labelKey: 'features.canvas.label', descKey: 'features.canvas.desc', stage: 'create', requires: ['provider'], defaultOn: false },
    { id: 'mermaid-chat', labelKey: 'features.mermaid-chat.label', descKey: 'features.mermaid-chat.desc', stage: 'create', requires: ['provider'], defaultOn: false },
    { id: 'flashcards', labelKey: 'features.flashcards.label', descKey: 'features.flashcards.desc', stage: 'create', requires: ['provider'], defaultOn: false },
    { id: 'sketch', labelKey: 'features.sketch.label', descKey: 'features.sketch.desc', stage: 'create', requires: [], defaultOn: false },
    { id: 'export', labelKey: 'features.export.label', descKey: 'features.export.desc', stage: 'create', requires: [], defaultOn: true },
    // ── Refine (mutate an EXISTING note) ──────────────────────────────────────────────
    { id: 'smart-note', labelKey: 'features.smart-note.label', descKey: 'features.smart-note.desc', stage: 'refine', requires: ['provider'], defaultOn: true },
    { id: 'digitisation', labelKey: 'features.digitisation.label', descKey: 'features.digitisation.desc', stage: 'refine', requires: ['provider'], defaultOn: false },
    // ── Find (retrieve / understand existing vault content) ───────────────────────────
    { id: 'semantic-search', labelKey: 'features.semantic-search.label', descKey: 'features.semantic-search.desc', stage: 'find', requires: ['provider'], defaultOn: true, absorbsLegacyFlag: 'enableSemanticSearch' },
    { id: 'quick-peek', labelKey: 'features.quick-peek.label', descKey: 'features.quick-peek.desc', stage: 'find', requires: ['provider'], defaultOn: false },
    // ── Maintain (vault hygiene + admin; local tools, no external account) ────────────
    { id: 'bases', labelKey: 'features.bases.label', descKey: 'features.bases.desc', stage: 'maintain', requires: [], defaultOn: false },
    { id: 'notebooklm', labelKey: 'features.notebooklm.label', descKey: 'features.notebooklm.desc', stage: 'maintain', requires: [], defaultOn: false },
    { id: 'embed-scan', labelKey: 'features.embed-scan.label', descKey: 'features.embed-scan.desc', stage: 'maintain', requires: [], defaultOn: false },
    // ── Integrations float (external-account boundary → settings "Integrations"; stage
    //    'capture' keeps them under Capture in the picker — the declared divergence) ─────
    { id: 'kindle', labelKey: 'features.kindle.label', descKey: 'features.kindle.desc', stage: 'capture', boundary: ['external-account'], requires: [], defaultOn: false },
    { id: 'newsletter', labelKey: 'features.newsletter.label', descKey: 'features.newsletter.desc', stage: 'capture', boundary: ['external-account'], requires: ['provider'], defaultOn: false, absorbsLegacyFlag: 'newsletterEnabled' },
] as FeatureDef[]).map(freezeDef));

/** O(1) lookup by id. */
export const FEATURE_BY_ID: Readonly<Record<FeatureId, FeatureDef>> = Object.freeze(
    Object.fromEntries(FEATURE_REGISTRY.map((f) => [f.id, f])) as Record<FeatureId, FeatureDef>,
);

/**
 * Settings-tab section id → owning FeatureId (FT-4, 1:1 sections only). Keys are the
 * `createCollapsibleSection`/`createSubCollapsibleSection` ids in `AIOrganiserSettingTab`.
 * Shared-host sections (translate→Interface, smart-note/presentation→AI Chat,
 * flashcards→Export) are intentionally ABSENT — those features gate via leaves/commands,
 * not section ownership (FT-9). A feature may own >1 section (provider, minutes, export).
 */
export const SECTION_FEATURE: Readonly<Partial<Record<string, FeatureId>>> = Object.freeze({
    'ai-provider': 'provider',
    'specialist-providers': 'provider',
    'tagging': 'tagging',
    'summarization': 'summarize',
    'meeting-minutes': 'minutes',
    'sub-audio': 'minutes',
    'ai-chat': 'chat',
    'sub-audio-narration': 'audio-narration',
    'sub-digitisation': 'digitisation',
    'sub-sketch': 'sketch',
    'sub-kindle': 'kindle',
    'sub-semantic-search': 'semantic-search',
    'sub-canvas': 'canvas',
    'sub-mermaid': 'mermaid-chat',
    'sub-research': 'research',
    'sub-bases': 'bases',
    'sub-notebooklm': 'notebooklm',
    'sub-newsletter': 'newsletter',
    'sub-export': 'export',
    'sub-brand': 'export',
});

/** Always-rendered, ungated child sections owned by no feature (R3-H4). */
export const INFRA_SECTIONS: readonly string[] = Object.freeze([
    'advanced',       // Configuration
    'sub-interface',  // Language & Interface
    'sub-mobile',     // Mobile
]);

/**
 * Concrete owned-surface registration id → FeatureId (FT-4). View types + the editor
 * gutter only. The editor context-menu is NOT here (Gemini-G2): `registerContextMenu`
 * stays unconditionally registered and gates each contributed item inline.
 */
export const SURFACE_FEATURE: Readonly<Partial<Record<string, FeatureId>>> = Object.freeze({
    'tag-network': 'tagging',
    'related-notes': 'semantic-search',
    'mermaid-staleness': 'mermaid-chat',
});

/**
 * Chat-mode → owning FeatureId (FT-4 / R3-H3). `note`/`vault`/`free` are core and
 * unmapped (always present); `research`/`presentation`/`highlight` are gated.
 */
export const CHATMODE_FEATURE: Readonly<Partial<Record<ChatMode, FeatureId>>> = Object.freeze({
    research: 'research',
    presentation: 'presentation',
    highlight: 'smart-note',
});
