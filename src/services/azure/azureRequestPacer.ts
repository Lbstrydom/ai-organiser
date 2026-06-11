/**
 * Azure request pacer (azure-429-throttling) — ONE self-contained, bounded-FIFO,
 * two-gate scheduler that paces outbound Azure requests under the deployment's
 * low RPM cap. NOT a concurrency semaphore alone: a concurrency cap of 2 still
 * starts hundreds of req/min if calls are fast, so this ALSO enforces a rolling
 * 60s request-START window (max-RPM admission).
 *
 * Scheduler invariant: a waiter is granted in FIFO order only when, atomically,
 * `active < maxConcurrent` AND `(starts in last 60s) < maxRpm`. The start
 * timestamp + `active++` are recorded AT THE GRANT. No permit/RPM-slot is held
 * while merely waiting for the window. Cancellation is first-class: an abort while
 * QUEUED removes the waiter from the FIFO and rejects.
 *
 * Per-deployment registry (Azure quotas are per-deployment). Injectable clock for
 * deterministic tests (no real 60s waits).
 */

import { AzureRateLimitError } from './azureRateLimitError';
import { rpmForDeployment } from './azurePacingPolicy';

export interface RateLimitLease {
    release(): void;
}

export interface PacerPolicy {
    maxConcurrent: number;
    maxRpm: number;
    maxQueue: number;
}

/** Injectable time source so the rolling window + pump timer are fake-time testable. */
export interface PacerClock {
    now(): number;
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: PacerClock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
};

const WINDOW_MS = 60_000;

/** DoS backstop on the FIFO depth (audit R2-L1). Not user-configurable. */
export const AZURE_PACER_MAX_QUEUE = 256;

/** Abort rejection with `name === 'AbortError'` so cloudService/timeout layers
 *  classify it as a cancellation, not a network error (audit M4/M24). */
function abortError(): Error {
    const e = new Error('Aborted');
    e.name = 'AbortError';
    return e;
}

/** Normalize a policy: finite, integer, clamped (audit M8/M21 — `Math.max(1, NaN)`
 *  is `NaN`; reject non-finite + `Infinity`). */
function normalizePolicy(p: Partial<PacerPolicy>, base: PacerPolicy): PacerPolicy {
    const pick = (v: unknown, fallback: number): number => {
        const n = Math.floor(Number(v));
        return Number.isFinite(n) && n >= 1 ? n : fallback;
    };
    return {
        maxConcurrent: pick(p.maxConcurrent, base.maxConcurrent),
        maxRpm: pick(p.maxRpm, base.maxRpm),
        maxQueue: pick(p.maxQueue, base.maxQueue),
    };
}

interface Waiter {
    resolve: (lease: RateLimitLease) => void;
    reject: (err: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
}

export class AzureRequestPacer {
    private active = 0;
    /** Grant timestamps within the rolling window (ascending). */
    private starts: number[] = [];
    private readonly waiters: Waiter[] = [];
    private pumpTimer: unknown = null;

    constructor(policy: PacerPolicy, private readonly clock: PacerClock = REAL_CLOCK) {
        this.policy = normalizePolicy(policy, { maxConcurrent: 4, maxRpm: 60, maxQueue: AZURE_PACER_MAX_QUEUE });
    }
    private policy: PacerPolicy;

    private prune(): void {
        const cutoff = this.clock.now() - WINDOW_MS;
        while (this.starts.length > 0 && this.starts[0] <= cutoff) this.starts.shift();
    }

    private windowOpen(): boolean {
        this.prune();
        return this.starts.length < this.policy.maxRpm;
    }

    private canGrant(): boolean {
        return this.active < this.policy.maxConcurrent && this.windowOpen();
    }

    private grant(): RateLimitLease {
        this.active++;
        this.starts.push(this.clock.now());
        let released = false;
        return {
            release: () => {
                if (released) return;
                released = true;
                this.active--;
                this.pump();
            },
        };
    }

    private detach(w: Waiter): void {
        if (w.signal && w.onAbort) w.signal.removeEventListener('abort', w.onAbort);
    }

    private removeWaiter(w: Waiter): void {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
    }

    /** Acquire a lease, waiting for BOTH gates. Abort-while-queued rejects cleanly. */
    acquire(signal?: AbortSignal): Promise<RateLimitLease> {
        if (signal?.aborted) return Promise.reject(abortError());
        // FIFO fairness (audit H2): grant immediately ONLY when nobody is already
        // queued — otherwise a new arrival could jump a waiter blocked by the RPM
        // window. With waiters present, enqueue and let `pump()` grant in order.
        if (this.waiters.length === 0 && this.canGrant()) return Promise.resolve(this.grant());
        if (this.waiters.length >= this.policy.maxQueue) {
            return Promise.reject(new AzureRateLimitError('queue-full'));
        }
        return new Promise<RateLimitLease>((resolve, reject) => {
            const waiter: Waiter = { resolve, reject, signal };
            waiter.onAbort = () => {
                this.removeWaiter(waiter);
                this.detach(waiter);
                reject(abortError());
            };
            signal?.addEventListener('abort', waiter.onAbort, { once: true });
            this.waiters.push(waiter);
            this.schedulePump();
        });
    }

