/**
 * Hand-back, the vault side: read an AI hand-back note, freeze its items in the journal, suggest a project, and apply what the
 * person ticks. Decisions and questions become ONE reviewed edit to the project note; next actions become rows in the sweep
 * review (the same destinations, dates and lists as any sweep item). Nothing is applied that is not ticked.
 *
 * Each write is idempotent at its own boundary (an `aio:handoff id=` marker in the note; the sweep's own item identity), the
 * journal records intent before the write, and an applied item is never applied again. Work on one hand-back is serialised, and
 * the journal record is re-read from settings before every change (no snapshot is held across an await).
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
import { itemKeys } from '../inboxSweep/sweepItemIdentity';
import type { NoteProposals } from '../inboxSweep/sweepService';
import type { SweepItem } from '../prompts/sweepPrompts';
import { logger } from '../../utils/logger';
import { addUnderHeading, appliedIds } from './handoffNoteEdit';
import { freeze, prune, recoverApplying, setState, withProject, type HandbackRecord, type ItemState } from './handbackJournal';
import { handbackIdOf, itemId, parseHandoff, type HandoffItem, type HandoffParse } from './handoffParser';
import { mappingKey, rankProjects, type MatchResult } from './handoffMatch';
import { aiWorkspacesActive, getWorkspace } from './workspaceService';

export const DECISIONS_HEADING = 'Decisions';
export const QUESTIONS_HEADING = 'Open questions';

/** One parsed item with its frozen id and journal state. */
export interface ReviewItem {
    id: string;
    item: HandoffItem;
    state: ItemState;
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

// ─── One hand-back at a time; the journal record is always read fresh ────────────────────────────

const locks = new WeakMap<object, Map<string, Promise<unknown>>>();

/** Run `fn` after every earlier operation on the same hand-back, whatever their outcome. Other hand-backs are not held up. */
function serial<T>(plugin: AIOrganiserPlugin, id: string, fn: () => Promise<T>): Promise<T> {
    let byId = locks.get(plugin);
    if (!byId) { byId = new Map(); locks.set(plugin, byId); }
    const run = (byId.get(id) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => undefined, () => undefined);
    byId.set(id, tail);
    void tail.then(() => { if (byId?.get(id) === tail) byId.delete(id); });
    return run;
}

/** Change one record: read it now, transform it, save it. */
async function update(plugin: AIOrganiserPlugin, id: string, change: (current: HandbackRecord | undefined) => HandbackRecord): Promise<HandbackRecord> {
    const next = change(plugin.settings.aiHandbacks[id]);
    plugin.settings.aiHandbacks = prune({ ...plugin.settings.aiHandbacks, [id]: next });
    await plugin.saveSettings();
    return next;
}

const sectionItems = (p: HandoffParse): HandoffItem[] => [...p.decisions, ...p.actions, ...p.deliverables, ...p.questions];

/** Read the note, freeze its items, and suggest a project. Writes only the journal. */
export function prepareHandback(plugin: AIOrganiserPlugin, file: TFile): Promise<Result<PreparedHandback>> {
    return handbackIdOfFile(plugin, file).then((first) => {
        if (!first.ok) return err(first.error);
        return serial(plugin, first.value.id, () => prepareUnsafe(plugin, file, first.value.text, first.value.id));
    });
}

async function handbackIdOfFile(plugin: AIOrganiserPlugin, file: TFile): Promise<Result<{ id: string; text: string }>> {
    try {
        if (!handbackActive(plugin)) return err('unknown');
        const text = await plugin.app.vault.read(file);
        return ok({ text, id: await handbackIdOf(text) });
    } catch (e) {
        logger.error('AiWorkspaces', 'Could not read the hand-back', e);
        return err('unknown');
    }
}

async function prepareUnsafe(plugin: AIOrganiserPlugin, file: TFile, text: string, id: string): Promise<Result<PreparedHandback>> {
    try {
        const parse = parseHandoff(text, resolveSweepContexts(plugin.settings));
        const items: ReviewItem[] = [];
        const ids: Array<{ id: string; section: HandoffItem['section'] }> = [];
        for (const item of sectionItems(parse)) {
            const itemKey = await itemId(id, item);
            ids.push({ id: itemKey, section: item.section });
            items.push({ id: itemKey, item, state: 'pending' });
        }
        // Items are frozen the first time the review opens; a re-read never changes a frozen hand-back. Nothing else is applying
        // here (the work on one hand-back is serialised), so an `applying` item is an interrupted one and goes back to pending.
        const record = await update(plugin, id, (current) => recoverApplying(freeze(current, id, file.path, new Date().toISOString(), ids)));
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

/** What the sweep review committed: the identity keys of every task it really saved. Null = nothing was saved. */
export type ReviewActions = (notes: NoteProposals[], contexts: readonly string[], projectId: string) => Promise<{ tasks: ReadonlyArray<{ keys?: string[] }> } | null>;

export interface ApplyOutcome {
    applied: number;
    failed: number;
    /** Items left pending because the person declined a preview */
    declined: number;
    error?: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

/** The evidence quoted in the sweep review: the item's text plus its own id, so two actions with the same words stay two items. */
const actionEvidence = (text: string, id: string): string => `${text} (hand-back item ${id})`;

/** Apply what is ticked. Never throws; a failed item never blocks the others. */
export function applyHandback(plugin: AIOrganiserPlugin, prepared: PreparedHandback, choice: HandbackChoice, reviewActions: ReviewActions): Promise<Result<ApplyOutcome>> {
    return serial(plugin, prepared.id, () => applyUnsafe(plugin, prepared, choice, reviewActions));
}

async function applyUnsafe(plugin: AIOrganiserPlugin, prepared: PreparedHandback, choice: HandbackChoice, reviewActions: ReviewActions): Promise<Result<ApplyOutcome>> {
    try {
        if (!handbackActive(plugin)) return err('unknown');
        const service = getProjectService(plugin);
        const project = service?.resolveProject(choice.projectId);
        if (!project?.ok) return err(project ? project.error : 'project-not-found');
        const noteFile = plugin.app.vault.getAbstractFileByPath(prepared.notePath);
        if (!(noteFile instanceof TFile)) return err('project-not-found');
        const projectFile = plugin.app.vault.getAbstractFileByPath(project.value.notePath);
        if (!(projectFile instanceof TFile)) return err('project-not-found');

        const frozen = prepared.items.map((i) => ({ id: i.id, section: i.item.section }));
        const previousProject = plugin.settings.aiHandbacks[prepared.id]?.projectId;
        await update(plugin, prepared.id, (cur) => withProject(freeze(cur, prepared.id, prepared.notePath, new Date().toISOString(), frozen), choice.projectId));
        const stateOf = (id: string): ItemState => plugin.settings.aiHandbacks[prepared.id]?.items[id]?.state ?? 'pending';
        const set = (id: string, state: ItemState, error?: string): Promise<HandbackRecord> => update(plugin, prepared.id, (cur) => setState(cur ?? freeze(undefined, prepared.id, prepared.notePath, '', frozen), id, state, error));
        const todo = (section: HandoffItem['section']): ReviewItem[] => prepared.items.filter((i) => i.item.section === section && choice.ticked.has(i.id) && stateOf(i.id) !== 'applied');
        const outcome: ApplyOutcome = { applied: 0, failed: 0, declined: 0 };

        // 1. Decisions and questions: ONE reviewed edit to the project note.
        let decisions = todo('decisions');
        let questions = todo('questions');
        // A write interrupted earlier may have reached the project this hand-back was applied to BEFORE the person changed it:
        // an item whose marker is already in either project note is done.
        const notes: string[] = [await plugin.app.vault.read(projectFile)];
        if (previousProject && previousProject !== choice.projectId) {
            const earlier = service?.resolveProject(previousProject);
            const earlierFile = earlier?.ok ? plugin.app.vault.getAbstractFileByPath(earlier.value.notePath) : null;
            if (earlierFile instanceof TFile) notes.push(await plugin.app.vault.read(earlierFile));
        }
        const already = new Set(notes.flatMap((n) => [...appliedIds(n, [...decisions, ...questions].map((i) => i.id))]));
        for (const i of [...decisions, ...questions]) if (already.has(i.id)) { await set(i.id, 'applied'); outcome.applied++; }
        decisions = decisions.filter((i) => !already.has(i.id));
        questions = questions.filter((i) => !already.has(i.id));

        if (decisions.length + questions.length > 0) {
            for (const i of [...decisions, ...questions]) await set(i.id, 'applying');
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
                if (res.ok) { await set(i.id, 'applied'); outcome.applied++; }
                else if (res.error === 'rejected') { await set(i.id, 'pending'); outcome.declined++; }
                else { await set(i.id, 'failed', res.error); outcome.failed++; }
            }
            if (!res.ok && res.error !== 'rejected') outcome.error = res.error;
        }

        if (choice.rememberChat && prepared.parse.chat) {
            plugin.settings.aiWorkspaceChatMap = { ...plugin.settings.aiWorkspaceChatMap, [mappingKey(prepared.parse.chat)]: choice.projectId };
            await plugin.saveSettings();
        }

        // 2. Next actions: rows in the sweep review, with the project already linked.
        const actions = todo('actions');
        if (actions.length > 0) {
            for (const i of actions) await set(i.id, 'applying');
            const text = await plugin.app.vault.read(noteFile);
            const contexts = resolveSweepContexts(plugin.settings);
            const items: SweepItem[] = actions.map((i) => {
                const a = i.item as HandoffParse['actions'][number];
                // A stated date is kept in the task's own words as well: a list that needs no date would otherwise drop it.
                const words = a.due ? `${a.text} (due ${a.due})` : a.text;
                return {
                    kind: a.waiting ? 'waiting_for' : 'next_action',
                    text: words,
                    context: a.contexts[0] ?? '',
                    ...(a.waiting ? { waitingOn: a.waiting } : {}),
                    evidence: actionEvidence(a.text, i.id),
                    ...(a.due ? { due: a.due } : {}),
                };
            });
            const proposals: NoteProposals = { path: noteFile.path, contentHash: await sha256Hex(new TextEncoder().encode(text).buffer), items, dropped: 0, truncated: false };
            const decided = await reviewActions([proposals], contexts, choice.projectId);
            // Applied = the review saved a task carrying this item's own identity (its quote includes the item id); anything else stays pending.
            const saved = new Set((decided?.tasks ?? []).flatMap((t) => t.keys ?? []));
            for (const [n, i] of actions.entries()) {
                const mine = itemKeys({ text: items[n].text, evidence: items[n].evidence });
                if (mine.some((k) => saved.has(k))) { await set(i.id, 'applied'); outcome.applied++; }
                else { await set(i.id, 'pending'); outcome.declined++; }
            }
        }
        return ok(outcome);
    } catch (e) {
        logger.error('AiWorkspaces', 'Could not apply the hand-back', e);
        return err('unknown');
    }
}
