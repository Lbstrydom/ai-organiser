/**
 * Minutes JSON Schema Validator (Phase 1)
 * Deterministic post-LLM validation for MinutesJSON.
 * DD-2: Returns issues, not exceptions.
 * DD-3: Auto-fixes where safe, flags where not.
 */

import type { MinutesJSON, Action, Decision, Risk, NotablePoint, OpenQuestion, DeferredItem, GTDProcessing, GTDAction } from '../prompts/minutesPrompts';
import type { ValidationResult, ValidationIssue } from './types';
import { LOW_CONFIDENCE_WARN_RATIO, VALID_GTD_CONTEXTS } from './constants';

export interface MinutesValidationOptions {
    useGTD?: boolean;
    participants?: string[];
}

/**
 * Validate a parsed MinutesJSON against its schema at runtime.
 * Checks: metadata, actions, decisions, participants, cross-refs, GTD, confidence.
 * Auto-fixes: missing IDs, empty owners → 'TBC', out-of-bounds agenda refs, invalid GTD contexts.
 */
export function validateMinutesJSON(
    json: MinutesJSON,
    options?: MinutesValidationOptions
): ValidationResult<MinutesJSON> {
    const issues: ValidationIssue[] = [];
    const data = structuredClone(json);

    // --- Metadata ---
    validateMetadata(data, issues);

    // --- Participants ---
    validateParticipants(data, issues);

    // --- Actions ---
    validateActions(data, issues);

    // --- Decisions ---
    validateDecisions(data, issues);

    // --- Risks ---
    validateRisks(data, issues);

    // --- Notable Points ---
    validateNotablePoints(data, issues);

    // --- Open Questions ---
    validateOpenQuestions(data, issues);

    // --- Deferred Items ---
    validateDeferredItems(data, issues);

    // --- Cross-reference: owners against participants ---
    if (options?.participants && options.participants.length > 0) {
        crossRefOwners(data, options.participants, issues);
    }

    // --- GTD validation ---
    if (options?.useGTD && data.gtd_processing) {
        validateGTD(data.gtd_processing, issues);
    }

    // --- Confidence audit ---
    auditConfidence(data, issues);

    return {
        valid: !issues.some(i => i.severity === 'error'),
        data,
        issues
    };
}

// --- Metadata ---

function validateMetadata(data: MinutesJSON, issues: ValidationIssue[]): void {
    if (!data.metadata) {
        issues.push({ severity: 'error', field: 'metadata', message: 'Missing metadata object' });
        return;
    }
    if (!data.metadata.title || !data.metadata.title.trim()) {
        issues.push({ severity: 'warning', field: 'metadata.title', message: 'Meeting title is empty' });
    }
    if (!data.metadata.date || !data.metadata.date.trim()) {
        issues.push({ severity: 'warning', field: 'metadata.date', message: 'Meeting date is empty' });
    } else if (!isParseableDate(data.metadata.date)) {
        issues.push({ severity: 'warning', field: 'metadata.date', message: `Meeting date '${data.metadata.date}' is not parseable` });
    }
    if (!data.metadata.start_time) {
        issues.push({ severity: 'info', field: 'metadata.start_time', message: 'Start time not set' });
    }
    if (!data.metadata.end_time) {
        issues.push({ severity: 'info', field: 'metadata.end_time', message: 'End time not set' });
    }
}

// --- Participants ---

function validateParticipants(data: MinutesJSON, issues: ValidationIssue[]): void {
    if (!Array.isArray(data.participants) || data.participants.length === 0) {
        issues.push({ severity: 'warning', field: 'participants', message: 'No participants listed' });
        return;
    }
    for (let i = 0; i < data.participants.length; i++) {
        if (!data.participants[i].name || !data.participants[i].name.trim()) {
            issues.push({ severity: 'warning', field: `participants[${i}].name`, message: 'Participant name is empty' });
        }
    }
}

// --- Actions ---

