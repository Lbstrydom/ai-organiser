/**
 * Independent cross-family critic (plan Cluster D / Phase 7). Implements the
 * `StoryboardJudge` seam Cluster A exposed: a single LLM pass that (1) verifies the
 * inferential (cited-but-not-verbatim) numeric claims against a BLIND
 * `{claim, cited_spans}` payload, and (2) checks the storyline for MECE + laddering.
 *
 * The CALLER resolves the critic's LLM context to a DIFFERENT model family from the
 * generator (via `presentationModelResolver` → a specialist service), so this is a
 * genuinely independent review, not the author grading its own work. Never throws —
 * any failure (offline / abort / malformed JSON) degrades to an empty verdict, so
 * the deterministic structural audit always stands on its own.
 */
import type { LLMFacadeContext } from '../llmFacade';
import { summarizeText } from '../llmFacade';
import type { ConsultantStoryboard, EvidenceSpan } from '../presentationIr/consultantStoryboard';
import type { ClaimCheck } from '../presentationIr/evidenceGrounding';
import { selfCheckStoryboard, buildGroundingAuditPayload } from '../presentationIr/evidenceGrounding';
import type { StoryboardJudge, JudgeVerdict, StructuralFinding } from './consultantAuditService';
import { isValidFinding } from './consultantAuditService';
import { tryExtractJson } from '../../utils/responseParser';
import { logger } from '../../utils/logger';

export interface CriticOptions {
    signal?: AbortSignal;
    outputLanguage?: string;
    timeoutMs?: number;
    /** Same-provider critic role: switch the model via modelOverride (cross-provider uses a specialist context). */
    modelOverride?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function neutralise(s: string): string {
    return s.replace(/</g, '<​');
}

function buildCriticPrompt(storyboard: ConsultantStoryboard, inferential: readonly ClaimCheck[], catalog: readonly EvidenceSpan[], outputLanguage?: string): string {
    const langLine = outputLanguage && outputLanguage !== 'en' ? `\nWrite all messages in ${neutralise(outputLanguage)}.` : '';
    const slides = storyboard.slides.map((s, i) => `${i + 1}. [${s.role}] id=${s.id} — ${neutralise(s.action_title)}`).join('\n');
    const claims = inferential.map((c, i) => {
        const p = buildGroundingAuditPayload(c, catalog);
        return `N${i + 1} (slide ${c.slideId}): claim="${neutralise(p.claim)}" | cited_sources=${neutralise(JSON.stringify(p.cited_spans))}`;
    }).join('\n');

    return `You are an INDEPENDENT review consultant pressure-testing a colleague's deck storyline before it ships. Be skeptical and specific.${langLine}

<thesis>${neutralise(storyboard.thesis)}</thesis>

<slides>
${slides}
</slides>

<numeric_claims_to_verify>
${claims || '(none)'}
</numeric_claims_to_verify>

<task>
1. GROUNDING: for each numeric claim, decide whether the cited_sources ACTUALLY support that exact number. If a claim is NOT supported by its cited sources, flag it (dimension "grounding", severity "blocker", slideId = the claim's slide).
2. MECE: do the slides overlap or leave gaps in the argument? Flag overlaps/gaps (dimension "mece", severity "major", slideId null).
3. LADDERING: does every slide ladder up to the thesis (pyramid principle)? Flag any slide that doesn't follow (dimension "laddering", severity "major", slideId = the slide).
</task>

<output_format>
Return ONLY a JSON array (no prose, no markdown fences):
[{"slideId":"<slide id or null>","dimension":"grounding|mece|laddering","severity":"blocker|major|minor","message":"<specific, actionable>"}]
Return [] when the storyline is sound.
</output_format>`;
}

/** Parse + runtime-validate the critic's JSON findings (normalises null/'' slideId → undefined). */
function parseCriticFindings(content: string): StructuralFinding[] {
    const parsed = tryExtractJson(content);
    const arr = Array.isArray(parsed) ? parsed : [];
    const out: StructuralFinding[] = [];
    for (const raw of arr.slice(0, 50)) { // cap the number of untrusted findings
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        const slideId = typeof r.slideId === 'string' && r.slideId && r.slideId !== 'null' ? r.slideId : undefined;
        // Bound the untrusted diagnostic message (audit M16) so a runaway LLM
        // response can't inject a huge string into the audit/UI.
        const message = typeof r.message === 'string' ? r.message.slice(0, 500) : r.message;
        const candidate = { slideId, dimension: r.dimension, severity: r.severity, message };
        if (isValidFinding(candidate)) out.push(candidate);
    }
    return out;
}

/**
 * Build the independent-critic `StoryboardJudge`. The judge re-grounds the
 * storyboard against the catalog itself (so it needs no pre-computed report) and
 * runs ONE critic LLM call. Returns an empty verdict (graceful) on any failure.
 */
export function buildStoryboardJudge(
    context: LLMFacadeContext,
    catalog: readonly EvidenceSpan[],
    options: CriticOptions = {},
): StoryboardJudge {
    return async (storyboard: ConsultantStoryboard): Promise<JudgeVerdict> => {
        const grounding = selfCheckStoryboard(storyboard, catalog);
        // Nothing for the critic to add when there are no unverified numbers AND the
        // deck is too small to have MECE/laddering structure.
        if (grounding.inferential.length === 0 && storyboard.slides.length < 2) return { findings: [] };
        const prompt = buildCriticPrompt(storyboard, grounding.inferential, catalog, options.outputLanguage);
        try {
            const r = await summarizeText(context, prompt, {
                signal: options.signal,
                timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                label: 'presentation-critic',
                disableThinking: true,  // structured judgment task — no adaptive thinking (latency)
                ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
            });
            if (options.signal?.aborted) return { findings: [] };
            if (!r.success || !r.content) return { findings: [] };
            return { findings: parseCriticFindings(r.content) };
        } catch (e) {
            logger.warn('Presentation', `independent critic failed, using deterministic audit only: ${e instanceof Error ? e.message : String(e)}`);
            return { findings: [] };
        }
    };
}
