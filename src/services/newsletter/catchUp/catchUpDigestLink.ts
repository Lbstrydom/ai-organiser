/**
 * The Digest's pointer to the current catch-up episode.
 *
 * The episode lives in `Catch-up/`, which the person never opens unprompted; the daily Digest is the
 * note they read. One owned, marker-delimited block directly under the Digest's H1 links the current
 * episode and says whether it was heard:
 *
 *   <!-- ai-organiser:catchup-link:start -->
 *   🎧 **Catch-up audio:** [[<path>|Catch-up 2026-11-10 to 2026-11-14]] · new
 *   <!-- ai-organiser:catchup-link:end -->
 *
 * Decisions:
 *  - "Current" = the episode whose narrated range ends latest (`findLatestNarratedEpisode`); a newer
 *    episode REPLACES the link in place, an older remake never moves it backwards.
 *  - The state follows the durable ack ("heard"), so Mark listened / playing it flips `new` to `heard`.
 *  - A block is inserted into today's digest and the episode's last day; elsewhere in the window an
 *    existing block is only UPDATED (a stale "new" must not outlive the listen), never added.
 *  - Never touches anything outside the markers; a malformed marker pair (duplicate, unpaired, inverted)
 *    refuses the digest rather than guessing. Best effort: a failed or protected write is logged and
 *    skipped, it never fails the episode (the episode note is the coverage record).
 *  - Off (audio off, or `daily` mode) = no read, no write: byte-identical.
 */

import { TFile, normalizePath, type App, type Plugin } from 'obsidian';
import { ok, err, type Result } from '../../../core/result';
import { assertWritable } from '../../../core/protectedPaths';
import { getNewsletterOutputFullPath, type AIOrganiserSettings } from '../../../core/settings';
import { isFeatureEnabled } from '../../featureService';
import { logger } from '../../../utils/logger';
import { isCatchUpEnabled } from '../newsletterAudioMode';
import { getBucketDateStr, getDigestPath } from '../newsletterService';
import { effectiveLookbackDays, windowDates } from './catchUpCoverage';
import { loadAcks } from './catchUpDraft';
import { findLatestNarratedEpisode } from './catchUpEpisode';
import type { EpisodeMeta } from './catchUpTypes';

export const LINK_START = '<!-- ai-organiser:catchup-link:start -->';
export const LINK_END = '<!-- ai-organiser:catchup-link:end -->';

export interface DigestLinkText {
    label: string;
    stateNew: string;
    stateHeard: string;
}

export interface DigestLinkDeps {
    app: App;
    plugin: Plugin;
    settings: AIOrganiserSettings;
    now?: () => Date;
    text: DigestLinkText;
    /** Compare-and-commit note write (the plugin's applyNoteEdit); a baseline mismatch is an error. */
    writeNote: (path: string, baseline: string, next: string) => Promise<Result<void>>;
}

/** The block for one episode. Pure. */
export function renderLinkBlock(episode: Pick<EpisodeMeta, 'from' | 'to' | 'notePath'>, heard: boolean, text: DigestLinkText): string {
    const target = episode.notePath.replace(/\.md$/i, '');
    const range = episode.from === episode.to ? episode.from : `${episode.from} to ${episode.to}`;
    const state = heard ? text.stateHeard : text.stateNew;
    return `${LINK_START}\n🎧 **${text.label}:** [[${target}|Catch-up ${range}]] · ${state}\n${LINK_END}`;
}

function frontmatterEnd(content: string): number {
    const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
    return m ? m[0].length : 0;
}

/** Offset just after the first H1 line outside code, or the frontmatter end when there is none. */
function insertionPoint(content: string): number {
    const from = frontmatterEnd(content);
    let offset = from;
    let fence: string | null = null;
    for (const raw of content.slice(from).split('\n')) {
        const lineEnd = offset + raw.length + 1;
        const fenceOpen = /^[ \t]*(`{3,}|~{3,})/.exec(raw);
        if (fence === null && fenceOpen) fence = fenceOpen[1][0];
        else if (fence !== null && new RegExp(`^[ \\t]*\\${fence}{3,}[ \\t\\r]*$`).test(raw)) fence = null;
        else if (fence === null && /^# \S/.test(raw)) return Math.min(lineEnd, content.length);
        offset = lineEnd;
    }
    return from;
}

/**
 * The digest text with the block set. `insert: false` only updates an existing block. Err when the
 * markers are not exactly one well-formed pair (nothing is guessed), ok(null-equivalent = same text)
 * when there is nothing to do.
 */
export function applyLinkBlock(content: string, block: string, insert: boolean): Result<string> {
    const starts = content.split(LINK_START).length - 1;
    const ends = content.split(LINK_END).length - 1;
    if (starts !== ends || starts > 1) return err('digest-link-markers-invalid');
    if (starts === 1) {
        const a = content.indexOf(LINK_START);
        const b = content.indexOf(LINK_END);
        if (b < a) return err('digest-link-markers-invalid');
        return ok(content.slice(0, a) + block + content.slice(b + LINK_END.length));
    }
    if (!insert) return ok(content);
    const at = insertionPoint(content);
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const b = block.replaceAll('\n', eol);
    const before = content.slice(0, at);
    const after = content.slice(at);
    const lead = before.length === 0 || before.endsWith('\n') ? '' : eol;
    return ok(`${before}${lead}${eol}${b}${eol}${after.startsWith('\n') || after.startsWith('\r') || after === '' ? '' : eol}${after}`);
}

/**
 * Bring the current episode's link up to date in the window's digests. Never throws.
 * `insertDates` get the block if they lack it; every other window digest is only updated when it has one.
 */
export async function refreshDigestCatchUpLinks(deps: DigestLinkDeps, insertDates: readonly string[] = []): Promise<number> {
    try {
        const { settings, app } = deps;
        if (!isFeatureEnabled(settings, 'newsletter') || !isCatchUpEnabled(settings)) return 0;
        const outputRoot = getNewsletterOutputFullPath(settings);
        const episode = await findLatestNarratedEpisode(app, outputRoot);
        if (!episode) return 0;
        const acks = await loadAcks(deps.plugin);
        const heard = episode.id in acks || episode.audioRemoved !== undefined;
        const block = renderLinkBlock(episode, heard, deps.text);

        const now = (deps.now ?? (() => new Date()))();
        const today = getBucketDateStr(now, settings.newsletterBriefCutoffHour ?? 6, settings.newsletterBriefCutoffMinute ?? 0);
        const lookback = effectiveLookbackDays(settings.newsletterCatchUpLookbackDays, settings.newsletterRetentionDays ?? 30);
        const inserting = new Set([today, episode.to, ...insertDates]);
        const dates = new Set([...windowDates(today, lookback), ...inserting]);

        let written = 0;
        for (const date of dates) {
            const file = app.vault.getAbstractFileByPath(normalizePath(getDigestPath(outputRoot, date)));
            if (!(file instanceof TFile)) continue;
            if (!assertWritable(settings, 'modify', file.path).ok) continue;
            const current = await app.vault.read(file);
            const next = applyLinkBlock(current, block, inserting.has(date));
            if (!next.ok) { logger.warn('Newsletter', `Digest ${file.path} has malformed catch-up link markers; left untouched`); continue; }
            if (next.value === current) continue;
            const res = await deps.writeNote(file.path, current, next.value);
            if (res.ok) written++;
            else logger.warn('Newsletter', `Could not link the catch-up episode from ${file.path}`, res.error);
        }
        return written;
    } catch (e) {
        logger.warn('Newsletter', 'Catch-up digest link refresh failed', e);
        return 0;
    }
}
