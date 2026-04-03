/**
 * Zotero Bridge Service Tests
 *
 * Tests for CSL-JSON transformation, platform detection,
 * availability checking, clipboard fallback, and HTTP send/failure.
 */

vi.mock('obsidian', async () => {
    const mod = await import('./mocks/obsidian');
    return {
        ...mod,
        requestUrl: vi.fn(),
    };
});

import { Platform, requestUrl } from 'obsidian';
import { ZoteroBridgeService } from '../src/services/research/zoteroBridgeService';
import type { SourceMetadata, CslJsonItem } from '../src/services/research/researchTypes';

const mockRequestUrl = requestUrl as unknown as ReturnType<typeof vi.fn>;

/** Helper to create a minimal SourceMetadata */
function makeSource(overrides: Partial<SourceMetadata> = {}): SourceMetadata {
    return {
        url: 'https://example.com/article',
        title: 'Test Article',
        domain: 'example.com',
        accessedDate: '2026-02-12',
        extractionMethod: 'readability',
        findings: 'Some findings',
        ...overrides,
    };
}

describe('ZoteroBridgeService', () => {
    let service: ZoteroBridgeService;

    beforeEach(() => {
        service = new ZoteroBridgeService();
    });

    describe('toCslJson', () => {
        it('should convert basic source to webpage type', () => {
            const sources = [makeSource()];
            const items = service.toCslJson(sources);

            expect(items).toHaveLength(1);
            expect(items[0].type).toBe('webpage');
            expect(items[0].title).toBe('Test Article');
            expect(items[0].URL).toBe('https://example.com/article');
        });

        it('should produce article-journal type for academic domains', () => {
            const academicDomains = ['arxiv.org', 'nature.com', 'ieee.org', 'acm.org', 'science.org'];
            for (const domain of academicDomains) {
                const sources = [makeSource({ domain })];
                const items = service.toCslJson(sources);
                expect(items[0].type).toBe('article-journal');
            }
        });

        it('should produce article-journal type when DOI is present', () => {
            const sources = [makeSource({ doi: '10.1038/test', domain: 'somesite.com' })];
            const items = service.toCslJson(sources);
            expect(items[0].type).toBe('article-journal');
        });

        it('should produce report type for .gov domains', () => {
            const sources = [makeSource({ domain: 'data.gov' })];
            const items = service.toCslJson(sources);
            expect(items[0].type).toBe('report');
        });

        it('should produce report type for .gov.uk domains', () => {
            const sources = [makeSource({ domain: 'legislation.gov.uk' })];
            const items = service.toCslJson(sources);
            expect(items[0].type).toBe('report');
        });

        it('should include DOI when present', () => {
            const sources = [makeSource({ doi: '10.1038/nature12373' })];
            const items = service.toCslJson(sources);
            expect(items[0].DOI).toBe('10.1038/nature12373');
        });

        it('should not include DOI when absent', () => {
            const sources = [makeSource()];
            const items = service.toCslJson(sources);
            expect(items[0].DOI).toBeUndefined();
        });

        it('should split author names correctly (two-part name)', () => {
            const sources = [makeSource({ authors: ['John Smith'] })];
            const items = service.toCslJson(sources);
            expect(items[0].author).toBeDefined();
            expect(items[0].author).toHaveLength(1);
            expect(items[0].author![0].family).toBe('Smith');
            expect(items[0].author![0].given).toBe('John');
        });

        it('should handle single-part author name', () => {
            const sources = [makeSource({ authors: ['Aristotle'] })];
            const items = service.toCslJson(sources);
            expect(items[0].author![0].family).toBe('Aristotle');
            expect(items[0].author![0].given).toBe('');
        });

        it('should handle multi-part author names', () => {
            const sources = [makeSource({ authors: ['Mary Jane Watson'] })];
            const items = service.toCslJson(sources);
            expect(items[0].author![0].family).toBe('Watson');
            expect(items[0].author![0].given).toBe('Mary Jane');
        });

        it('should include issued date when year is present', () => {
            const sources = [makeSource({ year: 2024 })];
            const items = service.toCslJson(sources);
            expect(items[0].issued).toBeDefined();
            expect(items[0].issued!['date-parts']).toEqual([[2024]]);
        });

        it('should not include issued when year is absent', () => {
            const sources = [makeSource()];
            const items = service.toCslJson(sources);
            expect(items[0].issued).toBeUndefined();
        });

        it('should include accessed date', () => {
            const sources = [makeSource()];
            const items = service.toCslJson(sources);
            expect(items[0].accessed).toBeDefined();
            expect(items[0].accessed['date-parts']).toBeDefined();
            expect(items[0].accessed['date-parts'][0]).toHaveLength(3);
        });

        it('should set container-title to domain', () => {
            const sources = [makeSource({ domain: 'nature.com' })];
            const items = service.toCslJson(sources);
            expect(items[0]['container-title']).toBe('nature.com');
        });
    });

    describe('shouldShowButton', () => {
        const originalIsMobile = Platform.isMobile;

        afterEach(() => {
            (Platform as any).isMobile = originalIsMobile;
        });

        it('should return true on desktop', () => {
            (Platform as any).isMobile = false;
            expect(service.shouldShowButton()).toBe(true);
        });

        it('should return false on mobile', () => {
            (Platform as any).isMobile = true;
            expect(service.shouldShowButton()).toBe(false);
        });
    });

    describe('isAvailable', () => {
        it('should return false when connector plugin is not installed', () => {
            const mockApp = {
                plugins: {
                    enabledPlugins: new Set<string>(),
                },
            } as any;

            expect(service.isAvailable(mockApp)).toBe(false);
        });

        it('should return true when connector plugin is installed', () => {
            const mockApp = {
                plugins: {
                    enabledPlugins: new Set(['obsidian-zotero-desktop-connector']),
                },
            } as any;

            // Only true on desktop
            const originalIsMobile = Platform.isMobile;
            (Platform as any).isMobile = false;

            expect(service.isAvailable(mockApp)).toBe(true);
            (Platform as any).isMobile = originalIsMobile;
        });

        it('should return false on mobile even when connector is installed', () => {
            const mockApp = {
                plugins: {
                    enabledPlugins: new Set(['obsidian-zotero-desktop-connector']),
                },
            } as any;

            const originalIsMobile = Platform.isMobile;
            (Platform as any).isMobile = true;

            expect(service.isAvailable(mockApp)).toBe(false);
            (Platform as any).isMobile = originalIsMobile;
        });
    });

    describe('copyToClipboard', () => {
        it('should call navigator.clipboard.writeText with JSON', async () => {
            const writeTextMock = vi.fn().mockResolvedValue(undefined);
            Object.defineProperty(globalThis, 'navigator', {
                value: { clipboard: { writeText: writeTextMock } },
                writable: true,
                configurable: true,
            });

            const items: CslJsonItem[] = [{
                type: 'webpage',
                title: 'Test',
                URL: 'https://example.com',
                accessed: { 'date-parts': [[2026, 2, 12]] },
            }];

            await service.copyToClipboard(items);

            expect(writeTextMock).toHaveBeenCalledTimes(1);
            const calledWith = writeTextMock.mock.calls[0][0];
            const parsed = JSON.parse(calledWith);
            expect(parsed).toHaveLength(1);
            expect(parsed[0].title).toBe('Test');
        });
    });

    describe('sendToZotero', () => {
        const sampleItems: CslJsonItem[] = [
            {
                type: 'webpage',
                title: 'Test Article',
                URL: 'https://example.com/article',
                accessed: { 'date-parts': [[2026, 2, 12]] },
            },
        ];

        beforeEach(() => {
            mockRequestUrl.mockReset();
            mockRequestUrl.mockResolvedValue({ status: 200 });
        });

        // --- HTTP Send Tests ---

        it('should call requestUrl with correct Zotero API endpoint', async () => {
            await service.sendToZotero(sampleItems);

            expect(mockRequestUrl).toHaveBeenCalledTimes(1);
            const callArg = mockRequestUrl.mock.calls[0][0];
            expect(callArg.url).toBe('http://localhost:23119/api/users/0/items');
        });

        it('should send items as JSON payload with Content-Type header', async () => {
            await service.sendToZotero(sampleItems);

            const callArg = mockRequestUrl.mock.calls[0][0];
            expect(callArg.method).toBe('POST');
            expect(callArg.headers['Content-Type']).toBe('application/json');

            const parsed = JSON.parse(callArg.body);
            expect(parsed).toHaveLength(1);
            expect(parsed[0].title).toBe('Test Article');
            expect(parsed[0].URL).toBe('https://example.com/article');
        });

        it('should include collection name in payload when provided', async () => {
            await service.sendToZotero(sampleItems, 'My Research');

            const callArg = mockRequestUrl.mock.calls[0][0];
            const parsed = JSON.parse(callArg.body);
            expect(parsed[0].collections).toEqual(['My Research']);
        });

        it('should return success true on successful HTTP call', async () => {
            const result = await service.sendToZotero(sampleItems);

            expect(result).toEqual({ success: true });
        });

        // --- HTTP Failure Tests ---

        it('should return success false with error when requestUrl throws', async () => {
            mockRequestUrl.mockRejectedValue(new Error('Connection refused'));

            const result = await service.sendToZotero(sampleItems);

            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
        });

        it('should handle network timeout errors gracefully', async () => {
            mockRequestUrl.mockRejectedValue(new Error('net::ERR_CONNECTION_TIMED_OUT'));

            const result = await service.sendToZotero(sampleItems);

            expect(result.success).toBe(false);
            expect(result.error).toBeDefined();
            expect(result.error).toContain('ERR_CONNECTION_TIMED_OUT');
        });

        it('should include the actual error text in the error message', async () => {
            mockRequestUrl.mockRejectedValue(new Error('Zotero is not running'));

            const result = await service.sendToZotero(sampleItems);

            expect(result.success).toBe(false);
            expect(result.error).toBe('Zotero is not running');
        });

        // --- Collection Targeting Tests ---

        it('should add collections array to each item when collection is specified', async () => {
            const multipleItems: CslJsonItem[] = [
                { type: 'webpage', title: 'Article 1', URL: 'https://a.com', accessed: { 'date-parts': [[2026, 1, 1]] } },
                { type: 'article-journal', title: 'Article 2', URL: 'https://b.com', accessed: { 'date-parts': [[2026, 1, 2]] }, DOI: '10.1234/test' },
            ];

            await service.sendToZotero(multipleItems, 'Climate Research');

            const callArg = mockRequestUrl.mock.calls[0][0];
            const parsed = JSON.parse(callArg.body);
            expect(parsed).toHaveLength(2);
            expect(parsed[0].collections).toEqual(['Climate Research']);
            expect(parsed[1].collections).toEqual(['Climate Research']);
        });

        it('should omit collections when no collection is specified', async () => {
            await service.sendToZotero(sampleItems);

            const callArg = mockRequestUrl.mock.calls[0][0];
            const parsed = JSON.parse(callArg.body);
            expect(parsed[0].collections).toBeUndefined();
        });
    });
});
