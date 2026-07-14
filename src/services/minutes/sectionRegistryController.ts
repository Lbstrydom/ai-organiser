/**
 * Section registry controller — canonical home for topic CRUD (D2, R1-H1, R1-M2).
 *
 * Pure logic with no Obsidian deps so it is fully unit-testable.
 * Used by:
 *   - MinutesCreationModal (state, "+ Add topic" header button)
 *   - SectionAssignmentSelect (dropdown options + "+ New topic" creation flow)
 *   - DocumentMultiPickerModal (dropdown options)
 *   - multiSegmentMinutes orchestrator (section name resolution)
 */

import { err, ok, type Result } from '../../core/result';

export interface TopicRecord {
    id: string;
    name: string;
    createdAt: number;
}

export class SectionRegistryController {
    static readonly GENERAL_ID = 'general';
    static readonly GENERAL_NAME = 'General discussion';
    static readonly MAX_NAME_LENGTH = 40;
    static readonly MAX_DISPLAY_LENGTH = 20;

    private topics: TopicRecord[] = [];

    /** Add a topic. Returns Result with the created TopicRecord or an error. */
    addTopic(displayName: string): Result<TopicRecord> {
        const trimmed = displayName.trim();
        if (!trimmed) return err('Topic name cannot be empty');
        if (trimmed.length > SectionRegistryController.MAX_NAME_LENGTH) {
            return err(`Topic name must be ${SectionRegistryController.MAX_NAME_LENGTH} characters or fewer`);
        }

        // Duplicate-name disambiguation: "Sales" → "Sales (2)" if "Sales" already exists.
        let name = trimmed;
        let suffix = 2;
        const isTaken = (candidate: string): boolean =>
            this.topics.some((t) => t.name.toLowerCase() === candidate.toLowerCase());
        while (isTaken(name)) {
            name = `${trimmed} (${suffix++})`;
        }

        const record: TopicRecord = {
            id: `topic-${this.makeId()}`,
            name,
            createdAt: Date.now(),
        };
        this.topics.push(record);
        return ok(record);
    }

    /** Remove a topic by id. Reserved id 'general' cannot be removed. */
    removeTopic(id: string): Result<void> {
        if (id === SectionRegistryController.GENERAL_ID) {
            return err('Cannot remove the reserved General section');
        }
        const before = this.topics.length;
        this.topics = this.topics.filter((t) => t.id !== id);
        if (this.topics.length === before) {
            return err(`Topic not found: ${id}`);
        }
        return ok(undefined);
    }

    /**
     * Resolve a section id to a record. Unknown ids fall back to General
     * (defensive — handles deleted-topic-while-row-references-it).
     */
    resolveSection(id: string): { id: string; name: string } {
        if (id === SectionRegistryController.GENERAL_ID) {
            return { id: SectionRegistryController.GENERAL_ID, name: SectionRegistryController.GENERAL_NAME };
        }
        const match = this.topics.find((t) => t.id === id);
        if (match) return { id: match.id, name: match.name };
        return { id: SectionRegistryController.GENERAL_ID, name: SectionRegistryController.GENERAL_NAME };
    }

    /**
     * Prune topics that have zero assigned items across all sources.
     * Caller supplies a count function so the registry stays decoupled
     * from documents/audio/transcripts state.
     *
     * Returns the IDs of pruned topics.
     */
    pruneEmptyTopics(getCount: (id: string) => number): string[] {
        const removed: string[] = [];
        this.topics = this.topics.filter((t) => {
            const count = getCount(t.id);
            if (count <= 0) {
                removed.push(t.id);
                return false;
            }
            return true;
        });
        return removed;
    }

    /** Returns a defensive copy of the topics list. */
    listTopics(): TopicRecord[] {
        return this.topics.map((t) => ({ ...t }));
    }

    hasTopics(): boolean {
        return this.topics.length > 0;
    }

    /** Truncate name for chip display per MAX_DISPLAY_LENGTH. */
    static displayLabel(name: string): string {
        if (name.length <= SectionRegistryController.MAX_DISPLAY_LENGTH) return name;
        return name.slice(0, SectionRegistryController.MAX_DISPLAY_LENGTH - 1) + '…';
    }

    private makeId(): string {
        // crypto.randomUUID with base36 fallback (matches canvasUtils.generateId convention).
        try {
            const c = window.crypto as Crypto | undefined;
            if (c && typeof c.randomUUID === 'function') {
                return c.randomUUID();
            }
        } catch {
            /* fall through */
        }
        return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
}
