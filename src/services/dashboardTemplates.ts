/**
 * Dashboard Templates
 * Built-in templates for .base file generation
 */

export interface DashboardTemplate {
    name: string;
    description: string;
    fileName: string;
    content: string;
}

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
    {
        name: 'General Knowledge Base',
        description: 'All processed notes with status tracking',
        fileName: 'Knowledge Base.base',
        content: GENERAL_KNOWLEDGE_BASE_TEMPLATE
    },
    {
        name: 'Research Tracker',
        description: 'Research notes and web summaries',
        fileName: 'Research Tracker.base',
        content: RESEARCH_TRACKER_TEMPLATE
    },
    {
        name: 'Pending Review',
        description: 'Notes awaiting AI processing',
        fileName: 'Pending Review.base',
        content: PENDING_REVIEW_TEMPLATE
    },
    {
        name: 'Content by Type',
        description: 'Notes grouped by content type',
        fileName: 'Content by Type.base',
        content: CONTENT_BY_TYPE_TEMPLATE
    },
    {
        name: 'Processing Errors',
        description: 'Track failed processing attempts',
        fileName: 'Processing Errors.base',
        content: PROCESSING_ERRORS_TEMPLATE
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
