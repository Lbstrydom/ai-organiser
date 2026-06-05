import { describe, it, expect, beforeEach } from 'vitest';
import {
    withAzureLease, getAzurePacer, disposeAzurePacers,
    buildAzureClaudeDeploymentKey, buildAzureOpenAIDeploymentKey, normalizeAzureEndpointToHost, isAzureHost,
} from '../src/services/azure/azureRequestPacer';

beforeEach(() => disposeAzurePacers());

describe('withAzureLease', () => {
    it('runs fn, returns its value, and releases the lease on success', async () => {
        const key = 'k1';
        const r = await withAzureLease(key, undefined, async () => 42);
        expect(r).toBe(42);
        // The slot was freed (recentStarts counts the grant, but active is back to 0).
        expect(getAzurePacer(key).activeCount).toBe(0);
    });

    it('releases the lease even when fn throws (finally)', async () => {
        const key = 'k2';
        await expect(withAzureLease(key, undefined, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
        expect(getAzurePacer(key).activeCount).toBe(0);
    });

    it('serializes under a cap of 1 (second waits for the first to release)', async () => {
        const key = 'k3';
        getAzurePacer(key).setPolicy({ maxConcurrent: 1, maxRpm: 100, maxQueue: 10 });
        const order: string[] = [];
        let release1!: () => void;
        const p1 = withAzureLease(key, undefined, () => new Promise<void>(res => { order.push('a-start'); release1 = () => { order.push('a-end'); res(); }; }));
        const p2 = withAzureLease(key, undefined, async () => { order.push('b-run'); });
        await new Promise(r => setTimeout(r, 0));
        expect(order).toEqual(['a-start']); // b is queued behind a
        release1();
        await Promise.all([p1, p2]);
        expect(order).toEqual(['a-start', 'a-end', 'b-run']);
    });
});

describe('Azure SSOT key builders (audit H2/R2-H1/R2-M3)', () => {
    it('the cloudService full-URL and the web-search base produce the EQUAL Claude key (shared bucket)', () => {
        const full = buildAzureClaudeDeploymentKey('https://res.services.ai.azure.com/anthropic/v1/messages', 'claude-sonnet-4-6');
        const base = buildAzureClaudeDeploymentKey('https://res.services.ai.azure.com', 'claude-sonnet-4-6');
        expect(full).toBe(base);
    });

    it('normalizes scheme / case / trailing slash to the same host', () => {
        const a = buildAzureClaudeDeploymentKey('RES.services.ai.azure.com/', 'claude-sonnet-4-6');
        const b = buildAzureClaudeDeploymentKey('https://res.services.ai.azure.com', 'Claude-Sonnet-4-6');
        expect(a).toBe(b); // host lowercased + scheme-prefixed; model canonicalized
    });

    it('the Whisper (azure-openai) builder is a DISTINCT bucket from the Claude one', () => {
        const claude = buildAzureClaudeDeploymentKey('https://res.services.ai.azure.com', 'claude-sonnet-4-6');
        const whisper = buildAzureOpenAIDeploymentKey('https://res.openai.azure.com', 'whisper');
        expect(whisper).not.toBe(claude);
        expect(whisper.startsWith('azure-openai|')).toBe(true);
    });

    it('normalizeAzureEndpointToHost throws on garbage (no silent divergent key)', () => {
        expect(() => normalizeAzureEndpointToHost('   ')).toThrow();
    });

    it('isAzureHost detects Foundry + OpenAI hosts, rejects others / garbage', () => {
        expect(isAzureHost('https://res.services.ai.azure.com/anthropic/v1/messages')).toBe(true);
        expect(isAzureHost('res.openai.azure.com')).toBe(true);
        expect(isAzureHost('https://api.openai.com/v1/audio/transcriptions')).toBe(false);
        expect(isAzureHost('not a url')).toBe(false);
    });
});
