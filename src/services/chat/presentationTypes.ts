/**
 * Presentation Types
 *
 * Types for the structured-IR presentation chat feature. The deck IR
 * (presentationIr/slideIr) is the source of truth; HTML is a rendered
 * projection via `irToHtml` for the preview, and PPTX via `irToPptx`.
 * (Legacy HTML generation/refine was retired 2026-06.)
 */

import { SLIDE_SELECTOR } from './presentationConstants';
import type { SlideDeckIr } from '../presentationIr/slideIr';

// ── Presentation Phase (State Machine) ──────────────────────────────────────

export type PresentationPhase =
    | 'empty'
    | 'generating'
    | 'preview-ready'
    | 'refining'
    | 'exporting'
    | 'auditing'
    | 'error';

// ── Re-export shared constants ──────────────────────────────────────────────

export { MAX_VERSIONS, LARGE_DECK_THRESHOLD, DECK_CLASSES, SLIDE_TYPES } from './presentationConstants';
import { MAX_VERSIONS, LARGE_DECK_THRESHOLD } from './presentationConstants';

export interface PresentationVersion {
    html: string;
    userPrompt: string;
    timestamp: number;
    activeSlideIndex: number;
    /** Deck IR snapshot for this version, so restoring keeps the deck IR-backed
     *  (and editable/exportable). Absent only for legacy HTML-only versions. */
    deckIr?: SlideDeckIr;
}

// ── Session Persistence ─────────────────────────────────────────────────────

export interface PresentationSession {
    schemaVersion: 1;
    html: string;
    versions: PresentationVersion[];
    conversation: PresentationMessage[];
    brandEnabled: boolean;
    createdAt: string;
    lastActiveAt: string;
}

export interface PresentationMessage {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    /** Creation-flow epoch — increments on dispose/onClear. Used to filter
     *  history into the current creation cycle so discarded refines don't
     *  bleed into the next deck-creation prompt (audit Gemini-r2-G3 +
     *  r5-G3 + r6-G1). Legacy v1-saved messages have undefined here; the
     *  handler stamps them with the current epoch on deserialisation. */
    epoch?: number;
}

// ── DOM Fix (from Haiku brand audit) ────────────────────────────────────────

export interface DomFix {
    selector: string;
    property: string;
    value: string;
    reason: string;
}

export type AuditStatus = 'passed' | 'violations' | 'unavailable' | 'failed';

export interface AuditResult {
    status: AuditStatus;
    passed: string[];
    violations: DomFix[];
}

// ── Quality ─────────────────────────────────────────────────────────────────

export type FindingSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export type QualityFindingCategory =
    | 'colour' | 'typography' | 'overflow' | 'density' | 'gestalt' | 'consistency'
    | 'spacing' | 'contrast' | 'alignment' | 'visual-balance'
    | 'structure';

export interface QualityFinding {
    slideIndex?: number;
    category?: QualityFindingCategory;
    issue: string;
    suggestion: string;
    severity: FindingSeverity;
}

export interface QualityResult {
    structureScore: number;
    auditScore: number;
    totalScore: number;
    findings: QualityFinding[];
}

// ── Reliability Classification (Phase 3) ───────────────────────────────────

/** Four-tier reliability signal for generated decks. */
export type ReliabilityTier = 'ok' | 'warning' | 'structurally-damaged' | 'unreliable';

/** Thresholds for reliability classification. */
const REJECTION_WARNING_THRESHOLD = 10;
const REJECTION_UNRELIABLE_THRESHOLD = 50;

/**
 * Classify deck reliability based on sanitizer rejections and structural integrity.
 *
 * - `ok`: 0 rejections, structure intact
 * - `warning`: 1-10 rejections, structure intact
 * - `structurally-damaged`: Missing .deck or .slide, or >10 rejections
 * - `unreliable`: DOM parse timeout or >50 rejections
 */
export function classifyReliability(options: {
    rejectionCount: number;
    hasDeckRoot: boolean;
    hasSlides: boolean;
    parseTimedOut?: boolean;
}): ReliabilityTier {
    const { rejectionCount, hasDeckRoot, hasSlides, parseTimedOut } = options;

    if (parseTimedOut || rejectionCount > REJECTION_UNRELIABLE_THRESHOLD) {
        return 'unreliable';
    }
    if (!hasDeckRoot || !hasSlides || rejectionCount > REJECTION_WARNING_THRESHOLD) {
        return 'structurally-damaged';
    }
    if (rejectionCount > 0) {
        return 'warning';
    }
    return 'ok';
}

// ── Deterministic Quality Checks (run on iframe DOM) ────────────────────────

export interface SlideInfo {
    index: number;
    headingText: string;
    textLength: number;
    hasNotes: boolean;
    type: string;
}

