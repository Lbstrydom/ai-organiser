/**
 * Dashboard Templates
 * Built-in templates for .base file generation
 */

export type DashboardCategory = 'default' | 'persona';

export interface DashboardTemplate {
    name: string;
    description: string;
    fileName: string;
    content: string;
    category: DashboardCategory;
    personaId?: string;
    icon?: string;
}

/**
 * PERSONA TEMPLATES
 * Dashboards filtered by summarization persona
 */

/**
 * Student Notes Dashboard
 * Notes summarized with Student persona - academic study notes
 */
const STUDENT_NOTES_TEMPLATE = `---
name: Study Notes
description: Academic notes with Student persona
filters:
  - field: ${'{aio_persona}'}
    operator: equals
    value: student
  - field: ${'{aio_status}'}
    operator: equals
    value: processed
columns:
  - field: name
    label: Note
    width: 250
  - field: ${'{aio_summary}'}
    label: Summary
    width: 400
  - field: ${'{aio_type}'}
    label: Type
    width: 100
  - field: tags
    label: Tags
    width: 200
  - field: ${'{aio_processed}'}
    label: Date
    width: 120
sorting:
  - field: ${'{aio_processed}'}
    order: desc
---
`;

/**
 * Executive Briefings Dashboard
 * Notes summarized with Executive persona - business-focused summaries
 */
const EXECUTIVE_BRIEFINGS_TEMPLATE = `---
name: Executive Briefings
description: Business-focused summaries with Executive persona
filters:
  - field: ${'{aio_persona}'}
    operator: equals
    value: executive
  - field: ${'{aio_status}'}
    operator: equals
    value: processed
columns:
  - field: name
    label: Note
    width: 250
  - field: ${'{aio_summary}'}
    label: Summary
    width: 400
  - field: ${'{aio_source}'}
    label: Source
    width: 100
  - field: ${'{aio_processed}'}
    label: Date
    width: 120
  - field: tags
    label: Tags
    width: 200
sorting:
  - field: ${'{aio_processed}'}
    order: desc
---
`;

/**
 * Casual Reads Dashboard
 * Notes summarized with Casual persona - fun, conversational summaries
 */
const CASUAL_READS_TEMPLATE = `---
name: Casual Reads
description: Fun, conversational summaries with Casual persona
filters:
  - field: ${'{aio_persona}'}
    operator: equals
    value: casual
  - field: ${'{aio_status}'}
    operator: equals
    value: processed
columns:
  - field: name
    label: Note
    width: 250
  - field: ${'{aio_summary}'}
    label: Summary
    width: 400
  - field: ${'{aio_type}'}
    label: Type
    width: 100
  - field: ${'{aio_processed}'}
    label: Date
    width: 120
  - field: tags
    label: Tags
    width: 200
sorting:
  - field: ${'{aio_processed}'}
    order: desc
---
`;

/**
 * Research Papers Dashboard
 * Notes summarized with Researcher persona - academic research
 */
const RESEARCH_PAPERS_TEMPLATE = `---
name: Research Papers
description: Academic research with Researcher persona
filters:
  - field: ${'{aio_persona}'}
    operator: equals
    value: researcher
  - field: ${'{aio_status}'}
    operator: equals
    value: processed
columns:
  - field: name
    label: Note
    width: 250
  - field: ${'{aio_summary}'}
    label: Summary
    width: 400
  - field: ${'{aio_source_url}'}
    label: URL
    width: 200
  - field: ${'{aio_processed}'}
    label: Date
    width: 120
  - field: tags
    label: Tags
    width: 200
sorting:
  - field: ${'{aio_processed}'}
    order: desc
---
`;

/**
 * Tech Documentation Dashboard
 * Notes summarized with Technical persona - developer-focused notes
 */
const TECH_DOCS_TEMPLATE = `---
name: Tech Documentation
description: Developer-focused notes with Technical persona
filters:
  - field: ${'{aio_persona}'}
    operator: equals
    value: technical
  - field: ${'{aio_status}'}
    operator: equals
    value: processed
columns:
  - field: name
    label: Note
    width: 250
  - field: ${'{aio_summary}'}
    label: Summary
    width: 400
  - field: ${'{aio_type}'}
    label: Type
    width: 100
  - field: ${'{aio_processed}'}
    label: Date
    width: 120
  - field: tags
    label: Tags
    width: 200
sorting:
  - field: ${'{aio_processed}'}
    order: desc
---
`;

/**
 * DEFAULT TEMPLATES
 * General-purpose dashboards
 */

/**
 * General Knowledge Base Dashboard
 * Shows all processed notes with status tracking
 */
const GENERAL_KNOWLEDGE_BASE_TEMPLATE = `---
name: Knowledge Base
description: All AI-processed notes with status tracking
filters:
  - field: ${'{aio_status}'}
    operator: exists
columns:
  - field: name
    label: Note
    width: 300
  - field: ${'{aio_summary}'}
    label: Summary
    width: 400
  - field: ${'{aio_status}'}
    label: Status
    width: 100
  - field: ${'{aio_type}'}
    label: Type
    width: 100
  - field: ${'{aio_processed}'}
    label: Processed
    width: 150
  - field: tags
    label: Tags
    width: 200
sorting:
  - field: ${'{aio_processed}'}
    order: desc
---
`;

/**
 * Research Tracker Dashboard
 * Focused on research notes and web summaries
 */