function validateActions(data: MinutesJSON, issues: ValidationIssue[]): void {
    if (!Array.isArray(data.actions)) {
        data.actions = [];
        return;
    }

    const seenIds = new Set<string>();
    const agendaLength = Array.isArray(data.agenda) ? data.agenda.length : 0;

    for (let i = 0; i < data.actions.length; i++) {
        const action = data.actions[i];

        // Auto-fix: missing ID
        if (!action.id) {
            action.id = `A${i + 1}`;
            issues.push({ severity: 'info', field: `actions[${i}].id`, message: `Generated ID '${action.id}'`, autoFixed: true });
        }

        // Duplicate ID
        if (seenIds.has(action.id)) {
            issues.push({ severity: 'error', field: `actions[${i}].id`, message: `Duplicate action ID '${action.id}'` });
        }
        seenIds.add(action.id);

        // Auto-fix: empty owner
        if (!action.owner || !action.owner.trim()) {
            action.owner = 'TBC';
            issues.push({ severity: 'warning', field: `actions[${i}].owner`, message: `Action '${action.id}' has no owner — set to 'TBC'`, autoFixed: true });
        }

        // Empty text
        if (!action.text || !action.text.trim()) {
            issues.push({ severity: 'error', field: `actions[${i}].text`, message: `Action '${action.id}' has empty text` });
        }

        // Due date validation — required field per MinutesJSON schema
        if (!action.due_date || !action.due_date.trim()) {
            issues.push({ severity: 'warning', field: `actions[${i}].due_date`, message: `Action '${action.id}' has no due_date` });
        } else if (action.due_date !== 'TBC' && !isParseableDate(action.due_date)) {
            issues.push({ severity: 'warning', field: `actions[${i}].due_date`, message: `Action '${action.id}' has unparseable due_date '${action.due_date}'` });
        }

        // Agenda item ref validation
        if (action.agenda_item_ref != null && agendaLength > 0) {
            if (typeof action.agenda_item_ref === 'number' && (action.agenda_item_ref < 1 || action.agenda_item_ref > agendaLength)) {
                issues.push({ severity: 'warning', field: `actions[${i}].agenda_item_ref`, message: `Action '${action.id}' agenda_item_ref ${action.agenda_item_ref} out of bounds (1-${agendaLength})`, autoFixed: true });
                action.agenda_item_ref = null;
            }
        }
    }
}

// --- Decisions ---

function validateDecisions(data: MinutesJSON, issues: ValidationIssue[]): void {
    if (!Array.isArray(data.decisions)) {
        data.decisions = [];
        return;
    }

    const seenIds = new Set<string>();

    for (let i = 0; i < data.decisions.length; i++) {
        const decision = data.decisions[i];

        // Auto-fix: missing ID
        if (!decision.id) {
            decision.id = `D${i + 1}`;
            issues.push({ severity: 'info', field: `decisions[${i}].id`, message: `Generated ID '${decision.id}'`, autoFixed: true });
        }

        // Duplicate ID
        if (seenIds.has(decision.id)) {
            issues.push({ severity: 'error', field: `decisions[${i}].id`, message: `Duplicate decision ID '${decision.id}'` });
        }
        seenIds.add(decision.id);

        // Empty text
        if (!decision.text || !decision.text.trim()) {
            issues.push({ severity: 'error', field: `decisions[${i}].text`, message: `Decision '${decision.id}' has empty text` });
        }
    }
}

// --- Risks ---

function validateRisks(data: MinutesJSON, issues: ValidationIssue[]): void {
    if (!Array.isArray(data.risks)) {
        data.risks = [];
        return;
    }
    for (let i = 0; i < data.risks.length; i++) {
        if (!data.risks[i].id) {
            data.risks[i].id = `R${i + 1}`;
            issues.push({ severity: 'info', field: `risks[${i}].id`, message: `Generated ID '${data.risks[i].id}'`, autoFixed: true });
        }
    }
}

// --- Notable Points ---

function validateNotablePoints(data: MinutesJSON, issues: ValidationIssue[]): void {
    if (!Array.isArray(data.notable_points)) {
        data.notable_points = [];
        return;
    }
    for (let i = 0; i < data.notable_points.length; i++) {
        if (!data.notable_points[i].id) {
            data.notable_points[i].id = `N${i + 1}`;
            issues.push({ severity: 'info', field: `notable_points[${i}].id`, message: `Generated ID '${data.notable_points[i].id}'`, autoFixed: true });
        }
    }
}

// --- Open Questions ---

