/**
 * Neutral structural-audit types (audit M16 — layering). The dot-dash serializer
 * (presentationIr layer) renders audit findings but must NOT import from the
 * higher chat/audit-service layer. These shared types live here so both the
 * serializer and `consultantAuditService` import DOWNWARD into one neutral module.
 */
export type StructuralDimension =
    | 'grounding' | 'action-title' | 'one-message' | 'chart-appropriateness' | 'mece' | 'laddering';
export type Severity = 'blocker' | 'major' | 'minor';

export interface StructuralFinding {
    readonly slideId?: string; // absent → deck-level
    readonly dimension: StructuralDimension;
    readonly severity: Severity;
    readonly message: string;
}

export interface StructuralAuditResult {
    readonly findings: readonly StructuralFinding[];
    /** slideId → findings; deck-level findings live under `DECK_LEVEL_KEY`. */
    readonly bySlide: ReadonlyMap<string, readonly StructuralFinding[]>;
}

/**
 * The map key for deck-level (non-slide) findings (audit M8/M21/M22 — was a bare
 * magic `''`). Exported so the serializer + audit agree on one documented sentinel.
 */
export const DECK_LEVEL_KEY = '';
