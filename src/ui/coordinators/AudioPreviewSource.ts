/**
 * Audio preview URL resolution + cleanup (plan §1.5 R1 M2).
 *
 * Maps any `AudioSource` to a playable `<audio>` `src=` URL plus an explicit
 * disposal hook. Vault and desktop sources need no cleanup; blob-backed
 * sources require `URL.revokeObjectURL` when the host modal closes — otherwise
 * the object URL leaks for the lifetime of the renderer process.
 *
 * Caller contract (the `AudioAttachCoordinator`, F1 next step):
 *  - Call `resolvePreview(source, app)` to obtain `{ url, dispose }`.
 *  - Track every handle in `cleanups[]`.
 *  - In `Modal.onClose()`, call `dispose()` on each handle.
 *
 * NOTE: `AudioPreviewHandle` is INTENTIONALLY a live resource handle (not
 * serializable UI state) — the coordinator owns the lifecycle. The speaker
 * review panel receives it as a render-time argument, never embeds it in
 * `SpeakerReviewState` (Gemini-r1 M1 / R3 M1).
 */

import type { App } from 'obsidian';
import type { AudioSource } from '../components/speakerReviewState';

/**
 * A playable preview URL plus its cleanup hook. The `url` is safe to use as
 * `<audio src="${handle.url}">` directly; HTML5 time fragments (`#t=12,17`)
 * may be appended by the panel for per-speaker scrub clips.
 */
export interface AudioPreviewHandle {
    /** URL safe to bind to `<audio src="...">` */
    url: string;
    /**
     * Release any resources backing `url`. Idempotent — calling twice is a no-op.
     * For object-URL-backed handles this calls `URL.revokeObjectURL(url)`.
     */
    dispose(): void;
}

/**
 * Resolve any `AudioSource` to a playable `<audio>` URL.
 *
 * Kind-specific behaviour:
 *  - `vault`: `app.vault.getResourcePath(file)` — already a stable Obsidian
 *    resource URI. No cleanup required.
 *  - `desktop-path`: `file://` URL prefix. No cleanup required. Note: some
 *    Electron security configurations may block `file://` in renderer
 *    `<audio>`; the caller should handle a playback error gracefully.
 *  - `webview-blob` / `recorder`: `URL.createObjectURL(blob)`. MUST be revoked
 *    when no longer needed.
 */
export function resolvePreview(source: AudioSource, app: App): AudioPreviewHandle {
    switch (source.kind) {
        case 'vault': {
            const url = app.vault.getResourcePath(source.file);
            return { url, dispose: noop };
        }
        case 'desktop-path': {
            const url = absolutePathToFileUrl(source.absolutePath);
            return { url, dispose: noop };
        }
        case 'webview-blob':
        case 'recorder': {
            const url = URL.createObjectURL(source.blob);
            let disposed = false;
            return {
                url,
                dispose: () => {
                    if (disposed) return;
                    disposed = true;
                    try {
                        URL.revokeObjectURL(url);
                    } catch {
                        // Browser already revoked it or URL.createObjectURL was a no-op
                        // (jsdom / non-browser env) — safe to swallow.
                    }
                },
            };
        }
    }
}

function noop(): void {
    // No-op disposer for handles that own no transient resources.
}

/**
 * Convert a desktop absolute path (Windows `C:\foo\bar.m4a` or POSIX
 * `/foo/bar.m4a`) into a `file://` URL `<audio>` can play.
 */
function absolutePathToFileUrl(absolutePath: string): string {
    // Windows: backslashes → forward slashes, prepend `file:///` (three slashes
    // because the drive letter takes the place of host).
    if (/^[A-Za-z]:[\\/]/.test(absolutePath)) {
        const forward = absolutePath.replace(/\\/g, '/');
        return `file:///${encodeURI(forward)}`;
    }
    // POSIX: prepend `file://` (two slashes, then leading `/`).
    return `file://${encodeURI(absolutePath)}`;
}
