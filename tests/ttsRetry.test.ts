/**
 * TTS retry helper — exponential backoff + abort awareness.
 */

import { describe, it, expect, vi } from 'vitest';
import { retryWithBackoff, DEFAULT_TTS_RETRY } from '../src/services/tts/ttsRetry';

describe('retryWithBackoff', () => {
    it('returns success on first attempt without retry', async () => {
        const op = vi.fn().mockResolvedValue('ok');
        const result = await retryWithBackoff(op);
        expect(result).toBe('ok');
        expect(op).toHaveBeenCalledTimes(1);
    });

    it('retries on retryable error (httpStatus 429)', async () => {
        const err = Object.assign(new Error('rate limited'), { httpStatus: 429 });
        const op = vi.fn()
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce('ok');
        const policy = { ...DEFAULT_TTS_RETRY, baseDelayMs: 1, maxDelayMs: 2 };
        const result = await retryWithBackoff(op, policy);
        expect(result).toBe('ok');
        expect(op).toHaveBeenCalledTimes(2);
    });

    it('retries when error.retryable === true regardless of httpStatus', async () => {
        const err = Object.assign(new Error('transient'), { retryable: true });
        const op = vi.fn()
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce('ok');
        const policy = { ...DEFAULT_TTS_RETRY, baseDelayMs: 1, maxDelayMs: 2 };
        const result = await retryWithBackoff(op, policy);
        expect(result).toBe('ok');
    });

    it('does not retry on non-retryable error (401)', async () => {
        const err = Object.assign(new Error('unauthorized'), { httpStatus: 401 });
        const op = vi.fn().mockRejectedValue(err);
        await expect(retryWithBackoff(op)).rejects.toBe(err);
        expect(op).toHaveBeenCalledTimes(1);
    });

    it('gives up after maxAttempts (3)', async () => {
        const err = Object.assign(new Error('rate limited'), { httpStatus: 429 });
        const op = vi.fn().mockRejectedValue(err);
        const policy = { ...DEFAULT_TTS_RETRY, baseDelayMs: 1, maxDelayMs: 2 };
        await expect(retryWithBackoff(op, policy)).rejects.toBe(err);
        expect(op).toHaveBeenCalledTimes(3);
    });

    it('aborts immediately on AbortSignal during sleep', async () => {
        const err = Object.assign(new Error('rate limited'), { httpStatus: 503 });
        const op = vi.fn().mockRejectedValue(err);
        const ac = new AbortController();
        const policy = { ...DEFAULT_TTS_RETRY, baseDelayMs: 100, maxDelayMs: 100 };
        const promise = retryWithBackoff(op, policy, ac.signal);
        ac.abort();
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('aborts when signal already aborted before first attempt', async () => {
        const op = vi.fn().mockResolvedValue('ok');
        const ac = new AbortController();
        ac.abort();
        await expect(retryWithBackoff(op, undefined, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(op).not.toHaveBeenCalled();
    });

    it('AbortError thrown by op propagates without retry', async () => {
        const op = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
        await expect(retryWithBackoff(op)).rejects.toMatchObject({ name: 'AbortError' });
        expect(op).toHaveBeenCalledTimes(1);
    });

    it('onRetry callback fires per retry with attempt and delay', async () => {
        const err = Object.assign(new Error('rate limited'), { httpStatus: 429 });
        const op = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('ok');
        const onRetry = vi.fn();
        const policy = { ...DEFAULT_TTS_RETRY, baseDelayMs: 1, maxDelayMs: 2 };
        await retryWithBackoff(op, policy, undefined, onRetry);
        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(onRetry.mock.calls[0][0]).toBe(1);  // attempt
        expect(typeof onRetry.mock.calls[0][1]).toBe('number');  // delayMs
    });

    it('treats NetworkError name as retryable', async () => {
        const err = Object.assign(new Error('connection failed'), { name: 'NetworkError' });
        const op = vi.fn()
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce('ok');
        const policy = { ...DEFAULT_TTS_RETRY, baseDelayMs: 1, maxDelayMs: 2 };
        const result = await retryWithBackoff(op, policy);
        expect(result).toBe('ok');
    });
});
