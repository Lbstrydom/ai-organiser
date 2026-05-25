/**
 * Multi-segment minutes domain types.
 *
 * Single source of truth (R1-H3 + R1-M1). Imported by:
 *   - src/services/minutes/multiSegmentMinutes.ts   (orchestrator)
 *   - src/services/minutes/sectionRegistryController.ts
 *   - src/services/prompts/segmentConsolidationPrompts.ts
 *   - src/services/minutesService.ts                (dispatch)
 *   - src/utils/minutesUtils.ts                     (renderer)
 *   - src/utils/responseParser.ts                   (parser)
 *   - src/services/validators/minutesValidator.ts
 *   - src/ui/modals/MinutesCreationModal.ts
 *
 * Prompts own ONLY their prompt-string builders. All shape definitions live here.
 */

import type {
    Action,
    Decision,
    Risk,
    NotablePoint,
    OpenQuestion,
    DeferredItem,
    MinutesJSON,
    MeetingMetadata,
} from '../prompts/minutesPrompts';
import type { LabelledTimedTranscript } from '../transcriptTypes';

// ============================================================================
// Source-role + transcript model (D4, R1-H2, R1-M5)
// ============================================================================

export type MeetingSourceRole = 'transcript' | 'context-document' | 'audio';

export interface TranscriptItem {
    /** crypto.randomUUID() */
    id: string;
    /** Origin of the content */
    sourceType: 'pasted' | 'vault-file' | 'transcribed-audio';
    /** Vault path for sourceType='vault-file' or 'transcribed-audio' */
    filePath?: string;
    /** User-visible label (filename for vault files, "Pasted" for typed) */
    displayName: string;
    /** Post-frontmatter-strip body */
    content: string;
    /** FK to SectionRegistry; defaults to 'general' */
    sectionId: string;
    /** Stable ordering within a section (monotonic counter at insertion) */
    orderIndex: number;
    /** For transcribed-audio, links back to AudioAttachItem.id */
    audioItemId?: string;
}

// ============================================================================
// Speaker provenance (D6, R1-H4)
// ============================================================================

export interface SpeakerKey {
    /** Stable per AudioAttachItem */
    audioItemId: string;
    /** Provider-emitted speaker label, e.g. Deepgram "Speaker 0" */
    providerSpeakerId: string;
    /** Section the audio file is assigned to */
    sectionId: string;
}

export interface SpeakerMappingV2 {
    /** Key format: `${audioItemId}|${providerSpeakerId}` → reviewed display name */
    entries: Map<string, string>;
}

export interface LabelledTranscriptBundle {
    /** Multiple labelled transcripts possible per section (one per audio file in that section) */
    bySectionId: Map<string, LabelledTimedTranscript[]>;
}

/**
 * Backwards-compat adapter — collapses a bundle with only `general` entry
 * back to a flat Map<string, string> for callers that still expect the
 * single-audio shape.
 */
export function toLegacySpeakerMapping(mapping: SpeakerMappingV2): Map<string, string> {
    const out = new Map<string, string>();
    for (const [key, name] of mapping.entries) {
        // Legacy key format was just providerSpeakerId; strip the `${audioItemId}|` prefix
        const providerSpeakerId = key.includes('|') ? key.split('|', 2)[1] : key;
        out.set(providerSpeakerId, name);
    }
    return out;
}

// ============================================================================
// Multi-segment input/output contracts (D5, R3-H4, Gemini-G2)
// ============================================================================

export interface SegmentInput {
    /** 'general' (always present) or 'topic-<uuid>' */
    sectionId: string;
    /** User-visible display name (resolved via SectionRegistryController) */
    sectionName: string;
    /** Deterministic concat of TranscriptItems for this section */
    transcript: string;
    /** Concatenated context-doc extracted text for this section */
    contextDocuments: string;
    /** Breakout-only attendees (UI deferred; default empty) */
    participantsAdditions?: string[];
    /** Per-audio labelled transcripts for this section */
    labelledTranscripts?: LabelledTimedTranscript[];
    /** Speaker mapping entries scoped to this section's audio */
    speakerMappingSubset?: SpeakerMappingV2;
}

