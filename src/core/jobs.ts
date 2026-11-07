/**
 * Guided jobs (docs/plans/navigation-discoverability.md, decision 7): thin entry points that
 * collect an input, show what is needed, and hand off to the existing flow. Data only; the
 * modal (src/ui/modals/GuidedJobModal.ts) evaluates the rows and starts the flow.
 */

/** A row of the job's checklist. */
export type JobPrerequisite =
    /** An action that must be ready (feature on, setup done). Remedy: turn it on or set it up. */
    | { readonly kind: 'action'; readonly actionId: string; readonly fixActionId?: string }
    /** The inbox sweep has at least one inbox folder. Remedy: its setup. */
    | { readonly kind: 'inbox-folders'; readonly fixActionId: string };

export type JobId = 'meeting-minutes' | 'process-inbox';

export interface JobDef {
    readonly id: JobId;
    readonly icon: string;
    /** What the job asks for before it starts. */
    readonly input: 'audio-file' | 'none';
    /** Every one must be ready before Continue is enabled. */
    readonly required: readonly JobPrerequisite[];
    /** Shown as "Optional"; never blocks. */
    readonly optional: readonly JobPrerequisite[];
}

export const JOBS: readonly JobDef[] = Object.freeze([
    {
        id: 'meeting-minutes',
        icon: 'clipboard-list',
        input: 'audio-file',
        required: [{ kind: 'action', actionId: 'create-meeting-minutes' }],
        optional: [],
    },
    {
        id: 'process-inbox',
        icon: 'inbox',
        input: 'none',
        required: [
            { kind: 'action', actionId: 'sweep-inbox', fixActionId: 'setup-inbox-sweep' },
            { kind: 'inbox-folders', fixActionId: 'setup-inbox-sweep' },
        ],
        optional: [{ kind: 'action', actionId: 'send-tasks-to-google', fixActionId: 'setup-google-tasks' }],
    },
] satisfies JobDef[]);

export const JOB_BY_ID: ReadonlyMap<string, JobDef> = new Map(JOBS.map((j) => [j.id, j]));

/** A row's state as the modal shows it. */
export type RowState = 'ready' | 'feature-off' | 'needs-setup' | 'unavailable';

export interface JobCheck {
    readonly prerequisite: JobPrerequisite;
    readonly state: RowState;
    readonly optional: boolean;
}

/**
 * Pure: evaluate every row, and whether the job can start. Continue needs every REQUIRED row
 * ready and, for an input job, an input chosen; optional rows never block.
 */
export function evaluateJob(
    job: JobDef,
    rowState: (p: JobPrerequisite) => RowState,
    inputChosen: boolean,
): { rows: JobCheck[]; canStart: boolean } {
    const rows: JobCheck[] = [
        ...job.required.map((p) => ({ prerequisite: p, state: rowState(p), optional: false })),
        ...job.optional.map((p) => ({ prerequisite: p, state: rowState(p), optional: true })),
    ];
    const requiredReady = rows.every((r) => r.optional || r.state === 'ready');
    return { rows, canStart: requiredReady && (job.input === 'none' || inputChosen) };
}
