/**
 * The `## Handoff` contract. One definition, shown in the generated instructions and parsed back by the hand-back review, so
 * the two can never drift. Pure.
 */

export const HANDOFF_HEADING = 'Handoff';
export const HANDOFF_SECTIONS = ['Decisions', 'Next actions', 'Deliverables', 'Questions'] as const;

/** The block exactly as the AI is told to write it. */
export function renderHandoffContract(aioId: string): string {
    const [decisions, actions, deliverables, questions] = HANDOFF_SECTIONS;
    return [
        `## ${HANDOFF_HEADING}`,
        `Project ID: ${aioId}`,
        'Chat project: <name> (claude|chatgpt)',
        '',
        `### ${decisions}`,
        '- Suggested: <text>',
        '- Decided: <text>',
        '',
        `### ${actions}`,
        '- [ ] <text> @context (waiting: <person>) (due: YYYY-MM-DD)',
        '',
        `### ${deliverables}`,
        '- <file name>: <one line> (draft|released)',
        '',
        `### ${questions}`,
        '- <text>',
    ].join('\n');
}