export interface MultiSegmentInput {
    metadata: MeetingMetadata;
    /** Shared across all segments */
    participantsRaw: string;
    /** Ordered; index 0 is always sectionId='general' */
    segments: SegmentInput[];
    /** Shared */
    dictionaryContent?: string;
    /** Shared */
    styleReference?: string;
    /** Shared */
    customInstructions?: string;
    /** Shared — meeting output language */
    languageOverride?: string;
    /**
     * BCP-47 language code for speaker attribution strategy dispatch
     * (Gemini-G2 fix). Mapped from state.transcriptionLanguage in modal.
     */
    transcriptLanguageCode?: string;
    /** Shared */
    useGTD?: boolean;
}

// ============================================================================
// Per-segment extraction outputs
// ============================================================================

export interface SegmentExtract {
    sectionId: string;
    sectionName: string;
    actions: Action[];
    decisions: Decision[];
    risks: Risk[];
    notable_points: NotablePoint[];
    open_questions: OpenQuestion[];
    deferred_items: DeferredItem[];
}

export type SegmentResult =
    | { kind: 'success'; sectionId: string; name: string; extract: SegmentExtract }
    | { kind: 'failed'; sectionId: string; name: string; error: string; rawExcerpt: string }
    | { kind: 'skipped'; sectionId: string; name: string; reason: 'empty' | 'cancelled' };

export interface MultiSegmentResult {
    segments: SegmentResult[];
    /**
     * ALWAYS present (Gemini-G1 + R3-H2). Failed/skipped segments become
     * corresponding SegmentSection entries with kind: 'failed' | 'skipped'.
     */
    consolidated: MinutesJSON;
    cancelled: boolean;
}

// ============================================================================
// Renderer-facing discriminated union (R2-H2)
// ============================================================================

export type SegmentSection =
    | {
          kind: 'content';
          sectionId: string;
          name: string;
          summary: string;
          decisions: Decision[];
          actions: Action[];
          risks: Risk[];
          notable_points: NotablePoint[];
          open_questions: OpenQuestion[];
          deferred_items: DeferredItem[];
      }
    | {
          kind: 'failed';
          sectionId: string;
          name: string;
          sanitizedError: string;
          redactedExcerpt: string;
      }
    | {
          kind: 'skipped';
          sectionId: string;
          name: string;
          reason: 'empty' | 'cancelled';
      };

// ============================================================================
// MinutesJSON extension via TypeScript declaration merging
// ============================================================================

declare module '../prompts/minutesPrompts' {
    interface MinutesJSON {
        /**
         * Omitted entirely in legacy mode (D7). Present only when multi-segment
         * generation ran AND produced ≥1 section.
         */
        sections?: SegmentSection[];
    }

    interface Action {
        /**
         * Multi-segment provenance — populated by the consolidation LLM.
         * Gemini-G3: when missing/unmatched, attribution falls back to
         * bundle-wide provenance search.
         */
        segmentId?: string;
    }
}

// ============================================================================
// Legacy-path predicate (R2-H1)
// ============================================================================

export interface ItemWithSection {
    sectionId: string;
}

/**
 * The single source of truth for "should we use the legacy single-segment path?".
 * Operates on EFFECTIVE segmentation after pruning empty topics + resolving
 * unknown section IDs to 'general'.
 *
 * Returns true (use legacy) when:
 *   - No populated topics exist (all topics are empty after counting assignments), AND
 *   - All assigned items resolve to 'general' (or there are no assigned items)
 */
export function shouldUseLegacyPath(params: {
    populatedTopicCount: number;
    effectiveSectionIds: ReadonlySet<string>;
}): boolean {
    const { populatedTopicCount, effectiveSectionIds } = params;
    if (populatedTopicCount > 0) return false;
    if (effectiveSectionIds.size === 0) return true; // no items at all
    return effectiveSectionIds.size === 1 && effectiveSectionIds.has('general');
}

// Re-export underlying types so consumers can import everything from minutesTypes.
export type { Action, Decision, Risk, NotablePoint, OpenQuestion, DeferredItem, MinutesJSON, MeetingMetadata };
export type { LabelledTimedTranscript };
