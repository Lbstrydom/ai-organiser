/**
 * Catch-up playback: is a catch-up episode playing RIGHT NOW?
 *
 * A live probe of the audio elements Obsidian is rendering, with no registered callback and no
 * stored state, so it holds in every mode and under the default settings. It exists because
 * retiring an episode (Replace) must never remove a recording the reader is listening to. An
 * answer the probe cannot give is `unknown`, and `unknown` blocks.
 */

import type { App } from 'obsidian';

export type PlaybackProbe = 'playing' | 'idle' | 'unknown';

function safeDecode(value: string): string {
    try { return decodeURIComponent(value); } catch { return value; }
}

/** The lower-cased file name an `<audio>` source points at (query and fragment stripped), or ''. */
function basenameOf(src: string): string {
    const path = safeDecode(src.replace(/[?#].*$/, '')).replaceAll('\\', '/');
    return (path.split('/').pop() ?? '').toLowerCase();
}

/** Every document that can hold a player: the main window and each popout that hosts a leaf. */
function documentsOf(app: App): Document[] {
    const docs = new Set<Document>();
    // The window the person is in; `activeDocument` is Obsidian's popout-aware global (absent outside the app).
    if (typeof activeDocument !== 'undefined') docs.add(activeDocument);
    const workspace = app.workspace as { iterateAllLeaves?: (cb: (leaf: { containerEl?: HTMLElement }) => void) => void } | undefined;
    workspace?.iterateAllLeaves?.((leaf) => {
        const doc = leaf.containerEl?.ownerDocument;
        if (doc) docs.add(doc);
    });
    return [...docs];
}

/**
 * `playing` when any player in any window is actively playing a source whose file name is
 * `audioName`; `idle` when none is; `unknown` when the probe cannot look at all.
 */
export function probeEpisodePlaying(app: App, audioName: string): PlaybackProbe {
    try {
        const docs = documentsOf(app);
        if (docs.length === 0) return 'unknown';
        const wanted = audioName.toLowerCase();
        let unidentified = false;
        for (const doc of docs) {
            for (const player of Array.from(doc.querySelectorAll('audio'))) {
                if (player.paused || player.ended) continue;
                const src = player.currentSrc || player.src || '';
                const name = basenameOf(src);
                if (name === wanted) return 'playing';
                // Something is playing that this probe cannot name (a blob or stream, no file name): it might be this episode.
                if (name === '' || /^(blob|data|mediastream):/i.test(src)) unidentified = true;
            }
        }
        return unidentified ? 'unknown' : 'idle';
    } catch {
        return 'unknown';
    }
}
