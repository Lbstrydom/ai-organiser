/**
 * Visual-selection guidance shared by the storyboard prompt and the IR prompt, so
 * the two stages describe the SAME choices in their own vocabularies (the storyboard
 * picks a `visual_data.type`, the IR picks a block `kind`) and cannot drift apart.
 *
 * One table of message types; two renderings of it. Pure data — no imports.
 */

interface VisualChoice {
    /** What the slide's message is about. */
    message: string;
    /** The storyboard `visual_data.type` to choose. */
    storyboard: string;
    /** The IR block `kind` to choose. */
    ir: string;
}

const VISUAL_CHOICES: readonly VisualChoice[] = [
    { message: 'a component: how parts add up to a whole', storyboard: '"waterfall" for a build-up, "bar" for shares', ir: 'waterfall for a build-up, bar-chart for shares' },
    { message: 'an item comparison: which is bigger, how items rank', storyboard: '"bar"', ir: 'bar-chart' },
    { message: 'a time series: how a value changes over time', storyboard: '"line"', ir: 'line-chart' },
    { message: 'a distribution: how values spread across ranges', storyboard: '"bar" over the ranges', ir: 'bar-chart over the ranges' },
    { message: 'a correlation: whether two measures move together', storyboard: '"2x2" or "table"', ir: 'a matrix-2x2 table or a table' },
];

/** The table-versus-chart rule, in both stages' words. */
const TABLE_VS_CHART = `- Use a TABLE when the reader must look up exact values, compare many attributes of the same items, or spot exceptions. Use a CHART when the message is a visual pattern (a trend, a gap, a ranking, a share). When in doubt: exact values → table, pattern → chart.
- A correlation or a quadrant position never states a cause: do not use arrows, rankings or wording that implies one unless a cited span says so.`;

/** The guidance block for one stage. */
export function buildVisualSelectionGuide(stage: 'storyboard' | 'ir'): string {
    const lines = VISUAL_CHOICES.map((c) => `  - ${c.message} → ${stage === 'storyboard' ? c.storyboard : c.ir}`);
    return `Match the visual to the MESSAGE the slide makes:\n${lines.join('\n')}\n${TABLE_VS_CHART}`;
}
