/**
 * Hand-back, the vault side: read an AI hand-back note, freeze its items in the journal, suggest a project, and apply what the
 * person ticks. Decisions and questions become ONE reviewed edit to the project note; next actions become rows in the sweep
 * review (the same destinations, dates and lists as any sweep item). Nothing is applied that is not ticked.
 *
 * Each write is idempotent at its own boundary (an `aio:handoff id=` marker in the note; the sweep's own item identity), the
 * journal records intent before the write, and an applied item is never applied again.
 */
import { TFile } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { Result, ok, err } from '../../core/result';
import { isFeatureEnabled } from '../featureService';
import { applyNoteEdit } from '../noteEdit/applyNoteEdit';
import { getProjectService } from '../projects/projectService';
import type { ProjectRef } from '../projects/projectIndex';
import { sha256Hex } from '../attachmentDuplicateService';
import { resolveSweepContexts } from '../inboxSweep/sweepContexts';
import type { NoteProposals } from '../inboxSweep/sweepService';
import type { SweepItem } from '../prompts/sweepPrompts';
import { logger } from '../../utils/logger';
import { addUnderHeading } from './handoffNoteEdit';
import { freeze, prune, recoverApplying, setState, withProject, type HandbackRecord } from './handbackJournal';
import { handbackIdOf, itemId, parseHandoff, type HandoffItem, type HandoffParse } from './handoffParser';
import { mappingKey, rankProjects, type MatchResult } from './handoffMatch';
import { aiWorkspacesActive, getWorkspace } from './workspaceService';

export const DECISIONS_HEADING = 'Decisions';
export const QUESTIONS_HEADING = 'Open questions';

/** One parsed item with its frozen id and journal state. */
export interface ReviewItem {
    id: string;
    item: HandoffItem;
    state: HandbackRecord['items'][string]['state'];
}

export interface PreparedHandback {
    id: string;
    notePath: string;
    parse: HandoffParse;
    match: MatchResult;
    /** Every adoptable project (duplicated ids left out), for the picker when the suggestion is not right */
    projects: ProjectRef[];
    items: ReviewItem[];
}

/** The hand-back gate: `ai-workspaces` and `capture-inbox` must both be on. With either off the review does not exist. */
export const handbackActive = (plugin: AIOrganiserPlugin): boolean =>
    aiWorkspacesActive(plugin) && isFeatureEnabled(plugin.settings, 'capture-inbox');

async function saveJournal(plugin: AIOrganiserPlugin, record: HandbackRecord): Promise<void> {
    plugin.settings.aiHandbacks = prune({ ...plugin.settings.aiHandbacks, [record.id]: record });
    await plugin.saveSettings();
}

const sectionItems = (p: HandoffParse): HandoffItem[] => [...p.decisions, ...p.actions, ...p.deliverables, ...p.questions];

/** Read the note, freeze its items, and suggest a project. Writes only the journal. */
export async function prepareHandback(plugin: AIOrganiserPlugin, file: TFile): Promise<Result<PreparedHandback>> {
    try {
        if (!handbackActive(plugin)) return err('unknown');
        const text = await plugin.app.vault.read(file);
        const parse = parseHandoff(text, resolveSweepContexts(plugin.settings));
        const id = await handbackIdOf(text);
        const items: ReviewItem[] = [];
        const ids: Array<{ id: string; section: HandoffItem['section'] }> = [];
        for (const item of sectionItems(parse)) {
            const itemKey = await itemId(id, item);
            ids.push({ id: itemKey, section: item.section });
            items.push({ id: itemKey, item, state: 'pending' });
        }
        // Items are frozen the first time the review opens; a re-read never changes a frozen hand-back.
        const record = recoverApplying(freeze(plugin.settings.aiHandbacks[id], id, file.path, new Date().toISOString(), ids));
        await saveJournal(plugin, record);
        for (const r of items) r.state = record.items[r.id]?.state ?? 'pending';

        const service = getProjectService(plugin);
        if (!service) return err('unknown');
        const index = service.index();
        const cache = plugin.app.metadataCache.getFileCache(file);
        const title = (cache?.headings?.find((h) => h.level === 1)?.heading ?? file.basename);
        const match = rankProjects(
            { ...(parse.projectId ? { projectId: parse.projectId } : {}), ...(parse.chat ? { chat: parse.chat } : {}), title, fileName: file.basename, subfolder: file.parent?.name ?? '' },
            {
                candidates: index.projects.map((project) => ({ project, chatNames: getWorkspace(plugin, project.aioId).chats.map((c) => c.name) })),
                duplicates: new Set(index.duplicates.keys()),
                chatMap: plugin.settings.aiWorkspaceChatMap,
            },
        );
        return ok({ id, notePath: file.path, parse, match, projects: index.projects.filter((p) => !index.duplicates.has(p.aioId)), items });
    } catch (e) {
        logger.error('AiWorkspaces', 'Could not read the hand-back', e);
        return err('unknown');
    }
}

export interface HandbackChoice {
    projectId: string;
    /** Ticked item ids */
    ticked: ReadonlySet<string>;
    /** Remember "this chat project is that project" */
    rememberChat: boolean;
}

/** The sweep review, supplied by the command layer (the service does not open windows). */
export type ReviewActions = (notes: NoteProposals[], contexts: readonly string[], projectId: string) => Promise<{ tasks: ReadonlyArray<{ text: string }> } | null>;

