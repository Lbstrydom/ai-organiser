import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The brief's grep-verifiable acceptance: the Azure pacer must be ACTUALLY wired
 * into the shared transport (it shipped unused before). A static source assertion
 * (the auditor's inventory can't see scripts/, so this lives in Vitest — R2-M2).
 */
describe('Azure throttle wiring', () => {
    const cloudService = readFileSync(resolve(__dirname, '../src/services/cloudService.ts'), 'utf8');

    it('cloudService imports + uses the Azure request pacer', () => {
        expect(cloudService).toMatch(/from '\.\/azure\/azureRequestPacer'/);
        expect(cloudService).toContain('getAzurePacer(');
        expect(cloudService).toContain('.acquire(');
        expect(cloudService).toContain('.release()');
    });

    it('the pacer is Azure-gated (isAzureAdapter), not applied to all providers', () => {
        expect(cloudService).toContain('isAzureAdapter()');
        // pacedRequestUrl short-circuits to a plain request when not Azure.
        expect(cloudService).toMatch(/if \(!this\.isAzureAdapter\(\)\)/);
    });

    it('wires the >TPM fail-fast + Azure-aware backoff', () => {
        expect(cloudService).toContain('azureTpmFailFast(');
        expect(cloudService).toContain('azureBackoffMs(');
    });
});