    /** Drain the FIFO while the invariant holds; then (re)arm the RPM timer if needed. */
    private pump(): void {
        while (this.waiters.length > 0 && this.canGrant()) {
            const w = this.waiters.shift() as Waiter;
            this.detach(w);
            w.resolve(this.grant());
        }
        this.schedulePump();
    }

    /** Arm a single timer to re-pump when the RPM window next frees a slot (only
     *  if the FIFO is blocked specifically by the window, not by concurrency). */
    private schedulePump(): void {
        if (this.pumpTimer != null) return;
        if (this.waiters.length === 0) return;
        if (this.active >= this.policy.maxConcurrent) return; // concurrency-blocked → pump on release
        this.prune();
        if (this.starts.length < this.policy.maxRpm) return; // window open → pump would have granted
        const wait = Math.max(1, this.starts[0] + WINDOW_MS - this.clock.now() + 1);
        this.pumpTimer = this.clock.setTimeout(() => {
            this.pumpTimer = null;
            this.pump();
        }, wait);
    }

    /** In-place policy update — PRESERVES active count, rolling window, and FIFO
     *  (audit R2-M1: never recreate; recreation would reset rate history). */
    setPolicy(policy: Partial<PacerPolicy>): void {
        this.policy = normalizePolicy(policy, this.policy);
        this.pump();
    }

    dispose(): void {
        if (this.pumpTimer != null) {
            this.clock.clearTimeout(this.pumpTimer);
            this.pumpTimer = null;
        }
        for (const w of this.waiters.splice(0)) {
            this.detach(w);
            // name 'AbortError' so a pending waiter rejected at teardown is classified
            // as a cancellation, not an unexpected error (audit M4).
            const e = new Error('Azure pacer disposed');
            e.name = 'AbortError';
            w.reject(e);
        }
    }

