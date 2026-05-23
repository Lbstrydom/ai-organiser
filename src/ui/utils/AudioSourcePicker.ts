/**
 * Platform-aware audio acquisition (plan §1.5 R1 H1).
 *
 * Three adapters, one unified `AudioSource` model:
 *  - `desktop`  — Electron native open dialog (`@electron/remote` via filePickers util)
 *  - `mobileWebview` — hidden `<input type="file" accept="audio/*">` for Obsidian Mobile
 *  - `vault`    — `FuzzySuggestModal<TFile>` filtered to audio extensions
 *
 * Each adapter returns `null` if its platform/capability is unavailable, letting
 * the caller (`AudioAttachCoordinator`, F1 next step) chain fallbacks. The
 * unified `AudioSource` is consumed by `AudioImportService` (F1 next), which
 * normalises every kind into a vault `TFile` before transcription.
 *
 * Why a webview adapter for mobile: the v0 plan's "vault picker fallback"
 * cannot reach `.m4a` files in the phone's gallery — the P0 Pat hit in the
 * persona test. Modern Obsidian Mobile (iOS Safari + Android WebView) both
 * honour programmatic `<input type="file">` clicks against the OS file
 * provider, giving direct device-audio access.
 */

import type { App, TFile } from 'obsidian';
import type { AudioSource } from '../components/speakerReviewState';
import { tryNativeFilePicker, openVaultFilePicker } from './filePickers';
import { logger } from '../../utils/logger';

/** Audio MIME prefixes we accept across all adapters. */
const ACCEPTED_AUDIO_MIME_PREFIX = 'audio/';

/**
 * Bare audio extensions (no leading dot) accepted by the desktop file dialog
 * and used for vault-picker filtering. Mirrors what Whisper handles natively.
 */
export const AUDIO_EXTENSIONS: readonly string[] = [
    'm4a',
    'mp3',
    'mp4',
    'wav',
    'webm',
    'ogg',
    'flac',
    'aac',
];

const AUDIO_EXTENSION_SET: ReadonlySet<string> = new Set(AUDIO_EXTENSIONS);

// ============================================================================
// Desktop adapter — Electron native open dialog
// ============================================================================

/**
 * Open the Electron native file dialog filtered to audio extensions.
 * Returns `null` on mobile or when Electron is unavailable; an empty array
 * when the user cancelled; one or more `AudioSource{kind:'desktop-path'}`
 * entries on success.
 */
export async function pickAudioFromDesktop(options?: {
    multiSelections?: boolean;
}): Promise<AudioSource[] | null> {
    const paths = await tryNativeFilePicker(
        [
            { name: 'Audio Files', extensions: [...AUDIO_EXTENSIONS] },
            { name: 'All Files', extensions: ['*'] },
        ],
        { multiSelections: options?.multiSelections ?? true }
    );
    if (paths === null) return null;
    return paths.map((absolutePath): AudioSource => ({
        kind: 'desktop-path',
        absolutePath,
        displayName: extractFilename(absolutePath),
    }));
}

// ============================================================================
// Mobile webview adapter — hidden <input type="file" accept="audio/*">
// ============================================================================

/**
 * Open a programmatically-triggered file input that lets the user pick audio
 * from their phone's gallery / file provider. Obsidian Mobile's webview honours
 * this on both iOS and Android.
 *
 * Returns a Promise that resolves with the picked audio sources (empty array
 * if the user cancelled) or `null` if `document` is not available (test envs
 * with no DOM).
 *
 * Implementation notes:
 *  - The input element is created, clicked, and removed in the same tick so it
 *    never leaves visible DOM. It IS attached to `document.body` first because
 *    some mobile webviews block `.click()` on detached inputs.
 *  - We listen for `change` to capture the selection and `cancel` (when the
 *    browser surfaces it) plus a `focus` fallback for browsers that don't.
 *  - Each selected `File` is read into a Blob without copying its bytes (the
 *    `File` IS a `Blob`).
 */
