/**
 * Icon registry — the SINGLE source of truth for presentation icons, shared by
 * the IR renderers (`irToHtml`, `irToPptx`), the IR prompt (`irPrompts`), and
 * the legacy brand sprite (`brandThemeService` imports from here — dependency
 * inverted so `presentationIr` stays self-contained with no `chat` import).
 *
 * Pure data + a pure resolver. No Obsidian, no pptxgenjs, no other imports.
 *
 * Plan: docs/plans/presentation-renderer-fidelity.md (D1, D3).
 */

/** Lucide stroke-path data keyed by icon name. `viewBox 0 0 24 24`, stroke-only. */
export const PRESENTATION_ICONS: Record<string, string> = {
    // ── Navigation / Actions ───────────────────────────────────────────────
    'arrow-right':      'M5 12h14M12 5l7 7-7 7',
    'arrow-up-right':   'M7 17L17 7M7 7h10v10',
    'check':            'M20 6L9 17l-5-5',
    'check-circle':     'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3',
    'x':                'M18 6L6 18M6 6l12 12',
    'external-link':    'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3',
    'plus':             'M12 5v14M5 12h14',
    'minus':            'M5 12h14',
    // ── Data / Analytics ───────────────────────────────────────────────────
    'bar-chart':        'M12 20V10M18 20V4M6 20v-4',
    'trending-up':      'M23 6l-9.5 9.5-5-5L1 18',
    'trending-down':    'M23 18l-9.5-9.5-5 5L1 6',
    'pie-chart':        'M21.21 15.89A10 10 0 1 1 8 2.83M22 12A10 10 0 0 0 12 2v10z',
    'activity':         'M22 12h-4l-3 9L9 3l-3 9H2',
    'percent':          'M19 5L5 19M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
    // ── Business / Finance ─────────────────────────────────────────────────
    'dollar-sign':      'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    'briefcase':        'M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2zM16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16',
    'building':         'M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18zM6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2',
    'landmark':         'M3 22h18M6 18v-4M10 18v-4M14 18v-4M18 18v-4M2 10l10-7 10 7',
    // ── People / Team ──────────────────────────────────────────────────────
    'user':             'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    'users':            'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75M9 7a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
    // ── Communication ──────────────────────────────────────────────────────
    'mail':             'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2zM22 6l-10 7L2 6',
    'message-circle':   'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z',
    'phone':            'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z',
    // ── Technology ─────────────────────────────────────────────────────────
    'globe':            'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
    'cpu':              'M18 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM9 9h6v6H9zM9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3',
    'cloud':            'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z',
    'wifi':             'M5 12.55a11 11 0 0 1 14.08 0M1.42 9a16 16 0 0 1 21.16 0M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01',
    'lock':             'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
    'shield':           'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    // ── Content / Media ────────────────────────────────────────────────────
    'file-text':        'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
    'image':            'M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21',
    'video':            'M23 7l-7 5 7 5zM14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z',
    'book-open':        'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
    // ── Science / Nature ───────────────────────────────────────────────────
    'zap':              'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
    'sun':              'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
    'leaf':             'M11 20A7 7 0 0 1 9.8 6.9C15.5 4.9 17 3.5 19 2c1 2 2 4.5 2 8 0 5.5-4.78 10-10 10zM2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12',
    'droplet':          'M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z',
    // ── Objects / Tools ────────────────────────────────────────────────────
    'settings':         'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'tool':             'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
    'calendar':         'M19 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zM16 2v4M8 2v4M3 10h18',
    'clock':            'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
    'map-pin':          'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0zM12 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    // ── Status / Indicators ────────────────────────────────────────────────
    'alert-triangle':   'M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01',
    'info':             'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
    'help-circle':      'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01',
    'star':             'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
    'heart':            'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
    'thumbs-up':        'M14 9V5.5a2.5 2.5 0 0 0-5 0V9M9 22h4a2 2 0 0 0 2-2V9.83a2 2 0 0 0-.59-1.42L9 3M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3',
    // ── Arrows / Process ───────────────────────────────────────────────────
    'refresh-cw':       'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
    'target':           'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    'layers':           'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
    'git-branch':       'M6 3v12M18 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
    'rocket':           'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3M22 2l-7.5 7.5M15 2H22v7',
};

