import { describe, it, expect } from 'vitest';
import { formatAzureRateLimitNotice } from '../src/services/azure/formatAzureRateLimitNotice';
import { AzureRateLimitError } from '../src/services/azure/azureRateLimitError';
import { en } from '../src/i18n/en';

describe('formatAzureRateLimitNotice (audit R2-H5)', () => {
    it('maps tpm-exceeded with token figures', () => {
        const msg = formatAzureRateLimitNotice(
            new AzureRateLimitError('tpm-exceeded', { limitTokens: 10000, estTokens: 64000 }), en);
        expect(msg).toContain('64k');
        expect(msg).toContain('10k');
    });
    it('maps queue-full', () => {
        const msg = formatAzureRateLimitNotice(new AzureRateLimitError('queue-full'), en);
        expect(msg).toBe(en.azureRateLimit.queueFull);
    });
    it('returns null for a non-Azure-rate-limit error (caller keeps its own message)', () => {
        expect(formatAzureRateLimitNotice(new Error('boom'), en)).toBeNull();
        expect(formatAzureRateLimitNotice('nope', en)).toBeNull();
    });
});