export function extractSlideInfo(doc: Document): SlideInfo[] {
    // Use canonical SLIDE_SELECTOR (Gemini final-gate finding 2026-04-25 —
    // unify slide discovery so quality assessment + decorator + diff all
    // see the same node set).
    const slides = doc.querySelectorAll(SLIDE_SELECTOR);
    const infos: SlideInfo[] = [];
    slides.forEach((slide, i) => {
        const heading = slide.querySelector('h1, h2');
        const notes = slide.querySelector('.speaker-notes');
        const type = slide.classList.contains('slide-title') ? 'title'
            : slide.classList.contains('slide-section') ? 'section'
            : slide.classList.contains('slide-closing') ? 'closing'
            : 'content';
        infos.push({
            index: i,
            headingText: heading?.textContent?.trim() || '',
            textLength: (slide.textContent || '').length - (notes?.textContent || '').length,
            hasNotes: !!notes && (notes.textContent || '').trim().length > 0,
            type,
        });
    });
    return infos;
}

export function runStructureChecks(slides: SlideInfo[]): QualityFinding[] {
    const findings: QualityFinding[] = [];

    if (slides.length < 3) {
        findings.push({ issue: 'Deck has fewer than 3 slides', suggestion: 'Add more content', severity: 'MEDIUM' });
    }
    // H1 SSOT fix: use shared constant instead of hardcoded 30
    if (slides.length > LARGE_DECK_THRESHOLD) {
        findings.push({ issue: `Deck has more than ${LARGE_DECK_THRESHOLD} slides`, suggestion: 'Consider condensing', severity: 'MEDIUM' });
    }

    const seenHeadings = new Set<string>();
    for (const slide of slides) {
        if (slide.type === 'content' && slide.textLength < 20) {
            findings.push({ slideIndex: slide.index, issue: `Slide ${slide.index + 1} appears empty`, suggestion: 'Add content', severity: 'HIGH' });
        }
        if (slide.type === 'content' && slide.textLength > 800) {
            findings.push({ slideIndex: slide.index, issue: `Slide ${slide.index + 1} is overloaded (${slide.textLength} chars)`, suggestion: 'Split into multiple slides', severity: 'MEDIUM' });
        }
        if (!slide.headingText && slide.type === 'content') {
            findings.push({ slideIndex: slide.index, issue: `Slide ${slide.index + 1} has no heading`, suggestion: 'Add a heading', severity: 'MEDIUM' });
        }
        if (slide.type === 'content' && !slide.hasNotes) {
            findings.push({ slideIndex: slide.index, issue: `Slide ${slide.index + 1} has no speaker notes`, suggestion: 'Add speaker notes', severity: 'LOW' });
        }
        const normalized = slide.headingText.toLowerCase();
        if (normalized && seenHeadings.has(normalized)) {
            findings.push({ slideIndex: slide.index, issue: `Duplicate heading: "${slide.headingText}"`, suggestion: 'Use unique headings', severity: 'MEDIUM' });
        }
        if (normalized) seenHeadings.add(normalized);
    }

    return findings;
}

export function computeQualityScore(structureFindings: QualityFinding[], auditViolationCount: number): QualityResult {
    const penalty: Record<FindingSeverity, number> = { HIGH: 10, MEDIUM: 5, LOW: 2 };

    let structureScore = 50;
    for (const f of structureFindings) {
        structureScore -= penalty[f.severity];
    }

    const auditScore = Math.max(0, 50 - auditViolationCount * 8);

    return {
        structureScore: Math.max(0, structureScore),
        auditScore,
        totalScore: Math.max(0, structureScore) + auditScore,
        findings: structureFindings,
    };
}

// ── Session Migration ───────────────────────────────────────────────────────

export function migratePresentationSession(data: unknown): PresentationSession | null {
    if (!data || typeof data !== 'object') return null;
    const o = data as Record<string, unknown>;
    if (o.schemaVersion !== 1) return null;
    if (typeof o.html !== 'string' || !o.html) return null;

    // H6 fix: validate all required PresentationVersion fields including userPrompt
    const rawVersions = Array.isArray(o.versions) ? o.versions : [];
    const versions: PresentationVersion[] = rawVersions
        .filter((v): v is PresentationVersion => {
            if (!v || typeof v !== 'object') return false;
            const rec = v as Record<string, unknown>;
            return typeof rec.html === 'string'
                && typeof rec.timestamp === 'number'
                && typeof rec.userPrompt === 'string'
                && typeof rec.activeSlideIndex === 'number';
        })
        .slice(0, MAX_VERSIONS);

    // Validate conversation messages — M4/M10/M7 fix: constrain role + require timestamp
    // Include 'system' to match PresentationMessage.role type (dropping system messages = data loss)
    const VALID_ROLES = new Set(['user', 'assistant', 'system']);
    const rawConv = Array.isArray(o.conversation) ? o.conversation : [];
    const conversation: PresentationMessage[] = rawConv
        .filter((m): m is PresentationMessage => {
            if (!m || typeof m !== 'object') return false;
            const msg = m as Record<string, unknown>;
            return typeof msg.role === 'string'
                && VALID_ROLES.has(msg.role)
                && typeof msg.content === 'string'
                && typeof msg.timestamp === 'number';
        });

    return {
        schemaVersion: 1,
        html: o.html,
        versions,
        conversation,
        brandEnabled: typeof o.brandEnabled === 'boolean' ? o.brandEnabled : false,
        createdAt: typeof o.createdAt === 'string' ? o.createdAt : new Date().toISOString(),
        lastActiveAt: typeof o.lastActiveAt === 'string' ? o.lastActiveAt : new Date().toISOString(),
    };
}

