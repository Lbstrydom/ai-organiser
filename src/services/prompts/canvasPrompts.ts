export function buildEdgeLabelPrompt(
    pairs: Array<{ fromTitle: string; fromSnippet: string; toTitle: string; toSnippet: string; pairIndex: number }>,
    language: string
): string {
    const formattedPairs = pairs
        .map(pair => {
            return [
                `[Pair ${pair.pairIndex}]`,
                `From Title: ${pair.fromTitle}`,
                `From Snippet: ${pair.fromSnippet}`,
                `To Title: ${pair.toTitle}`,
                `To Snippet: ${pair.toSnippet}`
            ].join('\n');
        })
        .join('\n\n');

    return `<task>
You are analyzing relationships between notes in a knowledge vault.
For each pair of notes below, provide a 1-4 word relationship label
describing how the second note relates to the first.
</task>

<requirements>
- Use ${language} for labels
- Keep labels to 1-4 words
</requirements>

<pairs>
${formattedPairs}
</pairs>

<output_format>
Return a JSON object with a "labels" array. Each item has "pairIndex" (number) and "label" (string, 1-4 words).
Example: {"labels": [{"pairIndex": 0, "label": "Core Concept"}, {"pairIndex": 1, "label": "Application"}]}
</output_format>`;
}

export function buildClusterPrompt(
    tag: string,
    notes: Array<{ title: string; snippet: string }>,
    language: string
): string {
    const formattedNotes = notes
        .map((note, index) => {
            return [
                `[${index}] ${note.title}`,
                `Snippet: ${note.snippet}`
            ].join('\n');
        })
        .join('\n\n');

    return `<task>
Cluster notes tagged with "${tag}" into meaningful groups. Each group should have a short, clear label.
</task>

<requirements>
- Use ${language} for labels
- Each note must appear in exactly one group
- Keep group labels concise (1-4 words)
</requirements>

<notes>
${formattedNotes}
</notes>

<output_format>
Return JSON: {"clusters": [{"label": "Group Name", "noteIndexes": [0, 2]}]}
</output_format>`;
}
