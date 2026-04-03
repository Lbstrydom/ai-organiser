/**
 * Minutes LLM Auditor tests
 *
 * Covers: approve verdict, optimize verdict (valid/invalid), flag verdict,
 * timeout/error fail-open, parse failure, LLM response failures.
 */

import { describe, it, expect, vi } from 'vitest';
import { auditMinutesWithLLM } from '../src/services/validators/minutesAuditor';
import type { MinutesJSON } from '../src/services/prompts/minutesPrompts';
import type { ValidationIssue } from '../src/services/validators/types';

// --- Helpers ---

function makeMinimalMinutesJSON(overrides?: Partial<MinutesJSON>): MinutesJSON {
    return {
        metadata: {
            title: 'Test Meeting',
            date: '2026-02-22',
            start_time: '10:00',
            end_time: '11:00',
            timezone: 'UTC',
            meeting_context: 'internal',
            output_audience: 'internal',
            confidentiality_level: 'internal',
            chair: 'Alice',
            minute_taker: 'Bob',
            location: 'Room 1',
            quorum_present: true
        },
        participants: [{ name: 'Alice', role: 'Chair' }, { name: 'Bob' }],
        agenda: ['Item 1', 'Item 2'],
        decisions: [{ id: 'D1', text: 'Approved budget', confidence: 'high' }],
        actions: [{ id: 'A1', text: 'Draft proposal', owner: 'Alice', due_date: '2026-03-01', confidence: 'high' }],
        risks: [],
        notable_points: [],
        open_questions: [],
        deferred_items: [],
        ...overrides
    };
}

function makeMockLLM(response: object) {
    return {
        summarizeText: vi.fn().mockResolvedValue({
            success: true,
            content: JSON.stringify(response)
        })
    } as any;
}

function makeMockLLMRaw(content: string) {
    return {
        summarizeText: vi.fn().mockResolvedValue({
            success: true,
            content
        })
    } as any;
}

function makeMockLLMFailing() {
    return {
        summarizeText: vi.fn().mockRejectedValue(new Error('LLM timeout'))
    } as any;
}

function makeMockLLMUnsuccessful() {
    return {
        summarizeText: vi.fn().mockResolvedValue({
            success: false,
            content: null,
            error: 'Rate limited'
        })
    } as any;
}

// --- Tests ---

