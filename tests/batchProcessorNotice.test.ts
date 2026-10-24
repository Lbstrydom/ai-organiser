import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import { mockNotices, clearMockNotices } from './mocks/obsidian';
import { BatchProcessor } from '../src/utils/batchProcessor';
import { TagOperations } from '../src/utils/tagOperations';
import { TagUtils } from '../src/utils/tagUtils';

const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `n${i}.md` })) as never[];
const cleared = (): string[] => mockNotices.filter((m: string) => /^Cleared \d+ notes$/.test(m));

describe('BatchProcessor closing notice', () => {
    beforeEach(() => clearMockNotices());

    it('announces the count by default (other callers unchanged)', async () => {
        await new BatchProcessor().processBatch(files(3), async () => undefined);
        expect(cleared()).toEqual(['Cleared 3 notes']);
    });

    it('stays quiet when the caller reports the result itself', async () => {
        await new BatchProcessor({ announceResult: false }).processBatch(files(3), async () => undefined);
        expect(cleared()).toEqual([]);
    });

    it('still reports progress when the closing notice is off', async () => {
        await new BatchProcessor({ announceResult: false }).processBatch(files(2), async () => undefined);
        expect(mockNotices).toContain('100%');
    });
});

describe('clearing tags shows one success notice', () => {
    beforeEach(() => clearMockNotices());

    it('TagOperations leaves the success message to the command', async () => {
        const spy = vi.spyOn(TagUtils, 'clearTags').mockResolvedValue({ success: true, message: 'ok' } as never);
        const app = { vault: { trigger: vi.fn() }, workspace: { trigger: vi.fn() }, metadataCache: { trigger: vi.fn() } };
        const res = await new TagOperations(app as never).clearDirectoryTags(files(4));
        expect(res.successCount).toBe(4);
        expect(cleared()).toEqual([]);
        spy.mockRestore();
    });
});
