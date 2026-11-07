import { describe, it, expect } from 'vitest';
import { JOBS, JOB_BY_ID, evaluateJob, type JobPrerequisite, type RowState } from '../src/core/jobs';
import { ACTION_BY_ID } from '../src/core/actionRegistry';
import { en } from '../src/i18n/en';

const allReady = (): RowState => 'ready';

describe('the two guided jobs', () => {
    it('every action a job names, and every fix, is a registered action; every job has copy', () => {
        for (const job of JOBS) {
            for (const p of [...job.required, ...job.optional]) {
                if (p.kind === 'action') expect(ACTION_BY_ID.has(p.actionId), p.actionId).toBe(true);
                if (p.fixActionId) expect(ACTION_BY_ID.has(p.fixActionId), p.fixActionId).toBe(true);
            }
            expect(en.jobs[job.id].title.length).toBeGreaterThan(0);
        }
    });

    it('meeting recording to minutes needs a recording before it can start', () => {
        const job = JOB_BY_ID.get('meeting-minutes')!;
        expect(evaluateJob(job, allReady, false).canStart).toBe(false);
        expect(evaluateJob(job, allReady, true).canStart).toBe(true);
    });

    it('process my inbox: the sweep and inbox folders are required, Google Tasks is optional', () => {
        const job = JOB_BY_ID.get('process-inbox')!;
        const tasksOff = (p: JobPrerequisite): RowState => (p.kind === 'action' && p.actionId === 'send-tasks-to-google' ? 'feature-off' : 'ready');
        const r = evaluateJob(job, tasksOff, false);
        expect(r.canStart).toBe(true);
        expect(r.rows.find((x) => x.prerequisite.kind === 'action' && x.prerequisite.actionId === 'send-tasks-to-google')!.optional).toBe(true);
        const noFolders = (p: JobPrerequisite): RowState => (p.kind === 'inbox-folders' ? 'needs-setup' : 'ready');
        expect(evaluateJob(job, noFolders, false).canStart).toBe(false);
        const sweepOff = (p: JobPrerequisite): RowState => (p.kind === 'action' && p.actionId === 'sweep-inbox' ? 'feature-off' : 'ready');
        expect(evaluateJob(job, sweepOff, false).canStart).toBe(false);
    });
});
