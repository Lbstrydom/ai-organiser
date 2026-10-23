/**
 * Catch-up orchestration — one episode, from a frozen plan to a committed note.
 *
 * State machine (each transition is persisted to the operation record BEFORE the next side
 * effect):
 *
 *   planned (in memory)
 *     -> scripted        script written; the record is created and holds the COMPLETE resumable
 *                        state (script + the coverage it claims)
 *     -> audio-writing   the record names the reserved audio path, THEN the file is written
 *     -> audio-ready     set only after the writer finished and size + sha256 were recorded
 *     -> COMMIT          create the episode note (idempotent by operation id)
 *     -> record cleared
 *
 * Everything impure — the LLM, the TTS engine, the prompt — is injected through `CatchUpPorts`,
 * so the protocol (ordering, recovery, cancellation, admission) is tested without any of them.
 */

import { normalizePath, type App, type Plugin } from 'obsidian';
import { ok, err, type Result } from '../../../core/result';
import { getNewsletterOutputFullPath, type AIOrganiserSettings } from '../../../core/settings';
import { logger } from '../../../utils/logger';
import type { TtsEngine } from '../../tts/ttsEngine';
import { sha256Hex } from '../../tts/fingerprint';
import {
    computeEpisodeFingerprint,
    generateEpisodeAudio as realGenerateEpisodeAudio,
    verifyEpisodeAudio as realVerifyEpisodeAudio,
} from '../newsletterAudioService';
import { getAudioMode } from '../newsletterAudioMode';
import { buildCatchUpSnapshot, type CatchUpSnapshot } from './catchUpSelection';
import {
    audioFileName,
    episodeFolderPath,
    findEpisodeByOpId,
    generateOpId,
    isAudioReferenced,
    isInsideOutputRoot,
    trashOwnedFile,
    writeEpisodeNote,
} from './catchUpEpisode';
import {
    clearOperation,
    isRecordExpired,
    loadOperation,
    saveOperation,
    type FrozenEntry,
    type OperationRecord,
    RECORD_SCHEMA_VERSION,
} from './catchUpDraft';
import { SCRIPT_OVERRUN_FACTOR, SPEAKING_CHARS_PER_SECOND, type CatchUpPlan, type CoverageMap } from './catchUpTypes';

// ── Ports ────────────────────────────────────────────────────────────────────

export interface TtsHandle {
    engine: TtsEngine;
    providerId: string;
    modelId: string;
}

export type TtsResolution = { ok: true; tts: TtsHandle } | { ok: false; code: string };

export interface CatchUpPorts {
    app: App;
    plugin: Plugin;
    settings: AIOrganiserSettings;
    now?: () => Date;
    random?: () => number;
    /** Resolve the TTS engine. A failure carries a guidance code (the caller already showed any notice). */
    resolveTts: () => Promise<TtsResolution>;
    /** Write the spoken script for a frozen plan. */
    generateScript: (plan: CatchUpPlan, signal?: AbortSignal) => Promise<Result<string>>;
    /** Shorten an over-long script to roughly `wordBudget` words. */
    shortenScript: (plan: CatchUpPlan, script: string, wordBudget: number, signal?: AbortSignal) => Promise<Result<string>>;
    /** Overridable for tests; defaults to the real episode synthesiser. */
    synthesise?: typeof realGenerateEpisodeAudio;
    verifyAudio?: typeof realVerifyEpisodeAudio;
    /** Fired after any change a surface (status bar, modal) should re-read. */
    onChanged?: () => void;
}

export type RunPhase =
    | { key: 'freezing' }
    | { key: 'writingScript' }
    | { key: 'shorteningScript' }
    | { key: 'synthesising'; done: number; total: number }
    | { key: 'saving' };

export type OverrunChoice = 'continue' | 'shorten' | 'cancel';

export interface RunOptions {
    signal?: AbortSignal;
    onPhase?: (phase: RunPhase) => void;
    /** The reporter's cancel switch: set false once the commit starts. */
    setCancellable?: (cancellable: boolean) => void;
    /** Interactive runs may ask; automatic runs never overrun. */
    interactive: boolean;
    /** Interactive only: what to do about a script that is still over its limit. */
    confirmOverrun?: (info: { estimatedMinutes: number; capMinutes: number }) => Promise<OverrunChoice>;
    /** The plan hash the user saw in the preview; a different one at Generate means the world changed. */
    previewHash?: string;
    /** Automatic runs only consider CLOSED buckets. */
    kind?: 'manual' | 'auto';
}

export interface EpisodeResult {
    opId: string;
    notePath: string;
    audioPath: string;
    minutes: number;
    from: string;
    to: string;
    days: number;
    sources: number;
    created: boolean;
}