/** Icon names grouped by category for prompt reference. */
export const ICON_CATEGORIES: Record<string, string[]> = {
    'data & analytics':     ['bar-chart', 'trending-up', 'trending-down', 'pie-chart', 'activity', 'percent', 'target'],
    'business & finance':   ['dollar-sign', 'briefcase', 'building', 'landmark'],
    'people & team':        ['user', 'users'],
    'communication':        ['mail', 'message-circle', 'phone'],
    'technology':           ['globe', 'cpu', 'cloud', 'wifi', 'lock', 'shield'],
    'content & media':      ['file-text', 'image', 'video', 'book-open'],
    'science & nature':     ['zap', 'sun', 'leaf', 'droplet'],
    'objects & tools':      ['settings', 'tool', 'calendar', 'clock', 'map-pin'],
    'status & indicators':  ['check', 'check-circle', 'x', 'alert-triangle', 'info', 'help-circle', 'star', 'heart', 'thumbs-up'],
    'arrows & process':     ['arrow-right', 'arrow-up-right', 'external-link', 'plus', 'minus', 'refresh-cw', 'layers', 'git-branch', 'rocket'],
};

/** Build the icon-reference block injected into the IR generation prompt. */
export function buildIconReference(): string {
    return Object.entries(ICON_CATEGORIES)
        .map(([category, names]) => `  ${category}: ${names.join(', ')}`)
        .join('\n');
}

/** True when `name` is a known registry icon. */
export function isKnownIcon(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(PRESENTATION_ICONS, name);
}

/**
 * Curated emoji → icon-name map so PERSISTED decks (authored when the prompt
 * asked for emoji) upgrade to vector icons instead of being dropped. Covers the
 * emoji the old prompt suggested plus the common board/finance set. Anything
 * not here resolves to `none` — in BOTH renderers (the symmetry guarantee).
 */
export const LEGACY_EMOJI_MAP: Record<string, string> = {
    '📈': 'trending-up', '📉': 'trending-down', '📊': 'bar-chart', '🎯': 'target',
    '💰': 'dollar-sign', '💵': 'dollar-sign', '💼': 'briefcase', '🏢': 'building',
    '🏭': 'building', '🏛️': 'landmark', '🏛': 'landmark', '⚖️': 'landmark', '⚖': 'landmark',
    '🌍': 'globe', '🌐': 'globe', '⚡': 'zap', '🚀': 'rocket', '☁️': 'cloud', '☁': 'cloud',
    '🔒': 'lock', '🛡️': 'shield', '🛡': 'shield', '👤': 'user', '👥': 'users',
    '📅': 'calendar', '⏰': 'clock', '⏱️': 'clock', '⏱': 'clock', '📍': 'map-pin',
    '✅': 'check-circle', '☑️': 'check-circle', '✔️': 'check', '❌': 'x', '➕': 'plus', '➖': 'minus',
    '⚠️': 'alert-triangle', '⚠': 'alert-triangle', 'ℹ️': 'info', '⭐': 'star', '❤️': 'heart', '👍': 'thumbs-up',
    '📋': 'file-text', '🧾': 'file-text', '📄': 'file-text', '📧': 'mail', '📞': 'phone', '💬': 'message-circle',
    '🔥': 'activity', '🌞': 'sun', '☀️': 'sun', '🍃': 'leaf', '🌿': 'leaf', '💧': 'droplet',
    '🔧': 'tool', '⚙️': 'settings', '⚙': 'settings', '🖥️': 'cpu', '📶': 'wifi', '🖼️': 'image', '🎬': 'video', '📖': 'book-open',
};

/** Result of interpreting an IR `icon` field — consumed IDENTICALLY by both
 *  renderers so an icon is present-or-absent symmetrically (plan D3). There is
 *  no `emoji` variant: emoji map to a vector name or to `none`, never raw. */
export type ResolvedIcon = { kind: 'svg'; name: string } | { kind: 'none' };

/**
 * The ONE place an IR `icon` field is interpreted. Order: exact registry name
 * → curated legacy emoji → none. Pure; no side effects.
 */
export function resolvePresentationIcon(input: string | undefined | null): ResolvedIcon {
    if (!input) return { kind: 'none' };
    const trimmed = input.trim();
    // Normalise common LLM variance: casing, spaces/underscores → hyphens, and a
    // leading `icon-`/`icon_`/`icon ` prefix (audit M18). Emoji are matched on
    // the RAW trimmed value (normalisation would mangle them).
    const norm = trimmed.toLowerCase().replace(/^icon[-_ ]/, '').replace(/[\s_]+/g, '-');
    if (isKnownIcon(norm)) return { kind: 'svg', name: norm };
    const mapped = LEGACY_EMOJI_MAP[trimmed];
    if (mapped && isKnownIcon(mapped)) return { kind: 'svg', name: mapped };
    return { kind: 'none' };
}
