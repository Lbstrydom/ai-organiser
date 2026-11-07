import { describe, it, expect } from 'vitest';
import { LivePackScheduler, LIVE_CATCH_UP_MS, LIVE_MAX_WAIT_MS } from '../src/services/aiWorkspaces/livePackScheduler';
import type { CandidateSnapshot, LivePackService } from '../src/services/aiWorkspaces/livePackService';
import { ok } from '../src/core/result';

const ID = '3f2b8f4e-1c2d-4e5f-8a6b-7c8d9e0f1a2b';
const MIN = 60_000;

function clock() {
    let now = 0;
    let next = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    return {
        t: { set: (fn: () => void, ms: number) => { const id = next++; timers.set(id, { at: now + ms, fn }); return id; }, clear: (id: number) => { timers.delete(id); }, now: () => now },
        advance(ms: number) {
            const end = now + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                now = due[1].at;
                timers.delete(due[0]);
                due[1].fn();
            }
            now = end;
        },
        size: () => timers.size,
    };
}

const snap = (rev: number, area: string): CandidateSnapshot => ({ aioId: ID, revision: rev, generation: 1, projectPath: 'P/Pkm.md', areaPath: area, contextSources: ['P/Reading.md'], notes: [] });

function fakeService(onRecollect: (svc: { onSnapshot: ((s: CandidateSnapshot) => void) | null }) => void = () => undefined) {
    const refreshed: string[] = [];
    const svc = {
        onSnapshot: null as ((s: CandidateSnapshot) => void) | null,
        ownedProjects: () => [ID],
        refresh: async (id: string) => { refreshed.push(id); return ok({ kind: 'written' as const, snapshot: null }); },
        recollect: async () => { onRecollect(svc); },
    };
    return { svc, refreshed };
}

describe('live pack scheduler', () => {
    it('a burst of changes gives one refresh after the quiet time; other paths do nothing', () => {
        const c = clock();
        const { svc, refreshed } = fakeService();
        const s = new LivePackScheduler(svc as unknown as LivePackService, () => 5 * MIN, c.t);
        s.applySnapshot(snap(1, 'Areas/A.md'));
        s.touched('Elsewhere.md');
        s.touched('P/Reading.md');
        c.advance(2 * MIN);
        s.touched('P/Reading.md');
        c.advance(4 * MIN);
        expect(refreshed).toEqual([]);
        c.advance(1 * MIN);
        expect(refreshed).toEqual([ID]);
    });

    it('continuous editing refreshes at the maximum wait', () => {
        const c = clock();
        const { svc, refreshed } = fakeService();
        const s = new LivePackScheduler(svc as unknown as LivePackService, () => 5 * MIN, c.t);
        s.applySnapshot(snap(1, 'Areas/A.md'));
        for (let t = 0; t < LIVE_MAX_WAIT_MS; t += MIN) { s.touched('P/Reading.md'); c.advance(MIN); }
        expect(refreshed).toEqual([ID]);
    });

    it('a changed area link is watched without a settings save', () => {
        const c = clock();
        const { svc, refreshed } = fakeService((x) => x.onSnapshot?.(snap(2, 'Areas/B.md')));
        const s = new LivePackScheduler(svc as unknown as LivePackService, () => MIN, c.t);
        s.applySnapshot(snap(1, 'Areas/A.md'));
        s.touched('P/Pkm.md'); // the project note changed: its area link now points at B
        c.advance(2 * MIN);
        refreshed.length = 0;
        s.touched('Areas/A.md');
        c.advance(2 * MIN);
        expect(refreshed).toEqual([]);
        s.touched('Areas/B.md');
        c.advance(2 * MIN);
        expect(refreshed).toEqual([ID]);
    });

    it('start reads each project and schedules a catch-up; stop clears every timer', () => {
        const c = clock();
        let reads = 0;
        const { svc, refreshed } = fakeService(() => { reads++; });
        const s = new LivePackScheduler(svc as unknown as LivePackService, () => MIN, c.t);
        s.start();
        expect(reads).toBe(1);
        c.advance(LIVE_CATCH_UP_MS + MIN);
        expect(refreshed).toEqual([ID]);
        s.applySnapshot(snap(1, 'Areas/A.md'));
        s.touched('P/Reading.md');
        s.stop();
        expect(c.size()).toBe(0);
        s.touched('P/Reading.md');
        expect(c.size()).toBe(0);
        expect(svc.onSnapshot).toBeNull();
    });
});