function validateOpenQuestions(data: MinutesJSON, issues: ValidationIssue[]): void {
    if (!Array.isArray(data.open_questions)) {
        data.open_questions = [];
        return;
    }
    for (let i = 0; i < data.open_questions.length; i++) {
        if (!data.open_questions[i].id) {
            data.open_questions[i].id = `Q${i + 1}`;
            issues.push({ severity: 'info', field: `open_questions[${i}].id`, message: `Generated ID '${data.open_questions[i].id}'`, autoFixed: true });
        }
    }
}

// --- Deferred Items ---

function validateDeferredItems(data: MinutesJSON, issues: ValidationIssue[]): void {
    if (!Array.isArray(data.deferred_items)) {
        data.deferred_items = [];
        return;
    }
    for (let i = 0; i < data.deferred_items.length; i++) {
        if (!data.deferred_items[i].id) {
            data.deferred_items[i].id = `P${i + 1}`;
            issues.push({ severity: 'info', field: `deferred_items[${i}].id`, message: `Generated ID '${data.deferred_items[i].id}'`, autoFixed: true });
        }
    }
}

// --- Cross-reference owners against participants ---

function crossRefOwners(data: MinutesJSON, participantNames: string[], issues: ValidationIssue[]): void {
    const normalizedNames = new Set(participantNames.map(n => n.toLowerCase().trim()));

    // Check action owners
    for (const action of (data.actions || [])) {
        if (action.owner && action.owner !== 'TBC') {
            if (!normalizedNames.has(action.owner.toLowerCase().trim())) {
                issues.push({
                    severity: 'warning',
                    field: `actions.${action.id}.owner`,
                    message: `Action owner '${action.owner}' not found in participant list`
                });
            }
        }
    }

    // Check GTD waiting_for
    if (data.gtd_processing?.waiting_for) {
        for (const item of data.gtd_processing.waiting_for) {
            if (item.waiting_on && !normalizedNames.has(item.waiting_on.toLowerCase().trim())) {
                issues.push({
                    severity: 'warning',
                    field: 'gtd_processing.waiting_for',
                    message: `Waiting-on person '${item.waiting_on}' not found in participant list`
                });
            }
        }
    }
}

// --- GTD Validation ---

function validateGTD(gtd: GTDProcessing, issues: ValidationIssue[]): void {
    if (!Array.isArray(gtd.next_actions)) {
        issues.push({ severity: 'warning', field: 'gtd_processing.next_actions', message: 'GTD next_actions is not an array' });
        return;
    }

    const validContexts = new Set<string>(VALID_GTD_CONTEXTS as readonly string[]);

    for (let i = 0; i < gtd.next_actions.length; i++) {
        const action = gtd.next_actions[i];
        if (action.context && !validContexts.has(action.context)) {
            issues.push({
                severity: 'warning',
                field: `gtd_processing.next_actions[${i}].context`,
                message: `Invalid GTD context '${action.context}' — stripped`,
                autoFixed: true
            });
            action.context = '';
        }
    }

    if (Array.isArray(gtd.waiting_for)) {
        for (let i = 0; i < gtd.waiting_for.length; i++) {
            if (!gtd.waiting_for[i].waiting_on || !gtd.waiting_for[i].waiting_on.trim()) {
                issues.push({
                    severity: 'warning',
                    field: `gtd_processing.waiting_for[${i}].waiting_on`,
                    message: 'Waiting-for item has empty waiting_on'
                });
            }
        }
    }
}

// --- Confidence Audit ---

function auditConfidence(data: MinutesJSON, issues: ValidationIssue[]): void {
    type HasConfidence = { confidence?: string };
    const allItems: HasConfidence[] = [
        ...(data.actions || []),
        ...(data.decisions || []),
        ...(data.risks || []),
        ...(data.notable_points || []),
        ...(data.open_questions || [])
    ];

    if (allItems.length === 0) return;

    const lowCount = allItems.filter(item => item.confidence === 'low').length;
    if (lowCount / allItems.length > LOW_CONFIDENCE_WARN_RATIO) {
        issues.push({
            severity: 'info',
            field: 'confidence',
            message: `${lowCount}/${allItems.length} items are low-confidence — consider human review`
        });
    }
}

// --- Helpers ---

function isParseableDate(dateStr: string): boolean {
    if (!dateStr) return false;
    // Accept ISO dates, YYYY-MM-DD, and common formats
    const d = new Date(dateStr);
    return !isNaN(d.getTime());
}
