/**
 * The `## Handoff` contract. One definition, shown in the generated instructions and parsed back by the hand-back review, so
 * the two can never drift. Pure.
 */

export const HANDOFF_HEADING = 'Handoff';
export const HANDOFF_SECTIONS = ['Decisions', 'Next actions', 'Deliverables', 'Questions'] as const;

/** The block exactly as the AI is told to write it. */
export function renderHandoffContract(aioId: string): string {
    return [
        '## Handoff',
        `Project ID: ${aioId}`,
        'Chat project: <name> (claude|chatgpt)',
        '',
        '### Decisions',
        '- Suggested: <text>',
        '- Decided: <text>',
        '',
        '### Next actions',
        '- [ ] <text> @context (waiting: <person>) (due: YYYY-MM-DD)',
        '',
        '### Deliverables',
        '- <file name>: <one line> (draft|released)',
        '',
        '### Questions',
        '- <text>',
    ].join('\n');
}