export async function pickAudioFromMobileWebview(options?: {
    multiSelections?: boolean;
}): Promise<AudioSource[] | null> {
    if (typeof document === 'undefined') return null;
    const multi = options?.multiSelections ?? true;

    return new Promise<AudioSource[]>((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'audio/*';
        input.multiple = multi;
        // Hide visually but keep it focusable (some mobile webviews refuse to
        // open the picker on `display:none` inputs) — see styles.css.
        input.classList.add('ai-organiser-offscreen-input');

        let settled = false;
        const settle = (sources: AudioSource[]): void => {
            if (settled) return;
            settled = true;
            window.removeEventListener('focus', focusFallback);
            input.remove();
            resolve(sources);
        };

        const focusFallback = (): void => {
            // Defer slightly to let the `change` event fire first if the user
            // actually picked something — only then treat focus return as "cancelled".
            setTimeout(() => {
                if (!settled) settle([]);
            }, 200);
        };

        input.addEventListener('change', () => {
            const files = input.files ? Array.from(input.files) : [];
            const sources = files
                .filter((f) => f.type.startsWith(ACCEPTED_AUDIO_MIME_PREFIX) || hasAudioExtension(f.name))
                .map((f): AudioSource => ({
                    kind: 'webview-blob',
                    blob: f,
                    displayName: f.name,
                    mimeType: f.type || guessMimeFromExtension(f.name),
                }));
            settle(sources);
        });

        // Some mobile browsers fire `cancel` (Chromium ≥113); others do not.
        input.addEventListener('cancel', () => settle([]));

        // Universal fallback — when the OS file picker closes, focus returns
        // to the page. If `change` didn't fire by then, treat as cancel.
        window.addEventListener('focus', focusFallback, { once: true });

        document.body.appendChild(input);
        try {
            input.click();
        } catch (err) {
            logger.warn('AudioSourcePicker', `mobile webview .click() threw: ${String(err)}`);
            settle([]);
        }
    });
}

// ============================================================================
// Vault adapter — FuzzySuggestModal filtered to audio files
// ============================================================================

/**
 * Open the vault file picker filtered to audio extensions. The user picks
 * exactly one file (vault picker is single-select by nature). Returns a
 * Promise resolving to the chosen `AudioSource{kind:'vault'}` or `null`
 * if the user dismissed the modal.
 *
 * NOTE: dismissal detection is best-effort — Obsidian's FuzzySuggestModal
 * does not invoke a "cancel" callback. We resolve with `null` only if the
 * promise is left pending; callers that need certain "cancelled" semantics
 * should layer their own timeout.
 */
export function pickAudioFromVault(app: App): Promise<AudioSource | null> {
    return new Promise<AudioSource | null>((resolve) => {
        let chosen = false;
        openVaultFilePicker(app, {
            predicate: (f: TFile) => isAudioFile(f),
            placeholder: 'Pick an audio file from your vault…',
            onChoose: (file: TFile) => {
                chosen = true;
                resolve({ kind: 'vault', file });
            },
        });
        // Best-effort cancel detection: if the picker closes (focus returns
        // to document.body / activeElement isn't inside our modal) without a
        // choice, resolve null. We use a fairly long timeout because the user
        // may genuinely take time browsing.
        if (typeof document !== 'undefined') {
            const handle = window.setInterval(() => {
                if (chosen) {
                    window.clearInterval(handle);
                    return;
                }
                // No reliable cross-platform "is the modal still open" probe;
                // rely on a 60s ceiling so the promise doesn't leak forever.
            }, 1000);
            window.setTimeout(() => {
                window.clearInterval(handle);
                if (!chosen) resolve(null);
            }, 60_000);
        }
    });
}

// ============================================================================
// Helpers
// ============================================================================

function extractFilename(absolutePath: string): string {
    const parts = absolutePath.split(/[\\/]/);
    return parts[parts.length - 1] || absolutePath;
}

function getExtension(name: string): string {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return '';
    return name.slice(dot + 1).toLowerCase();
}

function hasAudioExtension(name: string): boolean {
    return AUDIO_EXTENSION_SET.has(getExtension(name));
}

export function isAudioFile(file: TFile): boolean {
    return AUDIO_EXTENSION_SET.has(file.extension.toLowerCase());
}

/**
 * Best-effort MIME from extension when the platform didn't tag the File.
 * Used as a fallback only — `File.type` is preferred when present.
 */
export function guessMimeFromExtension(name: string): string {
    const ext = getExtension(name);
    switch (ext) {
        case 'm4a':
        case 'mp4':
            return 'audio/mp4';
        case 'mp3':
            return 'audio/mpeg';
        case 'wav':
            return 'audio/wav';
        case 'webm':
            return 'audio/webm';
        case 'ogg':
            return 'audio/ogg';
        case 'flac':
            return 'audio/flac';
        case 'aac':
            return 'audio/aac';
        default:
            return 'application/octet-stream';
    }
}