export interface ApplyOutcome {
    applied: number;
    failed: number;
    /** Items left pending because the person declined a preview */
    declined: number;
    error?: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

/** Apply what is ticked. Never throws; a failed item never blocks the others. */
export async function applyHandback(plugin: AIOrganiserPlugin, prepared: PreparedHandback, choice: HandbackChoice, reviewActions: ReviewActions): Promise<Result<ApplyOutcome>> {
    try {
        if (!handbackActive(plugin)) return err('unknown');
        const service = getProjectService(plugin);
        const project = service?.resolveProject(choice.projectId);
        if (!project?.ok) return err(project ? project.error : 'project-not-found');
        const noteFile = plugin.app.vault.getAbstractFileByPath(prepared.notePath);
        if (!(noteFile instanceof TFile)) return err('project-not-found');
        const projectFile = plugin.app.vault.getAbstractFileByPath(project.value.notePath);
        if (!(projectFile instanceof TFile)) return err('project-not-found');

        let record = withProject(plugin.settings.aiHandbacks[prepared.id] ?? freeze(undefined, prepared.id, prepared.notePath, new Date().toISOString(), prepared.items.map((i) => ({ id: i.id, section: i.item.section }))), choice.projectId);
        const todo = (section: HandoffItem['section']): ReviewItem[] => prepared.items.filter((i) => i.item.section === section && choice.ticked.has(i.id) && record.items[i.id]?.state !== 'applied');
        const outcome: ApplyOutcome = { applied: 0, failed: 0, declined: 0 };

        // 1. Decisions and questions: ONE reviewed edit to the project note.
        const decisions = todo('decisions');
        const questions = todo('questions');
        if (decisions.length + questions.length > 0) {
            for (const i of [...decisions, ...questions]) record = setState(record, i.id, 'applying');
            await saveJournal(plugin, record);
            const link = `[[${noteFile.basename}]]`;
            const decisionLines = decisions.map((i) => {
                const claim = (i.item as { claim?: string }).claim === 'decided' ? 'stated as decided in chat' : 'proposed by AI';
                return { id: i.id, text: `${i.item.text} (decided ${today()}; ${claim}) ${link}` };
            });
            const questionLines = questions.map((i) => ({ id: i.id, text: `${i.item.text} ${link}` }));
            const transform = (current: string): Result<string> => {
                const withDecisions = addUnderHeading(current, DECISIONS_HEADING, decisionLines);
                return withDecisions.ok ? addUnderHeading(withDecisions.value, QUESTIONS_HEADING, questionLines) : withDecisions;
            };
            const baseline = await plugin.app.vault.read(projectFile);
            const first = transform(baseline);
            const res = first.ok
                ? (first.value === baseline
                    ? ok({ content: baseline })
                    : await applyNoteEdit(plugin, { kind: 'composite', filePath: projectFile.path, baseline, recompute: (current) => { const next = transform(current); return next.ok ? ok({ content: next.value }) : err(next.error); } }))
                : err(first.error);
            for (const i of [...decisions, ...questions]) {
                if (res.ok) { record = setState(record, i.id, 'applied'); outcome.applied++; }
                else if (res.error === 'rejected') { record = setState(record, i.id, 'pending'); outcome.declined++; }
                else { record = setState(record, i.id, 'failed', res.error); outcome.failed++; }
            }
            if (!res.ok && res.error !== 'rejected') outcome.error = res.error;
            await saveJournal(plugin, record);
        }

        if (choice.rememberChat && prepared.parse.chat) {
            plugin.settings.aiWorkspaceChatMap = { ...plugin.settings.aiWorkspaceChatMap, [mappingKey(prepared.parse.chat)]: choice.projectId };
            await plugin.saveSettings();
        }

        // 2. Next actions: rows in the sweep review, with the project already linked.
        const actions = todo('actions');
        if (actions.length > 0) {
            for (const i of actions) record = setState(record, i.id, 'applying');
            await saveJournal(plugin, record);
            const text = await plugin.app.vault.read(noteFile);
            const contexts = resolveSweepContexts(plugin.settings);
            const items: SweepItem[] = actions.map((i) => {
                const a = i.item as HandoffParse['actions'][number];
                return {
                    kind: a.waiting ? 'waiting_for' : 'next_action',
                    text: a.text,
                    context: a.contexts[0] ?? '',
                    ...(a.waiting ? { waitingOn: a.waiting } : {}),
                    evidence: a.text,
                    ...(a.due ? { due: a.due } : {}),
                };
            });
            const proposals: NoteProposals = { path: noteFile.path, contentHash: await sha256Hex(new TextEncoder().encode(text).buffer), items, dropped: 0, truncated: false };
            const decided = await reviewActions([proposals], contexts, choice.projectId);
            // Applied = approved in the review (it is then in the sweep record under its own identity); anything else stays pending.
            const approved = new Set((decided?.tasks ?? []).map((t) => t.text));
            actions.forEach((i, n) => {
                if (approved.has(items[n].text)) { record = setState(record, i.id, 'applied'); outcome.applied++; }
                else { record = setState(record, i.id, 'pending'); outcome.declined++; }
            });
            await saveJournal(plugin, record);
        }
        return ok(outcome);
    } catch (e) {
        logger.error('AiWorkspaces', 'Could not apply the hand-back', e);
        return err('unknown');
    }
}