describe('auditMinutesWithLLM', () => {
    const transcript = 'Alice: I think we should approve the budget. Bob: Agreed.';
    const noIssues: ValidationIssue[] = [];

    // ═══════════════════════════════════════════
    // Approve verdict
    // ═══════════════════════════════════════════

    it('returns original JSON unchanged when verdict is approve', async () => {
        const json = makeMinimalMinutesJSON();
        const mockLLM = makeMockLLM({
            verdict: 'approve',
            issues: [],
            optimized: null
        });

        const result = await auditMinutesWithLLM(json, transcript, noIssues, mockLLM);

        expect(result.valid).toBe(true);
        expect(result.data).toEqual(json);
        expect(result.issues).toEqual([]);
    });

    it('passes audit issues through when verdict is approve with issues', async () => {
        const json = makeMinimalMinutesJSON();
        const mockLLM = makeMockLLM({
            verdict: 'approve',
            issues: [
                { severity: 'info', field: 'actions', message: 'Consider adding due dates' }
            ],
            optimized: null
        });

        const result = await auditMinutesWithLLM(json, transcript, noIssues, mockLLM);

        expect(result.valid).toBe(true);
        expect(result.data).toEqual(json);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].message).toContain('[Audit]');
        expect(result.issues[0].message).toContain('Consider adding due dates');
    });

    // ═══════════════════════════════════════════
    // Optimize verdict
    // ═══════════════════════════════════════════

    it('returns optimized JSON when verdict is optimize with valid optimized output', async () => {
        const json = makeMinimalMinutesJSON();
        const optimized = makeMinimalMinutesJSON({
            decisions: [
                { id: 'D1', text: 'Approved budget of $50k', confidence: 'high' }
            ]
        });
        const mockLLM = makeMockLLM({
            verdict: 'optimize',
            issues: [
                { severity: 'info', field: 'decisions', message: 'Added dollar amount to decision' }
            ],
            optimized
        });

        const result = await auditMinutesWithLLM(json, transcript, noIssues, mockLLM);

        expect(result.valid).toBe(true);
        // Should return the optimized version, not the original
        expect(result.data.decisions[0].text).toContain('$50k');
        expect(result.issues.some(i => i.message.includes('[Audit]'))).toBe(true);
    });

    it('falls back to original when optimize verdict has invalid optimized JSON (missing metadata)', async () => {
        const json = makeMinimalMinutesJSON();
        // Optimized output is missing required metadata
        const invalidOptimized = {
            participants: [],
            agenda: [],
            decisions: [],
            actions: [],
            risks: [],
            notable_points: [],
            open_questions: [],
            deferred_items: []
            // No metadata!
        };
        const mockLLM = makeMockLLM({
            verdict: 'optimize',
            issues: [],
            optimized: invalidOptimized
        });

        const result = await auditMinutesWithLLM(json, transcript, noIssues, mockLLM);

        expect(result.valid).toBe(true);
        expect(result.data).toEqual(json); // Original returned
        expect(result.issues.some(i => i.message.includes('integrity check'))).toBe(true);
    });

    it('falls back to original when optimize verdict has null optimized field', async () => {
        const json = makeMinimalMinutesJSON();
        const mockLLM = makeMockLLM({
            verdict: 'optimize',
            issues: [{ severity: 'info', field: 'actions', message: 'Minor improvement' }],
            optimized: null
        });

        const result = await auditMinutesWithLLM(json, transcript, noIssues, mockLLM);

        expect(result.valid).toBe(true);
        // optimize with no optimized field → treated like approve/flag path
        expect(result.data).toEqual(json);
    });

    // ═══════════════════════════════════════════
    // Flag verdict
    // ═══════════════════════════════════════════

    it('returns original JSON with audit issues when verdict is flag', async () => {
        const json = makeMinimalMinutesJSON();
        const mockLLM = makeMockLLM({
            verdict: 'flag',
            issues: [
                { severity: 'warning', field: 'actions[0]', message: 'Action owner may be wrong person' },
                { severity: 'info', field: 'decisions', message: 'Decision wording could be clearer' }
            ],
            optimized: null
        });

        const result = await auditMinutesWithLLM(json, transcript, noIssues, mockLLM);

        expect(result.valid).toBe(true);
        expect(result.data).toEqual(json);
        expect(result.issues).toHaveLength(2);
        expect(result.issues[0].severity).toBe('warning');
        expect(result.issues[1].severity).toBe('info');
    });

    // ═══════════════════════════════════════════
    // Fail-open scenarios
    // ═══════════════════════════════════════════

    it('returns original JSON with skip notice when LLM throws error (fail-open)', async () => {
        const json = makeMinimalMinutesJSON();
        const mockLLM = makeMockLLMFailing();

        const result = await auditMinutesWithLLM(json, transcript, noIssues, mockLLM);

        expect(result.valid).toBe(true);
        expect(result.data).toEqual(json);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].message).toBe('LLM audit skipped');
        expect(result.issues[0].severity).toBe('info');
    });

    it('returns original JSON with skip notice when LLM returns unsuccessful response', async () => {
        const json = makeMinimalMinutesJSON();
        const mockLLM = makeMockLLMUnsuccessful();

        const result = await auditMinutesWithLLM(json, transcript, noIssues, mockLLM);

        expect(result.valid).toBe(true);
        expect(result.data).toEqual(json);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].message).toBe('LLM audit skipped');
    });

    it('returns original JSON with skip notice when response is unparseable', async () => {
        const json = makeMinimalMinutesJSON();
        const mockLLM = makeMockLLMRaw('This is not JSON at all, just plain text rambling.');

        const result = await auditMinutesWithLLM(json, transcript, noIssues, mockLLM);

        expect(result.valid).toBe(true);
        expect(result.data).toEqual(json);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].message).toBe('LLM audit skipped');
    });

    it('returns skip notice when response JSON has no verdict field', async () => {
        const json = makeMinimalMinutesJSON();
        const mockLLM = makeMockLLM({ someOtherField: 'value' });

        const result = await auditMinutesWithLLM(json, transcript, noIssues, mockLLM);

        expect(result.valid).toBe(true);
        expect(result.data).toEqual(json);
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].message).toBe('LLM audit skipped');
    });

    // ═══════════════════════════════════════════
    // LLM invocation verification
    // ═══════════════════════════════════════════

    it('calls llmService.summarizeText exactly once', async () => {
        const json = makeMinimalMinutesJSON();
        const mockLLM = makeMockLLM({ verdict: 'approve', issues: [] });

        await auditMinutesWithLLM(json, transcript, noIssues, mockLLM);

        expect(mockLLM.summarizeText).toHaveBeenCalledTimes(1);
        // The prompt should contain the JSON and transcript
        const prompt = mockLLM.summarizeText.mock.calls[0][0];
        expect(prompt).toContain('Test Meeting');
        expect(prompt).toContain(transcript.slice(0, 100));
    });

    // ═══════════════════════════════════════════
    // Provider override routing
    // ═══════════════════════════════════════════

    it('uses main llmService when providerConfig is null', async () => {
        const json = makeMinimalMinutesJSON();
        const mockLLM = makeMockLLM({ verdict: 'approve', issues: [] });

        await auditMinutesWithLLM(json, transcript, noIssues, mockLLM, null);

        // Main service should have been called
        expect(mockLLM.summarizeText).toHaveBeenCalledTimes(1);
    });

    it('uses main llmService when providerConfig provided but no app', async () => {
        const json = makeMinimalMinutesJSON();
        const mockLLM = makeMockLLM({ verdict: 'approve', issues: [] });
        const config = { provider: 'claude' as any, apiKey: 'sk-test', model: 'claude-opus-4-6', endpoint: 'https://api.anthropic.com' };

        // No app provided → falls back to main service
        await auditMinutesWithLLM(json, transcript, noIssues, mockLLM, config);

        expect(mockLLM.summarizeText).toHaveBeenCalledTimes(1);
    });

    // ═══════════════════════════════════════════
    // Validation options forwarding
    // ═══════════════════════════════════════════

    it('forwards validationOptions to revalidation on optimize verdict', async () => {
        const json = makeMinimalMinutesJSON();
        // Optimized output has an action with owner not in participants
        const optimized = makeMinimalMinutesJSON({
            actions: [{ id: 'A1', text: 'Do thing', owner: 'Charlie', due_date: '2026-03-01', confidence: 'high' }]
        });
        const mockLLM = makeMockLLM({
            verdict: 'optimize',
            issues: [],
            optimized
        });

        // Pass validationOptions with participants — 'Charlie' is NOT in participants
        const result = await auditMinutesWithLLM(json, transcript, noIssues, mockLLM, null, {
            validationOptions: { participants: ['Alice', 'Bob'], useGTD: false }
        });

        // Revalidation should produce a cross-ref warning for 'Charlie' not in participants
        const crossRefIssue = result.issues.find(i =>
            i.field.includes('owner') && i.message.includes('Charlie')
        );
        expect(crossRefIssue).toBeDefined();
    });

    it('does not produce cross-ref warnings when validationOptions omits participants', async () => {
        const json = makeMinimalMinutesJSON();
        const optimized = makeMinimalMinutesJSON({
            actions: [{ id: 'A1', text: 'Do thing', owner: 'Charlie', due_date: '2026-03-01', confidence: 'high' }]
        });
        const mockLLM = makeMockLLM({
            verdict: 'optimize',
            issues: [],
            optimized
        });

        // No validationOptions → no participant cross-ref check
        const result = await auditMinutesWithLLM(json, transcript, noIssues, mockLLM);

        const crossRefIssue = result.issues.find(i =>
            i.field.includes('owner') && i.message.includes('Charlie')
        );
        expect(crossRefIssue).toBeUndefined();
    });

    it('maps severity correctly — only warning and info are allowed from audit', async () => {
        const json = makeMinimalMinutesJSON();
        // Auditor should map unknown severity to 'info'
        const mockLLM = makeMockLLM({
            verdict: 'flag',
            issues: [
                { severity: 'error', field: 'test', message: 'This should become info' },
                { severity: 'warning', field: 'test', message: 'This stays warning' }
            ]
        });

        const result = await auditMinutesWithLLM(json, transcript, noIssues, mockLLM);

        // 'error' severity from audit is mapped to 'info' (not 'error')
        expect(result.issues[0].severity).toBe('info');
        expect(result.issues[1].severity).toBe('warning');
    });
});