const RESEARCH_TRACKER_TEMPLATE = `---
name: Research Tracker
description: Track research notes and web summaries
filters:
  - field: ${'{aio_type}'}
    operator: equals
    value: research
  - field: ${'{aio_status}'}
    operator: equals
    value: processed
columns:
  - field: name
    label: Note
    width: 300
  - field: ${'{aio_summary}'}
    label: Summary
    width: 400
  - field: ${'{aio_source}'}
    label: Source
    width: 100
  - field: ${'{aio_source_url}'}
    label: URL
    width: 200
  - field: ${'{aio_processed}'}
    label: Date
    width: 150
  - field: tags
    label: Tags
    width: 200
sorting:
  - field: ${'{aio_processed}'}
    order: desc
---
`;

/**
 * Pending Review Dashboard
 * Notes awaiting processing
 */
const PENDING_REVIEW_TEMPLATE = `---
name: Pending Review
description: Notes awaiting AI processing
filters:
  - field: ${'{aio_status}'}
    operator: equals
    value: pending
columns:
  - field: name
    label: Note
    width: 300
  - field: ${'{aio_word_count}'}
    label: Words
    width: 80
  - field: ${'{aio_type}'}
    label: Type
    width: 100
  - field: created
    label: Created
    width: 150
  - field: tags
    label: Tags
    width: 200
sorting:
  - field: created
    order: desc
---
`;

/**
 * Content by Type Dashboard
 * Group notes by content type
 */
const CONTENT_BY_TYPE_TEMPLATE = `---
name: Content by Type
description: Notes organized by content type
filters:
  - field: ${'{aio_type}'}
    operator: exists
columns:
  - field: name
    label: Note
    width: 300
  - field: ${'{aio_summary}'}
    label: Summary
    width: 400
  - field: ${'{aio_type}'}
    label: Type
    width: 100
  - field: ${'{aio_status}'}
    label: Status
    width: 100
  - field: ${'{aio_processed}'}
    label: Processed
    width: 150
grouping:
  - field: ${'{aio_type}'}
sorting:
  - field: ${'{aio_processed}'}
    order: desc
---
`;

/**
 * Processing Errors Dashboard
 * Track failed processing attempts
 */
const PROCESSING_ERRORS_TEMPLATE = `---
name: Processing Errors
description: Notes with processing errors
filters:
  - field: ${'{aio_status}'}
    operator: equals
    value: error
columns:
  - field: name
    label: Note
    width: 300
  - field: ${'{aio_type}'}
    label: Type
    width: 100
  - field: ${'{aio_processed}'}
    label: Last Attempt
    width: 150
  - field: tags
    label: Tags
    width: 200
sorting:
  - field: ${'{aio_processed}'}
    order: desc
---
`;

/**
 * All built-in templates
 */
export const DASHBOARD_TEMPLATES: DashboardTemplate[] = [
    // Default templates
    {
        name: 'General Knowledge Base',
        description: 'All processed notes with status tracking',
        fileName: 'Knowledge Base.base',
        content: GENERAL_KNOWLEDGE_BASE_TEMPLATE,
        category: 'default'
    },
    {
        name: 'Research Tracker',
        description: 'Research notes and web summaries',
        fileName: 'Research Tracker.base',
        content: RESEARCH_TRACKER_TEMPLATE,
        category: 'default'
    },
    {
        name: 'Pending Review',
        description: 'Notes awaiting AI processing',
        fileName: 'Pending Review.base',
        content: PENDING_REVIEW_TEMPLATE,
        category: 'default'
    },
    {
        name: 'Content by Type',
        description: 'Notes grouped by content type',
        fileName: 'Content by Type.base',
        content: CONTENT_BY_TYPE_TEMPLATE,
        category: 'default'
    },
    {
        name: 'Processing Errors',
        description: 'Track failed processing attempts',
        fileName: 'Processing Errors.base',
        content: PROCESSING_ERRORS_TEMPLATE,
        category: 'default'
    },
    // Persona templates
    {
        name: 'Study Notes',
        description: 'Academic notes with Student persona',
        fileName: 'Study Notes.base',
        content: STUDENT_NOTES_TEMPLATE,
        category: 'persona',
        personaId: 'student',
        icon: 'graduation-cap'
    },
    {
        name: 'Executive Briefings',
        description: 'Business-focused summaries with Executive persona',
        fileName: 'Executive Briefings.base',
        content: EXECUTIVE_BRIEFINGS_TEMPLATE,
        category: 'persona',
        personaId: 'executive',
        icon: 'briefcase'
    },
    {
        name: 'Casual Reads',
        description: 'Fun, conversational summaries with Casual persona',
        fileName: 'Casual Reads.base',
        content: CASUAL_READS_TEMPLATE,
        category: 'persona',
        personaId: 'casual',
        icon: 'smile'
    },
    {
        name: 'Research Papers',
        description: 'Academic research with Researcher persona',
        fileName: 'Research Papers.base',
        content: RESEARCH_PAPERS_TEMPLATE,
        category: 'persona',
        personaId: 'researcher',
        icon: 'microscope'
    },
    {
        name: 'Tech Documentation',
        description: 'Developer-focused notes with Technical persona',
        fileName: 'Tech Documentation.base',
        content: TECH_DOCS_TEMPLATE,
        category: 'persona',
        personaId: 'technical',
        icon: 'code'
    }
];

/**
 * Get template by name
 */
export function getTemplateByName(name: string): DashboardTemplate | undefined {
    return DASHBOARD_TEMPLATES.find(t => t.name === name);
}

/**
 * Get all template names
 */
export function getTemplateNames(): string[] {
    return DASHBOARD_TEMPLATES.map(t => t.name);
}

/**
 * Get templates by category
 */
export function getTemplatesByCategory(category: DashboardCategory): DashboardTemplate[] {
    return DASHBOARD_TEMPLATES.filter(t => t.category === category);
}

