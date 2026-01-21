/**
 * Mermaid Diagram Generation Prompts
 */

import type { DiagramType } from '../../ui/modals/MermaidDiagramModal';

export interface DiagramPromptOptions {
    diagramType: DiagramType;
    instruction: string;
    noteContent: string;
}

const DIAGRAM_TYPE_GUIDANCE: Record<DiagramType, string> = {
    auto: `Analyze the content and choose the most appropriate diagram type from:
- flowchart: For processes, workflows, decision trees
- mindmap: For hierarchical concepts, brainstorming, topic overview
- sequenceDiagram: For interactions between entities over time
- classDiagram: For object structures and relationships
- stateDiagram: For state machines and lifecycle stages
- erDiagram: For database entities and relationships
- timeline: For chronological events
- gantt: For project schedules and task timelines`,

    flowchart: `Create a flowchart (flowchart TD or flowchart LR).
Use appropriate shapes:
- [text] for rectangles (processes)
- {text} for diamonds (decisions)
- ([text]) for rounded rectangles (start/end)
- [[text]] for subroutines
Use arrows: --> for flow, -.-> for optional, ==> for important`,

    mindmap: `Create a mindmap diagram.
Format:
mindmap
  root((Central Topic))
    Branch 1
      Sub-branch 1.1
      Sub-branch 1.2
    Branch 2
      Sub-branch 2.1`,

    sequenceDiagram: `Create a sequence diagram showing interactions.
Use:
- participant A
- A->>B: Message (solid arrow)
- A-->>B: Response (dashed arrow)
- Note over A,B: Note text
- loop/alt/opt blocks for control flow`,

    classDiagram: `Create a class diagram showing structure.
Use:
- class ClassName
- ClassName : +attribute
- ClassName : +method()
- ClassA <|-- ClassB (inheritance)
- ClassA *-- ClassB (composition)
- ClassA o-- ClassB (aggregation)`,

    stateDiagram: `Create a state diagram (stateDiagram-v2).
Use:
- [*] --> State1 (initial)
- State1 --> State2 : event
- State2 --> [*] (final)
- state "Description" as s1`,

    erDiagram: `Create an ER diagram for entities and relationships.
Use:
- ENTITY1 ||--o{ ENTITY2 : relationship
- Cardinality: ||, |{, o|, o{
- Add attributes inside entities`,

    timeline: `Create a timeline of events.
Format:
timeline
    title Timeline Title
    section Period 1
        Event 1 : Description
        Event 2 : Description
    section Period 2
        Event 3 : Description`,

    gantt: `Create a Gantt chart.
Format:
gantt
    title Project Title
    dateFormat YYYY-MM-DD
    section Phase 1
        Task 1 : a1, 2024-01-01, 30d
        Task 2 : after a1, 20d`,
};

export function buildDiagramPrompt(options: DiagramPromptOptions): string {
    const { diagramType, instruction, noteContent } = options;
    const typeGuidance = DIAGRAM_TYPE_GUIDANCE[diagramType];

    return `<task>
Generate a Mermaid diagram based on the note content and user instruction.
</task>

<critical_instructions>
- Output ONLY valid Mermaid syntax that can be rendered
- Do NOT include the \`\`\`mermaid code fence - just the raw Mermaid code
- Keep the diagram readable - don't overcrowd with too many nodes
- Use meaningful labels that capture the essence of concepts
- Ensure all syntax is correct and will render properly
</critical_instructions>

<diagram_type>
${typeGuidance}
</diagram_type>

<user_instruction>
${instruction}
</user_instruction>

<note_content>
${noteContent}
</note_content>

<output_requirements>
1. Return ONLY the Mermaid diagram code
2. No explanations, no markdown fences, just the diagram syntax
3. Start directly with the diagram type (e.g., "flowchart TD", "mindmap", etc.)
4. Keep it concise - aim for 10-25 nodes maximum for readability
5. Use clear, short labels (2-5 words per node)
</output_requirements>`;
}

/**
 * Clean and validate the Mermaid output from LLM
 */
export function cleanMermaidOutput(output: string): string {
    let cleaned = output.trim();

    // Remove markdown code fences if present
    if (cleaned.startsWith('```mermaid')) {
        cleaned = cleaned.replace(/^```mermaid\n?/, '');
    }
    if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\n?/, '');
    }
    if (cleaned.endsWith('```')) {
        cleaned = cleaned.replace(/\n?```$/, '');
    }

    // Ensure it starts with a valid diagram type
    const validStarts = [
        'flowchart',
        'graph',
        'mindmap',
        'sequenceDiagram',
        'classDiagram',
        'stateDiagram',
        'erDiagram',
        'timeline',
        'gantt',
        'pie',
        'journey',
        'gitGraph',
        'quadrantChart',
        'xychart',
    ];

    const firstLine = cleaned.split('\n')[0].trim().toLowerCase();
    const hasValidStart = validStarts.some(start =>
        firstLine.startsWith(start.toLowerCase())
    );

    if (!hasValidStart) {
        // Try to detect and fix common issues
        if (cleaned.includes('-->') || cleaned.includes('---')) {
            // Looks like a flowchart without the declaration
            cleaned = 'flowchart TD\n' + cleaned;
        }
    }

    return cleaned.trim();
}

/**
 * Wrap the diagram in a code fence for insertion
 */
export function wrapInCodeFence(mermaidCode: string): string {
    return '```mermaid\n' + mermaidCode + '\n```';
}
