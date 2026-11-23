/**
 * Pins the shared self-hosted host lock in architectural-drift.yml.
 *
 * This box runs ai-organiser's and storyline's runners side by side. The lock steps keep
 * their jobs from running at the same time; if a later edit drops or weakens one, the host
 * still looks protected while nothing holds it. These assertions fail on that edit instead.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

interface Step {
    name?: string;
    id?: string;
    if?: string;
    run?: string;
    uses?: string;
    'continue-on-error'?: boolean;
    env?: Record<string, string>;
}

const ACQUIRE = 'Take the shared host lock';
const REQUEUE = 'Requeue if the host lock was busy';
const RELEASE = 'Release the shared host lock';

// sha256 of the two run bodies, identical to storyline's copy. Changing either body means
// changing it in BOTH repos; update these only together with storyline's.
const ACQUIRE_SHA = '56f3d4f957e3acf43b84d10d478ed6856018c08f5cea54c9172b87357fc2c388';
const RELEASE_SHA = '5b07f140821ace0da8158e5c949122d8d351d64fcbae5321c7fa41744fe5278a';

const sha = (s: string | undefined) => createHash('sha256').update(s ?? '').digest('hex');

function loadDrift() {
    const text = readFileSync(join(__dirname, '..', '.github', 'workflows', 'architectural-drift.yml'), 'utf8');
    const wf = load(text) as {
        permissions: Record<string, string>;
        jobs: { drift: { 'timeout-minutes': number; 'runs-on': string; env?: Record<string, string>; steps: Step[] } };
    };
    return { wf, job: wf.jobs.drift, steps: wf.jobs.drift.steps };
}

describe('architectural-drift host lock', () => {
    it('takes the lock as the very first step, before checkout', () => {
        const { steps } = loadDrift();
        expect(steps[0].name).toBe(ACQUIRE);
        expect(steps[0].id).toBe('lock');
        expect(steps[0].if).toBeUndefined();
        // continue-on-error is deliberate here: a busy lock requeues instead of failing.
        expect(steps[0]['continue-on-error']).toBe(true);
    });

    it('releases the lock as the very last step, always', () => {
        const { steps } = loadDrift();
        const last = steps[steps.length - 1];
        expect(last.name).toBe(RELEASE);
        expect(last.if).toBe('always()');
        expect(last['continue-on-error']).toBeUndefined();
        expect(steps.filter((s) => s.name === RELEASE)).toHaveLength(1);
        expect(steps.filter((s) => s.name === ACQUIRE)).toHaveLength(1);
    });

    it('keeps both lock bodies identical to the shared snippet', () => {
        const { steps } = loadDrift();
        expect(sha(steps.find((s) => s.name === ACQUIRE)?.run)).toBe(ACQUIRE_SHA);
        expect(sha(steps.find((s) => s.name === RELEASE)?.run)).toBe(RELEASE_SHA);
    });

    it('requeues only when the lock step failed, right after it', () => {
        const { steps, wf } = loadDrift();
        expect(steps[1].name).toBe(REQUEUE);
        expect(steps[1].if).toBe("steps.lock.outcome == 'failure'");
        expect(steps[1].run).toContain('$max  = 3');
        expect(wf.permissions.actions).toBe('write');
    });

    it('gates every work step on holding the lock', () => {
        const { steps } = loadDrift();
        const work = steps.slice(2, -1);
        expect(work.length).toBeGreaterThan(5);
        for (const s of work) {
            // A step either needs the lock directly, or depends on the drift step, which does.
            const gated =
                s.if?.includes("steps.lock.outcome == 'success'") || s.if?.includes('steps.drift.');
            expect(gated, `step "${s.name}" runs without the host lock`).toBe(true);
        }
        expect(steps.find((s) => s.id === 'drift')?.if).toBe("steps.lock.outcome == 'success'");
    });

    it('keeps the lock wait inside the job timeout', () => {
        const { job } = loadDrift();
        expect(job['timeout-minutes']).toBe(30);
        expect(job.env?.HOST_LOCK_WAIT_MINUTES).toBe("${{ inputs.lock_wait_minutes || '12' }}");
    });

    it('requeues only on the busy flag the acquire step sets', () => {
        const { steps } = loadDrift();
        const rq = steps[1];
        expect(rq.env?.LOCK_RESULT).toBe('${{ steps.lock.outputs.HOST_LOCK_RESULT }}');
        const run = rq.run ?? '';
        // The busy check must come before anything that could dispatch a new run.
        const busyCheck = run.indexOf("if ($env:LOCK_RESULT -ne 'busy')");
        expect(busyCheck).toBeGreaterThan(-1);
        expect(busyCheck).toBeLessThan(run.indexOf('gh workflow run'));
    });
});

// Runs the requeue step's own text. Both paths exit before any dispatch, so no network.
// Scoped to the REQUEUE step on purpose. Do not extend it to the acquire step: its staleness
// check is Get-CimInstance Win32_Process, which does not exist on CI's ubuntu runner, so an
// acquire test here would skip or fail for the wrong reason and still read as coverage. The
// acquire is exercised by the shared snippet's own pwsh-7 harness on the Windows host.
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;
describe.skipIf(!hasPwsh)('requeue step behaviour (pwsh)', () => {
    const runRequeue = (env: Record<string, string>) => {
        const body = loadDrift().steps[1].run ?? '';
        return spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', body], {
            encoding: 'utf8',
            env: { ...process.env, ATTEMPT: '1', LOCK_WAIT: '12', LOCK_RESULT: '', GH_TOKEN: '', ...env },
        });
    };

    it('a broken lock (no busy flag) fails red and is NOT requeued', () => {
        const r = runRequeue({ LOCK_RESULT: '' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('other than a busy lock');
        expect(r.stdout).not.toContain('requeued as attempt');
    });

    it('a busy lock on the last attempt fails red and gives up', () => {
        const r = runRequeue({ LOCK_RESULT: 'busy', ATTEMPT: '3' });
        expect(r.status).toBe(1);
        expect(r.stdout).toContain('attempt 3 of 3');
        expect(r.stdout).not.toContain('requeued as attempt');
    });
});