// ── Single-flight ────────────────────────────────────────────────────────────

let running = false;

/** True while an episode is being made in this plugin instance. */
export function isCatchUpRunning(): boolean {
    return running;
}

async function withLock<T>(fn: () => Promise<Result<T>>): Promise<Result<T>> {
    if (running) return err('catchup-busy');
    running = true;
    try {
        return await fn();
    } finally {
        running = false;
    }
}

/** Test-only. */
export function __resetCatchUpLockForTests(): void {
    running = false;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function countWords(text: string): number {
    const t = text.trim();
    return t === '' ? 0 : t.split(/\s+/).length;
}

export function estimateMinutes(text: string): number {
    return text.length / SPEAKING_CHARS_PER_SECOND / 60;
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}

function voiceOf(settings: AIOrganiserSettings): string {
    return settings.newsletterPodcastVoice || 'Charon';
}

async function synthIdentityOf(voice: string, tts: TtsHandle): Promise<string> {
    return (await sha256Hex([voice, tts.providerId, tts.modelId])).slice(0, 16);
}

async function scriptIdentityOf(plan: CatchUpPlan, settings: AIOrganiserSettings, memoryOn: boolean): Promise<string> {
    return (await sha256Hex([
        settings.newsletterPreferredLanguage ?? '',
        String(plan.length.capMinutes),
        settings.newsletterHomeRegion ?? '',
        memoryOn ? 'memory' : 'nomemory',
        plan.planHash,
    ])).slice(0, 16);
}

function freezeEntries(plan: CatchUpPlan): FrozenEntry[] {
    return plan.entries.map((e): FrozenEntry => e.kind === 'delta'
        ? { date: e.date, kind: 'delta', coverage: e.coverage, sinceRevision: e.sinceRevision }
        : { date: e.date, kind: 'full', coverage: e.coverage });
}

function coverageOf(entries: readonly FrozenEntry[]): CoverageMap {
    return Object.fromEntries(entries.map((e) => [e.date, e.coverage]));
}

const now = (ports: CatchUpPorts): Date => (ports.now ? ports.now() : new Date());

// ── Reconciliation ───────────────────────────────────────────────────────────

export type OperationState =
    | { kind: 'none' }
    | { kind: 'committed'; opId: string }
    | { kind: 'scripted'; record: OperationRecord }
    | { kind: 'audio-writing'; record: OperationRecord }
    | { kind: 'audio-ready'; record: OperationRecord }
    | { kind: 'expired'; record: OperationRecord };

/**
 * READ-ONLY classification of the stored operation, safe to call for a preview. Takes no lock
 * and changes nothing. Step 1 always: if an episode note already carries the record's id, the
 * operation committed and no other rule applies.
 */
export async function classifyOperation(ports: CatchUpPorts): Promise<OperationState> {
    const record = await loadOperation(ports.plugin);
    if (!record) return { kind: 'none' };
    const outputRoot = getNewsletterOutputFullPath(ports.settings);
    if (await findEpisodeByOpId(ports.app, outputRoot, record.opId)) return { kind: 'committed', opId: record.opId };
    if (isRecordExpired(record, now(ports).getTime())) return { kind: 'expired', record };
    if (record.phase === 'scripted') return { kind: 'scripted', record };
    if (record.phase === 'audio-writing') return { kind: 'audio-writing', record };

    const verify = ports.verifyAudio ?? realVerifyEpisodeAudio;
    const verified = !!record.audio && await verify(ports.app, record.audio.path, record.audio);
    // An `audio-ready` record whose file no longer verifies is no better than an interrupted write.
    return verified ? { kind: 'audio-ready', record } : { kind: 'audio-writing', record };
}

/** Trash the audio a record owns — but only after proving no committed note references it. */
async function trashStagedAudio(ports: CatchUpPorts, record: OperationRecord): Promise<void> {
    const outputRoot = getNewsletterOutputFullPath(ports.settings);
    const path = record.audio?.path;
    if (!path) return;
    const name = path.split('/').pop() ?? '';
    // Never delete committed audio, and never delete anything we do not provably own. "Unknown"
    // (an episode note could not be read) is NOT "unreferenced".
    if ((await isAudioReferenced(ports.app, outputRoot, name)) !== 'no') return;
    if (!name.includes(record.opId)) return;
    try {
        await trashOwnedFile(ports.app, outputRoot, path);
    } catch (e) {
        logger.warn('Newsletter', `Could not remove staged catch-up audio ${path}`, e);
    }
}

/**
 * MUTATING reconciliation, run under the lock before any expiry, discard, start-over or new run.
 *
 *   committed     keep the audio the note references, clear the record
 *   expired       trash unreferenced owned audio, clear the record
 *   otherwise     the record is returned for the caller to resume or discard
 */
export async function reconcileOperation(ports: CatchUpPorts): Promise<OperationState> {
    const state = await classifyOperation(ports);
    if (state.kind === 'committed') {
        await clearOperation(ports.plugin, state.opId);
        ports.onChanged?.();
    } else if (state.kind === 'expired') {
        await trashStagedAudio(ports, state.record);
        await clearOperation(ports.plugin, state.record.opId);
        ports.onChanged?.();
        return { kind: 'none' };
    }
    return state;
}

/** Explicit Discard / Start over: reconcile first, then remove an uncommitted record and its owned audio. */
export async function discardOperation(ports: CatchUpPorts): Promise<Result<boolean>> {
    return withLock(async () => {
        const state = await reconcileOperation(ports);
        if (state.kind === 'none' || state.kind === 'committed') return ok(false);
        await trashStagedAudio(ports, state.record);
        await clearOperation(ports.plugin, state.record.opId);
        ports.onChanged?.();
        return ok(true);
    });
}

// ── The run ──────────────────────────────────────────────────────────────────

const cancelled = (): Result<never> => err('cancelled');

function aborted(opts: RunOptions): boolean {
    return opts.signal?.aborted === true;
}

/**
 * Make one catch-up episode from the CURRENT state of the vault.
 *
 * Admission: acquires the single-flight lock, reconciles any stored operation first, and
 * refuses to start while an unresolved record exists (the caller chooses Resume, Start over or
 * Discard explicitly). Re-freezes the plan under the lock and refuses if it differs from the
 * one previewed.
 */
export async function runCatchUp(ports: CatchUpPorts, opts: RunOptions): Promise<Result<EpisodeResult>> {
    return withLock(async () => {
        opts.onPhase?.({ key: 'freezing' });
        const state = await reconcileOperation(ports);
        if (state.kind !== 'none' && state.kind !== 'committed') return err('catchup-unresolved');

        const snapshot = await buildCatchUpSnapshot(
            { app: ports.app, plugin: ports.plugin, settings: ports.settings, now: now(ports) },
            opts.kind ?? 'manual',
        );
        const plan = snapshot.plan;
        if (!plan) return err('catchup-nothing-pending');
        if (opts.previewHash !== undefined && opts.previewHash !== plan.planHash) return err('catchup-changed');
        if (aborted(opts)) return cancelled();

        // Fail fast on a missing TTS setup: no point paying for a script that cannot be voiced.
        const resolved = await ports.resolveTts();
        if (!resolved.ok) return err(resolved.code);
        if (aborted(opts)) return cancelled();

        const record = await writeScript(ports, snapshot, plan, opts);
        if (!record.ok) return record;
        return makeAudio(ports, record.value, resolved.tts, opts);
    });
}

/**
 * Script step. The operation record is created as soon as a script exists, because from then on
 * the episode is resumable without another LLM call.
 */
async function writeScript(
    ports: CatchUpPorts,
    snapshot: CatchUpSnapshot,
    plan: CatchUpPlan,
    opts: RunOptions,
): Promise<Result<OperationRecord>> {
    opts.onPhase?.({ key: 'writingScript' });
    const written = await ports.generateScript(plan, opts.signal);
    if (!written.ok) return aborted(opts) ? cancelled() : err('catchup-script-failed');
    let script = written.value.trim();
    if (script === '') return err('catchup-script-failed');

    // Bound the length BEFORE any audio is made: one automatic shrink first.
    const budget = plan.length.wordBudget;
    const limit = budget * SCRIPT_OVERRUN_FACTOR;
    const shorten = async (): Promise<boolean> => {
        opts.onPhase?.({ key: 'shorteningScript' });
        const shorter = await ports.shortenScript(plan, script, budget, opts.signal);
        if (shorter.ok && shorter.value.trim() !== '') { script = shorter.value.trim(); return true; }
        return false;
    };
    if (countWords(script) > limit) await shorten();
    if (aborted(opts)) return cancelled();

    // Commit is idempotent BY operation id, so an id that already names a committed episode
    // would silently turn a new run into a no-op. Re-draw until it is unused.
    const outputRoot = getNewsletterOutputFullPath(ports.settings);
    let opId = generateOpId(now(ports), ports.random);
    for (let attempt = 0; attempt < 8 && await findEpisodeByOpId(ports.app, outputRoot, opId); attempt++) {
        opId = generateOpId(now(ports), ports.random);
    }
    if (await findEpisodeByOpId(ports.app, outputRoot, opId)) return err('catchup-save-failed');

    let record: OperationRecord = {
        version: RECORD_SCHEMA_VERSION,
        opId,
        phase: 'scripted',
        frozen: {
            entries: freezeEntries(plan),
            from: plan.from,
            to: plan.to,
            sources: plan.entries.reduce((n, e) => n + e.newsletters, 0),
            titles: plan.entries.flatMap((e) => e.titles),
        },
        script,
        scriptIdentity: await scriptIdentityOf(plan, ports.settings, snapshot.memoryOn),
        createdAt: now(ports).getTime(),
    };
    const persisted = await saveOperation(ports.plugin, record);
    if (!persisted) logger.warn('Newsletter', 'Could not persist the catch-up record — this run cannot be resumed');
    ports.onChanged?.();

    // Still over the limit: a person decides, an automatic run never overruns.
    while (countWords(script) > limit) {
        if (!opts.interactive || !opts.confirmOverrun) return err('catchup-script-too-long');
        const choice = await opts.confirmOverrun({ estimatedMinutes: round1(estimateMinutes(script)), capMinutes: plan.length.capMinutes });
        if (choice === 'cancel' || aborted(opts)) return cancelled();
        if (choice === 'continue') break;
        if (await shorten()) {
            record = { ...record, script };
            if (persisted) await saveOperation(ports.plugin, record);
        }
        if (aborted(opts)) return cancelled();
    }
    return ok(record);
}

/** The fingerprint is the last 8 hex digits of the audio file name `catchup-<opId>-<fp8>.mp3`. */
function fingerprintFromAudioPath(path: string): string {
    return /-([0-9a-f]{8})\.mp3$/.exec(path)?.[1] ?? '';
}

/**
 * Audio step then commit. Operates only on the RECORD (frozen coverage + script), never on
 * current inputs, so a resume after a mid-run fetch cannot change what the episode claims.
 */
async function makeAudio(
    ports: CatchUpPorts,
    start: OperationRecord,
    tts: TtsHandle,
    opts: RunOptions,
): Promise<Result<EpisodeResult>> {
    const outputRoot = getNewsletterOutputFullPath(ports.settings);
    const voice = voiceOf(ports.settings);
    const synthesise = ports.synthesise ?? realGenerateEpisodeAudio;
    const verify = ports.verifyAudio ?? realVerifyEpisodeAudio;

    let record = start;
    const update = async (next: OperationRecord): Promise<void> => {
        record = next;
        await saveOperation(ports.plugin, next);
    };

    const fingerprint = await computeEpisodeFingerprint(record.script, voice, tts.providerId, tts.modelId);
    const synthIdentity = await synthIdentityOf(voice, tts);
    const audioPath = normalizePath(`${episodeFolderPath(outputRoot)}/${audioFileName(record.opId, fingerprint)}`);

    // Reuse verified audio when voice/provider/model are unchanged; otherwise make it again.
    const reusable = record.phase === 'audio-ready' && record.synthIdentity === synthIdentity && !!record.audio
        && await verify(ports.app, record.audio.path, record.audio);

    if (!reusable) {
        if (aborted(opts)) return cancelled();
        // Any file this operation owns is a partial or superseded attempt.
        if (record.audio) await trashStagedAudio(ports, record);
        if (isInsideOutputRoot(outputRoot, audioPath) && ports.app.vault.getAbstractFileByPath(audioPath)) {
            await trashOwnedFile(ports.app, outputRoot, audioPath);
        }

        // Write-ahead: the record names the file BEFORE the file exists.
        await update({ ...record, phase: 'audio-writing', synthIdentity, audio: { path: audioPath } });

        opts.onPhase?.({ key: 'synthesising', done: 0, total: 1 });
        const made = await synthesise(ports.app, record.script, {
            engine: tts.engine,
            voice,
            filePath: audioPath,
            outputFolder: episodeFolderPath(outputRoot),
            signal: opts.signal,
            onProgress: (done, total) => opts.onPhase?.({ key: 'synthesising', done, total }),
        });
        if (!made.success || !made.filePath) {
            if (aborted(opts)) {
                await trashStagedAudio(ports, record);
                return cancelled();
            }
            logger.warn('Newsletter', 'Catch-up audio failed', made.error);
            return err('catchup-tts-failed');
        }
        await update({
            ...record,
            phase: 'audio-ready',
            audio: { path: made.filePath, bytes: made.bytes, durationSec: made.durationSec, sha256: made.sha256 },
        });
    }

    if (aborted(opts)) return cancelled();
    return commitEpisode(ports, record, opts, fingerprintFromAudioPath(record.audio?.path ?? ''));
}

/**
 * COMMIT: create the episode note. From the moment this starts there is no rollback, so the
 * reporter stops offering Cancel. Idempotent by operation id.
 */
async function commitEpisode(
    ports: CatchUpPorts,
    record: OperationRecord,
    opts: RunOptions,
    fingerprint: string,
): Promise<Result<EpisodeResult>> {
    const audio = record.audio;
    if (!audio) return err('catchup-save-failed');

    opts.setCancellable?.(false);
    opts.onPhase?.({ key: 'saving' });

    const outputRoot = getNewsletterOutputFullPath(ports.settings);
    const durationSec = audio.durationSec ?? estimateMinutes(record.script) * 60;
    const minutes = round1(durationSec / 60);
    try {
        const res = await writeEpisodeNote(ports.app, outputRoot, {
            id: record.opId,
            from: record.frozen.from,
            to: record.frozen.to,
            coverage: coverageOf(record.frozen.entries),
            audio: audio.path.split('/').pop() ?? audio.path,
            fingerprint,
            minutes,
            sources: record.frozen.sources,
            titles: record.frozen.titles,
            script: record.script,
        });
        await clearOperation(ports.plugin, record.opId);
        ports.onChanged?.();
        return ok({
            opId: record.opId,
            notePath: res.path,
            audioPath: audio.path,
            minutes,
            from: record.frozen.from,
            to: record.frozen.to,
            days: record.frozen.entries.length,
            sources: record.frozen.sources,
            created: res.created,
        });
    } catch (e) {
        logger.warn('Newsletter', 'Catch-up note could not be saved', e);
        return err('catchup-save-failed');
    }
}

/**
 * Finish an unresolved operation from its STORED record: re-voice a scripted/interrupted one, or
 * only write the note for verified audio ("Finish saving" — no TTS setup needed for that).
 */
export async function resumeCatchUp(ports: CatchUpPorts, opts: RunOptions): Promise<Result<EpisodeResult>> {
    return withLock(async () => {
        const state = await reconcileOperation(ports);
        if (state.kind === 'none' || state.kind === 'committed' || state.kind === 'expired') return err('catchup-nothing-pending');
        if (aborted(opts)) return cancelled();

        if (state.kind === 'audio-ready') {
            return commitEpisode(ports, state.record, opts, fingerprintFromAudioPath(state.record.audio?.path ?? ''));
        }
        const resolved = await ports.resolveTts();
        if (!resolved.ok) return err(resolved.code);
        return makeAudio(ports, state.record, resolved.tts, opts);
    });
}

// ── Smart daily ──────────────────────────────────────────────────────────────

export type AutoSkipReason = 'wrong-mode' | 'busy' | 'unresolved' | 'unheard' | 'nothing-pending';

/**
 * Whether an AUTOMATIC run may start now. Admission is deliberately conservative: it keys on
 * durable state (the ack map and the operation record), not on idle time, and it skips rather
 * than replaces anything unresolved.
 */
export async function autoRunDecision(ports: CatchUpPorts): Promise<{ run: true } | { run: false; reason: AutoSkipReason }> {
    if (getAudioMode(ports.settings) !== 'smart-daily' || ports.settings.newsletterAudioPodcast !== true) return { run: false, reason: 'wrong-mode' };
    if (running) return { run: false, reason: 'busy' };
    const state = await classifyOperation(ports);
    if (state.kind !== 'none' && state.kind !== 'committed' && state.kind !== 'expired') return { run: false, reason: 'unresolved' };
    const snapshot = await buildCatchUpSnapshot({ app: ports.app, plugin: ports.plugin, settings: ports.settings, now: now(ports) }, 'auto');
    if (snapshot.unheard.length > 0) return { run: false, reason: 'unheard' };
    if (!snapshot.plan) return { run: false, reason: 'nothing-pending' };
    return { run: true };
}

/** One automatic catch-up, if admission allows. Never interactive, never replaces unresolved work. */
export async function runAutoCatchUp(ports: CatchUpPorts, opts: Pick<RunOptions, 'signal' | 'onPhase'> = {}): Promise<Result<EpisodeResult | null>> {
    const decision = await autoRunDecision(ports);
    if (!decision.run) {
        logger.debug('Newsletter', `Smart daily catch-up skipped: ${decision.reason}`);
        return ok(null);
    }
    const res = await runCatchUp(ports, { ...opts, interactive: false, kind: 'auto' });
    return res.ok ? ok(res.value) : res;
}