    // ── Diagnostics (tests) ──
    get activeCount(): number { return this.active; }
    get queueLength(): number { return this.waiters.length; }
    get recentStarts(): number { this.prune(); return this.starts.length; }
}

// ── Per-deployment registry + global policy ──────────────────────────────────

let globalPolicy: PacerPolicy = { maxConcurrent: 4, maxRpm: 60, maxQueue: AZURE_PACER_MAX_QUEUE };
/** User per-deployment RPM overrides (`settings.azurePerDeploymentRpm`); keyed by
 *  deployment NAME (canonicalized on lookup). Empty → every deployment uses globalRpm. */
let deploymentRpm: Record<string, number> = {};
const registry = new Map<string, AzureRequestPacer>();

// Per-deployment keys are built ONLY via the SSOT builders below
// (`buildAzureClaudeDeploymentKey` / `buildAzureOpenAIDeploymentKey`) — the old
// `azureRateLimitKey` was removed (azure-throttle-coverage audit M2) because its
// raw-fallback normalization diverged from the canonical `normalizeAzureEndpointToHost`.

/** Extract the canonical deployment/model identity from a registry key
 *  (`provider|host|identity` — the SSOT builders guarantee the identity is the
 *  trailing `|`-segment and is already trimmed+lowercased; Azure deployment names
 *  never contain `|`).
 *
 *  C11 migration seam: per-deployment RPM overrides are looked up by this
 *  NAME-ONLY identity (v1 tradeoff). Each `(provider|host|name)` still gets its
 *  OWN pacer + rolling window (the registry key is the full compound key), so
 *  PACING stays per-endpoint correct; only the override *ceiling value* is shared
 *  when two Azure resources reuse a deployment name (documented limitation). To
 *  migrate to full `surface|host|name` override keys later, change ONLY this
 *  function to return the compound identity and key `azurePerDeploymentRpm`
 *  likewise — the call sites do not change. */
function deploymentIdentityOfKey(key: string): string {
    const i = key.lastIndexOf('|');
    return i >= 0 ? key.slice(i + 1) : key;
}

/** Effective policy for a deployment key: global concurrency/queue + the deployment's
 *  per-deployment RPM override (or global RPM fallback). */
function effectivePolicyFor(key: string): PacerPolicy {
    return {
        ...globalPolicy,
        maxRpm: rpmForDeployment(deploymentIdentityOfKey(key), deploymentRpm, globalPolicy.maxRpm),
    };
}

/** The shared pacer for a deployment key (created lazily with its effective policy). */
export function getAzurePacer(key: string): AzureRequestPacer {
    let p = registry.get(key);
    if (!p) {
        p = new AzureRequestPacer(effectivePolicyFor(key));
        registry.set(key, p);
    }
    return p;
}

/** Set the global policy AND re-apply each live pacer's effective policy in place
 *  (audit R2-M1: never recreate — preserves the rolling window/FIFO). Per-deployment
 *  RPM overrides survive a global change (only concurrency/fallback-RPM shift). */
export function setAzurePacerPolicy(p: Partial<PacerPolicy>): void {
    globalPolicy = normalizePolicy(p, globalPolicy);
    for (const [key, pacer] of registry.entries()) pacer.setPolicy(effectivePolicyFor(key));
}

/** Set the per-deployment RPM overrides AND update every live pacer in place (M3:
 *  a running pacer's RPM changes without losing its window/FIFO). */
export function setDeploymentRpm(map: Record<string, number> | undefined): void {
    deploymentRpm = map ?? {};
    for (const [key, pacer] of registry.entries()) pacer.setPolicy(effectivePolicyFor(key));
}

/** Dispose + clear the registry (plugin onunload + test teardown). */
export function disposeAzurePacers(): void {
    for (const p of registry.values()) p.dispose();
    registry.clear();
}

// ── Shared lease + SSOT key builders (azure-throttle-coverage) ────────────────

/**
 * The ONE lease wrapper for `fetch` + cross-module Azure egress (multimodal,
 * streaming, web-search, audio). Acquires a pacer lease, runs `fn`, releases in
 * `finally` — so the slot frees on success AND throw. Cross-module callers use
 * this instead of touching `cloudService` internals.
 */
export async function withAzureLease<T>(
    key: string,
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
): Promise<T> {
    const lease = await getAzurePacer(key).acquire(signal);
    try {
        return await fn();
    } finally {
        lease.release();
    }
}

/**
 * ONE canonical endpoint → host normalizer (audit R2-H1). Both key builders +
 * `isAzureHost` route through it so the same Azure resource ALWAYS yields the same
 * bucket key regardless of scheme/case/path/trailing-slash. Throws on a
 * non-parseable input — a malformed endpoint must NOT silently produce a divergent
 * key (the caller already validated the Azure config).
 */
export function normalizeAzureEndpointToHost(raw: string): string {
    const t = (raw ?? '').trim().toLowerCase();
    if (!t) throw new Error('Azure endpoint is empty');
    const withScheme = /^https?:\/\//.test(t) ? t : `https://${t}`;
    return new URL(withScheme).host; // throws on garbage — intentional
}

/** Canonicalize the model/deployment identity component (audit R2-M3). */
function canonicalIdentity(id: string): string {
    return (id ?? '').trim().toLowerCase();
}

/**
 * SSOT key builder for the Azure Claude (Foundry) deployment. BOTH the text path
 * (`cloudService`) and the web-search adapter call this with the SAME concrete
 * resolved model id → they share ONE RPM bucket. `model` MUST be the resolved
 * model the adapter actually sends (never a `latest-*` sentinel / alias).
 */
export function buildAzureClaudeDeploymentKey(endpointOrBase: string, model: string): string {
    return `azure-claude|${normalizeAzureEndpointToHost(endpointOrBase)}|${canonicalIdentity(model)}`;
}

/** SSOT key builder for an Azure OpenAI deployment (Whisper / GPT / embeddings). */
export function buildAzureOpenAIDeploymentKey(endpointOrBase: string, deployment: string): string {
    return `azure-openai|${normalizeAzureEndpointToHost(endpointOrBase)}|${canonicalIdentity(deployment)}`;
}

/**
 * SSOT key builder for the Azure AI Speech surface (azure-audio R2-H2).
 * Resource-level + per-op buckets (Speech quotas are per-resource, not
 * per-deployment): `fast-transcription` (STT), `tts` (real-time synth),
 * `voices` (catalog list). Fine-grained Speech dims (chars/min, concurrent
 * transactions) are handled REACTIVELY via 429 + Retry-After backoff.
 *
 * The identity segment is `speech-<op>` so the per-deployment RPM editor can
 * target these buckets by name (rows `speech-tts` / `speech-fast-transcription`,
 * seeded in DEFAULT_AZURE_DEPLOYMENT_RPM) WITHOUT colliding with an Azure
 * OpenAI deployment that happens to be named `tts`.
 */
export function buildAzureSpeechKey(endpointOrBase: string, op: 'fast-transcription' | 'tts' | 'voices'): string {
    return `azure-speech|${normalizeAzureEndpointToHost(endpointOrBase)}|speech-${op}`;
}

/** True when the URL host is an Azure Foundry / Azure OpenAI host (audio self-detect). */
export function isAzureHost(url: string): boolean {
    try {
        const host = normalizeAzureEndpointToHost(url);
        return host.endsWith('.openai.azure.com') || host.endsWith('.services.ai.azure.com');
    } catch {
        return false;
    }
}
