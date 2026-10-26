/**
 * Saving the sharing settings (the allow-list and the opt-in) one save at a time.
 *
 * They are access control, so a value that did not save must not look applied. Saves never overlap: each queued save persists the
 * values as they are THEN, and remembers them as the last saved state when it succeeds. A save that fails restores the last saved
 * state only if no newer change is waiting; if one is, that newer save (which carries the failed change along with it) is the retry,
 * so an older failure can never undo a newer change. Pure of Obsidian: the three functions are supplied.
 */
export interface Sharing {
    folders: readonly string[];
    optIn: boolean;
}

export interface SharingSaverDeps {
    read(): Sharing;
    write(value: Sharing): void;
    persist(): Promise<void>;
    /** A save that failed with nothing newer waiting: the previous state has been put back */
    onFailed(error: unknown): void;
}

const same = (a: Sharing, b: Sharing): boolean => a.optIn === b.optIn && JSON.stringify(a.folders) === JSON.stringify(b.folders);
const copy = (s: Sharing): Sharing => ({ folders: [...s.folders], optIn: s.optIn });

export class SharingSaver {
    private saved: Sharing;
    private chain: Promise<void> = Promise.resolve();
    private waiting = 0;

    constructor(private readonly deps: SharingSaverDeps) {
        this.saved = copy(deps.read());
    }

    /** The last state that was really saved (or the state at start). */
    get lastSaved(): Sharing { return copy(this.saved); }

    /** Save the current values. Resolves when this save has finished, whatever its outcome. Never rejects. */
    request(): Promise<void> {
        this.waiting++;
        const run = this.chain.then(async () => {
            this.waiting--;
            const attempt = copy(this.deps.read());
            if (same(attempt, this.saved)) return;
            try {
                await this.deps.persist();
                this.saved = attempt;
            } catch (e) {
                if (this.waiting > 0) return; // a newer change is queued: its save carries this one and is the retry
                this.deps.write(copy(this.saved));
                this.deps.onFailed(e);
            }
        });
        this.chain = run.catch(() => undefined);
        return this.chain;
    }
}
