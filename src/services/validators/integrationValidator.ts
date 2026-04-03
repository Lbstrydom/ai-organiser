/**
 * Integration Output Validator (Phase 3)
 * Deterministic post-LLM validation for integration output.
 * Checks content preservation, format compliance, instruction leakage, and length sanity.
 * DD-7: Structural checks, not content comparison.
 */

import type { PlacementStrategy, FormatStrategy } from '../../core/constants';
import type { ValidationResult, ValidationIssue } from './types';
import { INTEGRATION_MIN_LENGTH_RATIO, INTEGRATION_MAX_LENGTH_RATIO, EMBED_LOSS_THRESHOLD } from './constants';

export interface IntegrationValidationOptions {
    placement: PlacementStrategy;
    format: FormatStrategy;
    originalContent: string;
    pendingContent: string;
}

/** Common LLM preamble patterns that should be stripped */
const PREAMBLE_PATTERN = /^(Here (is|are)|I('ve| have) (integrated|combined|merged)|Below (is|are)|The following)[^\n]*\n+/i;

/**
 * Validate LLM integration output before insertion.
 * Checks: content preservation, format compliance, instruction leakage, length sanity.
 */
export function validateIntegrationOutput(
    output: string,
    options: IntegrationValidationOptions
): ValidationResult<string> {
    const issues: ValidationIssue[] = [];
    let data = output;

    // 1. Instruction leakage — strip LLM preambles
    data = stripPreamble(data, issues);

    // 2. Content preservation (callout/merge only — these strategies rewrite the note)
    if (options.placement === 'callout' || options.placement === 'merge') {
        checkContentPreservation(data, options.originalContent, issues);
    }

    // 3. Format compliance
    checkFormatCompliance(data, options.format, issues);

    // 4. Length sanity (callout/merge only)
    if (options.placement === 'callout' || options.placement === 'merge') {
        checkLengthSanity(data, options.originalContent, options.pendingContent, issues);
    }

    return {
        valid: !issues.some(i => i.severity === 'error'),
        data,
        issues
    };
}

// --- Instruction Leakage ---

function stripPreamble(output: string, issues: ValidationIssue[]): string {
    const match = output.match(PREAMBLE_PATTERN);
    if (match) {
        issues.push({
            severity: 'info',
            field: 'output',
            message: `Stripped LLM preamble: "${match[0].trim()}"`,
            autoFixed: true
        });
        return output.replace(PREAMBLE_PATTERN, '');
    }
    return output;
}

// --- Content Preservation ---

function checkContentPreservation(output: string, originalContent: string, issues: ValidationIssue[]): void {
    // Extract all markdown headings from original
    const headingRegex = /^(#{1,6})\s+(.+)$/gm;
    const originalHeadings: string[] = [];
    let match;
    while ((match = headingRegex.exec(originalContent)) !== null) {
        originalHeadings.push(match[2].trim());
    }

    // Check each heading exists in output (case-insensitive, whitespace-normalized)
    for (const heading of originalHeadings) {
        const normalizedHeading = heading.toLowerCase().replace(/\s+/g, ' ');
        const normalizedOutput = output.toLowerCase().replace(/\s+/g, ' ');
        if (!normalizedOutput.includes(normalizedHeading)) {
            issues.push({
                severity: 'warning',
                field: 'content_preservation',
                message: `Heading "${heading}" from original content not found in output`
            });
        }
    }

    // Check embedded content markers
    checkEmbedPreservation(output, originalContent, issues);
}

function checkEmbedPreservation(output: string, originalContent: string, issues: ValidationIssue[]): void {
    const embedPatterns = [/!\[\[/g, /!\[/g, /https?:\/\/\S+/g];
    for (const pattern of embedPatterns) {
        const originalCount = (originalContent.match(pattern) || []).length;
        const outputCount = (output.match(pattern) || []).length;
        if (originalCount > 0 && outputCount < originalCount * EMBED_LOSS_THRESHOLD) {
            issues.push({
                severity: 'warning',
                field: 'content_preservation',
                message: `Significant reduction in embedded content (${originalCount} → ${outputCount} matches for ${pattern.source})`
            });
        }
    }
}

// --- Format Compliance ---

function checkFormatCompliance(output: string, format: FormatStrategy, issues: ValidationIssue[]): void {
    switch (format) {
        case 'tasks':
            if (!/- \[[ x]\]/.test(output)) {
                issues.push({
                    severity: 'warning',
                    field: 'format',
                    message: "Tasks format requested but no '- [ ]' or '- [x]' items found"
                });
            }
            break;
        case 'table':
            if (!/\|[\s-]+\|/.test(output)) {
                issues.push({
                    severity: 'warning',
                    field: 'format',
                    message: "Table format requested but no pipe-separator rows found"
                });
            }
            break;
        case 'bullets':
            if (!/^[\t ]*[-*] /m.test(output)) {
                issues.push({
                    severity: 'warning',
                    field: 'format',
                    message: "Bullets format requested but no bullet items found"
                });
            }
            break;
        // 'prose' — no specific format check
    }
}

// --- Length Sanity ---

function checkLengthSanity(
    output: string,
    originalContent: string,
    pendingContent: string,
    issues: ValidationIssue[]
): void {
    const combinedInputLength = originalContent.length + pendingContent.length;
    if (combinedInputLength === 0) return;

    const ratio = output.length / combinedInputLength;

    if (ratio < INTEGRATION_MIN_LENGTH_RATIO) {
        issues.push({
            severity: 'warning',
            field: 'length',
            message: `Output is suspiciously short (${Math.round(ratio * 100)}% of input — possible data loss)`
        });
    }

    if (ratio > INTEGRATION_MAX_LENGTH_RATIO) {
        issues.push({
            severity: 'warning',
            field: 'length',
            message: `Output is suspiciously long (${Math.round(ratio * 100)}% of input — possible hallucination/repetition)`
        });
    }
}