// ── Targeted Slide Editing (slide-authoring-editing plan) ───────────────────
//
// Plan: docs/completed/slide-authoring-editing.md +
//       docs/completed/slide-authoring-editing-backend.md

/** Speed/quality tradeoff for create-flow generation. Edit flow always uses
 *  the user's main configured model — quality over speed when committing changes. */
export type ModelTier = 'fast' | 'quality';

/** Audience tier drives the system prompt's design-language slot. */
export type AudienceTier = 'analyst' | 'executive' | 'general';

/** Editor instrumentation kinds. The DOM decorator marks these subtrees with
 *  `data-element` attributes in the iframe-projected HTML. */
export type ElementKind =
    | 'heading' | 'subheading' | 'list' | 'list-item'
    | 'image' | 'figure' | 'table' | 'callout'
    | 'col-container' | 'col' | 'stats-grid'
    | 'quote' | 'code' | 'speaker-notes';

/** Where the user pointed for a scoped edit. */
export interface SelectionScope {
    kind: 'slide' | 'element' | 'range';
    /** Slide index (0-based). For 'range', the start. */
    slideIndex: number;
    /** Range only: inclusive end. */
    slideEndIndex?: number;
    /** Element only: data-element attribute value (e.g. 'slide-3.list-0.item-2'). */
    elementPath?: string;
    /** Element only: classification of what was selected. */
    elementKind?: ElementKind;
}

/** Edit mode constrains what kind of change the LLM is allowed to make. */
export type EditMode = 'content' | 'design';

/** Optional toggles available in Content mode only. */
export interface EditFlags {
    webSearch: boolean;
    /** Vault note paths to include as grounding context. */
    references: string[];
}

// ── Three-layer source model (audit H1, H5, R3-H9) ─────────────────────────
// Layer 1 (SelectedSource): persisted user choice; Layer 2 (CreationSourceState):
// UI render state inside the panel; Layer 3 (PromptSource): content-resolved
// entries that the prompt builder emits one block per.

/** Kind of source the user can pick. v1 supports search-query web only —
 *  URL ingestion deferred per audit R3-H9. */
export type SourceKind = 'note' | 'web-search' | 'folder';

/** Layer 1: persisted user choice. Small, serialisable, no content. */
export interface SelectedSource {
    kind: SourceKind;
    /** For 'note'/'folder': vault path. For 'web-search': the search query string. */
    ref: string;
    autoDetected?: boolean;
}

/** Failure codes captured by the resolver (audit M8). Each maps to an
 *  i18n key under `slideCreateSourceFailure*`. */
export type SourceFailureCode =
    | 'note-not-found'
    | 'note-empty'
    | 'note-read-failed'
    | 'folder-not-found'
    | 'folder-empty'
    | 'web-search-failed'
    | 'web-search-no-results'
    | 'web-search-not-configured'
    | 'unsupported-kind';

/** Layer 2: UI render state per source row. Held inside the controller +
 *  surfaced via `getSnapshot()`; never persisted. */
export interface CreationSourceState {
    selected: SelectedSource;
    status: 'idle' | 'loading' | 'resolved' | 'error';
    failureCode?: SourceFailureCode;
    cappedAt?: number;
    displayLabel?: string;
}

/** Layer 3: prompt-ready content. One per resolved file (folder kinds
 *  expand to multiple PromptSource entries). 'folder' never appears here. */
export type PromptSourceKind = 'note' | 'web-search';
export interface PromptSource {
    kind: PromptSourceKind;
    ref: string;
    content: string;
    /** Provenance: which folder this file came from, if any. */
    fromFolder?: string;
}

/** Reason category when a generation request is blocked at the gate. */
export type GenerationBlockReason = 'no-usable-sources' | 'zero-selected';

/** Aggregate config for the create flow. Sources live in
 *  `CreationSourceController`, NOT here (audit Gemini-r3-G2). `brandOn`
 *  removed (audit L1 — not wired this phase). */
export interface CreationConfig {
    audience: AudienceTier;
    /** Target slide count (5/8/12 are presets; any positive integer accepted). */
    length: number;
    /** Speed/quality model dispatch — 'fast' default. */
    speedTier: ModelTier;
}
