import { describe, it, expect } from 'vitest';
import { assertAllowed, type AudioOp } from '../src/services/azure/audioProviderPolicy';

function host(cloudServiceType: string, azureSpeechRequired = false): any {
    return { settings: { cloudServiceType, azureSpeechRequired } };
}

const OPS: AudioOp[] = ['tts', 'stt', 'diarization'];

describe('AudioProviderPolicy.assertAllowed (plan D5/D8 — compliance keystone)', () => {
    describe('strict mode (azureSpeechRequired) — NO Global-Standard surface reachable (H2)', () => {
        const strict = host('azure-claude', true);

        it.each(OPS)('azure-speech allowed for %s', (op) => {
            expect(assertAllowed(strict, { op, providerId: 'azure-speech' }).ok).toBe(true);
        });

        it('Whisper / azure-openai legacy refused (tts + stt)', () => {
            expect(assertAllowed(strict, { op: 'stt', providerId: 'azure-openai' })).toEqual({ ok: false, error: 'policy-denied:strict-speech-required' });
            expect(assertAllowed(strict, { op: 'tts', providerId: 'azure-openai' })).toEqual({ ok: false, error: 'policy-denied:strict-speech-required' });
        });

        it('gpt-audio refused — stale persisted setting fails closed (M7 regression)', () => {
            // A user who configured openai-gpt-audio while on a personal provider,
            // then switched to Azure strict: the persisted provider must be refused
            // at CALL time regardless of how the call site reached it.
            expect(assertAllowed(strict, { op: 'tts', providerId: 'openai-gpt-audio' }).ok).toBe(false);
            expect(assertAllowed(strict, { op: 'stt', providerId: 'openai-gpt-audio' }).ok).toBe(false);
        });

        it('BYO gemini / deepgram / openai / groq all refused (each on its own op)', () => {
            const pairs: Array<[string, AudioOp]> = [
                ['gemini', 'tts'], ['deepgram', 'diarization'], ['openai', 'stt'], ['groq', 'stt'],
            ];
            for (const [p, op] of pairs) {
                const r = assertAllowed(strict, { op, providerId: p });
                expect(r).toEqual({ ok: false, error: 'policy-denied:strict-speech-required' });
            }
        });

        it('resolvedSurface wins over providerId (R2-M1)', () => {
            // Generic provider id but resolver said azure-speech → allowed.
            expect(assertAllowed(strict, { op: 'stt', providerId: 'azure', resolvedSurface: 'azure-speech' }).ok).toBe(true);
            // And the inverse: a benign-looking id resolved onto a refused surface.
            expect(assertAllowed(strict, { op: 'stt', providerId: 'azure-speech', resolvedSurface: 'azure-openai' }).ok).toBe(false);
        });
    });

    describe('azure mode, strict OFF (default) — backward compat + the gpt-audio exception (D5)', () => {
        const azure = host('azure-openai', false);

        it('legacy azure-openai Whisper allowed (existing users byte-identical)', () => {
            expect(assertAllowed(azure, { op: 'stt', providerId: 'azure-openai' }).ok).toBe(true);
        });

        it('azure-speech allowed', () => {
            expect(assertAllowed(azure, { op: 'diarization', providerId: 'azure-speech' }).ok).toBe(true);
        });

        it('BYO gemini + deepgram stay allowed', () => {
            expect(assertAllowed(azure, { op: 'tts', providerId: 'gemini' }).ok).toBe(true);
            expect(assertAllowed(azure, { op: 'diarization', providerId: 'deepgram' }).ok).toBe(true);
        });

        it('gpt-audio refused in Azure mode regardless of strict (D5)', () => {
            expect(assertAllowed(azure, { op: 'tts', providerId: 'openai-gpt-audio' }))
                .toEqual({ ok: false, error: 'policy-denied:gpt-audio-requires-non-azure' });
        });
    });

    describe('non-Azure (private/BYO) mode', () => {
        const personal = host('claude');

        it('gpt-audio allowed (the private path)', () => {
            expect(assertAllowed(personal, { op: 'tts', providerId: 'openai-gpt-audio' }).ok).toBe(true);
            expect(assertAllowed(personal, { op: 'stt', providerId: 'openai-gpt-audio' }).ok).toBe(true);
        });

        it('gemini / deepgram / openai / groq allowed (each on its own op)', () => {
            const pairs: Array<[string, AudioOp]> = [
                ['gemini', 'tts'], ['deepgram', 'diarization'], ['openai', 'stt'], ['groq', 'stt'],
            ];
            for (const [p, op] of pairs) {
                expect(assertAllowed(personal, { op, providerId: p }).ok).toBe(true);
            }
        });

        it('azure surfaces refused off-Azure', () => {
            expect(assertAllowed(personal, { op: 'stt', providerId: 'azure-speech' }))
                .toEqual({ ok: false, error: 'policy-denied:not-azure-mode' });
            expect(assertAllowed(personal, { op: 'stt', providerId: 'azure-openai' }))
                .toEqual({ ok: false, error: 'policy-denied:not-azure-mode' });
        });

        it('strict flag is inert off-Azure (no accidental lockout)', () => {
            const p = host('claude', true);
            expect(assertAllowed(p, { op: 'tts', providerId: 'gemini' }).ok).toBe(true);
        });
    });

    describe('unknown-provider + op-mismatch fail-closed (D8 hardening)', () => {
        it('unknown persisted provider id is refused in EVERY mode', () => {
            for (const h of [host('claude'), host('azure-claude'), host('azure-claude', true)]) {
                expect(assertAllowed(h, { op: 'tts', providerId: 'rogue-provider' }))
                    .toEqual({ ok: false, error: 'policy-denied:unknown-provider' });
            }
        });

        it('provider/op mismatches are refused (deepgram TTS, gemini diarization, gemini STT)', () => {
            const personal = host('claude');
            expect(assertAllowed(personal, { op: 'tts', providerId: 'deepgram' }))
                .toEqual({ ok: false, error: 'policy-denied:op-mismatch' });
            expect(assertAllowed(personal, { op: 'diarization', providerId: 'gemini' }))
                .toEqual({ ok: false, error: 'policy-denied:op-mismatch' });
            expect(assertAllowed(personal, { op: 'stt', providerId: 'gemini' }))
                .toEqual({ ok: false, error: 'policy-denied:op-mismatch' });
        });

        it('azure-openai cannot diarize (no inline diarization on that surface)', () => {
            expect(assertAllowed(host('azure-openai'), { op: 'diarization', providerId: 'azure-openai' }))
                .toEqual({ ok: false, error: 'policy-denied:op-mismatch' });
        });
    });

    describe('robustness', () => {
        it('never throws on malformed settings', () => {
            expect(assertAllowed({ settings: {} as any }, { op: 'tts', providerId: 'gemini' }).ok).toBe(true);
            expect(assertAllowed({ settings: undefined as any }, { op: 'tts', providerId: 'gemini' }).ok).toBe(true);
        });
    });
});
