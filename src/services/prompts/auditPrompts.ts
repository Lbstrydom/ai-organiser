/**
 * Audit Prompts (Phases 5-6)
 * XML-style prompts for optional LLM audit layers.
 * DD-5: Audit is always optional, never blocking.
 */

import type { MinutesJSON } from './minutesPrompts';
import type { PlacementStrategy, FormatStrategy } from '../../core/constants';
import type { ValidationIssue } from '../validators/types';
import { AUDIT_TRANSCRIPT_EXCERPT_CHARS, AUDIT_ORIGINAL_EXCERPT_CHARS, AUDIT_PENDING_EXCERPT_CHARS } from '../validators/constants';

/**
 * Build the minutes audit prompt.
 * Sends the generated MinutesJSON + transcript excerpt + existing validation issues
 * for semantic review by a reasoning model.
 */
export function buildMinutesAuditPrompt(
    json: MinutesJSON,
    transcript: string,
    validationIssues: ValidationIssue[]
): string {
    const transcriptExcerpt = transcript.slice(0, AUDIT_TRANSCRIPT_EXCERPT_CHARS);
    const issuesSummary = validationIssues.length > 0
        ? validationIssues.map(i => `[${i.severity}] ${i.field}: ${i.message}`).join('\n')
        : 'No issues found by deterministic validation.';

    return `<task>
Audit these meeting minutes for accuracy and completeness.
You are reviewing AI-generated minutes against the original transcript.
</task>

<minutes_json>
${JSON.stringify(json, null, 2)}
</minutes_json>

<transcript_excerpt>
${transcriptExcerpt}
</transcript_excerpt>

<existing_issues>
${issuesSummary}
</existing_issues>

<requirements>
1. Verify action items are traceable to specific discussion in the transcript
2. Check that decision wording is accurate (not paraphrased incorrectly)
3. Verify participant attributions are correct (right person assigned)
4. Flag any agenda items with no corresponding discussion/decision
5. Check for important content mentioned in transcript but missing from minutes
</requirements>

<output_format>
Return JSON only, no other text:
{
  "verdict": "approve" | "optimize" | "flag",
  "issues": [{ "severity": "warning" | "info", "field": "string", "message": "string" }],
  "optimized": null
}

- "approve": Minutes are accurate and complete
- "optimize": Provide corrected MinutesJSON in the "optimized" field
- "flag": Issues found but no correction attempted

If verdict is "optimize", set "optimized" to the corrected MinutesJSON object.
Otherwise, set "optimized" to null.
</output_format>`;
}

/**
 * Build the integration audit prompt.
 * Reviews LLM integration output for content preservation and accuracy.
 * Only uses approve/flag (no optimize — rewriting a rewrite is too risky).
 */
export function buildIntegrationAuditPrompt(
    output: string,
    originalContent: string,
    pendingContent: string,
    placement: PlacementStrategy,
    format: FormatStrategy
): string {
    const originalExcerpt = originalContent.slice(0, AUDIT_ORIGINAL_EXCERPT_CHARS);
    const pendingExcerpt = pendingContent.slice(0, AUDIT_PENDING_EXCERPT_CHARS);

    return `<task>
Audit this note integration for content preservation and accuracy.
The LLM was asked to integrate pending content into a note using "${placement}" placement + "${format}" format strategy.
</task>

<original_note>
${originalExcerpt}
</original_note>

<pending_content>
${pendingExcerpt}
</pending_content>

<integrated_output>
${output}
</integrated_output>

<requirements>
1. Verify all key information from the original note is preserved
2. Check that pending content has been meaningfully integrated (not just appended)
3. Verify no facts have been fabricated that appear in neither source
4. Confirm the output follows the requested format (${format})
</requirements>

<output_format>
Return JSON only, no other text:
{
  "verdict": "approve" | "flag",
  "issues": [{ "severity": "warning" | "info", "field": "string", "message": "string" }],
  "summary": "one-line assessment"
}
</output_format>`;
}
