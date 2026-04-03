/**
 * Research Usage Service Tests
 *
 * Tests for usage ledger creation, operation recording, budget status,
 * and month rollover logic.
 */

import { TFile } from 'obsidian';
import { ResearchUsageService } from '../src/services/research/researchUsageService';
import type { AIOrganiserSettings } from '../src/core/settings';

// Minimal mock App with vault operations
function createMockApp() {
    return {
        vault: {
            getAbstractFileByPath: vi.fn().mockReturnValue(null),
            read: vi.fn().mockResolvedValue(''),
            modify: vi.fn().mockResolvedValue(undefined),
            create: vi.fn().mockResolvedValue({}),
            rename: vi.fn().mockResolvedValue(undefined),
            delete: vi.fn().mockResolvedValue(undefined),
            createFolder: vi.fn().mockResolvedValue(undefined),
            getAbstractFileByPathInsensitive: vi.fn().mockReturnValue(null),
        },
    } as any;
}

// Minimal settings matching defaults from the service
function createMockSettings(overrides?: Partial<AIOrganiserSettings>): AIOrganiserSettings {
    return {
        pluginFolder: 'AI-Organiser',
        configFolderPath: 'Config',
        enableResearchUsageGuardrails: true,
        researchMonthlyBudgetUsd: 10,
        researchWarnThresholdPercent: 80,
        researchBlockAtLimit: true,
        ...overrides,
    } as AIOrganiserSettings;
}


describe('ResearchUsageService', () => {
    let mockApp: ReturnType<typeof createMockApp>;
    let settings: AIOrganiserSettings;

    beforeEach(() => {
        mockApp = createMockApp();
        settings = createMockSettings();
    });

    describe('createEmptyLedger (via constructor)', () => {
        it('should create ledger with correct initial state', () => {
            const service = new ResearchUsageService(mockApp, settings);
            const ledger = service.getLedger();

            expect(ledger.version).toBe(1);
            expect(ledger.totals.estimatedUsd).toBe(0);
            expect(ledger.totals.operations).toBe(0);
            expect(ledger.byProvider).toEqual({});
            expect(ledger.dailyCounts).toEqual({});
        });

        it('should set month in YYYY-MM format', () => {
            const service = new ResearchUsageService(mockApp, settings);
            const ledger = service.getLedger();

            expect(ledger.month).toMatch(/^\d{4}-\d{2}$/);
        });
    });

    describe('recordOperation', () => {
        it('should increment totals and by-provider counts for brightdata-serp', async () => {
            const service = new ResearchUsageService(mockApp, settings);
            await service.recordOperation('brightdata-serp');

            const ledger = service.getLedger();
            expect(ledger.totals.operations).toBe(1);
            expect(ledger.totals.estimatedUsd).toBeCloseTo(0.003);
            expect(ledger.byProvider['brightdata-serp'].count).toBe(1);
            expect(ledger.byProvider['brightdata-serp'].estimatedUsd).toBeCloseTo(0.003);
        });

        it('should increment totals for web-unlocker', async () => {
            const service = new ResearchUsageService(mockApp, settings);
            await service.recordOperation('web-unlocker');

            const ledger = service.getLedger();
            expect(ledger.totals.estimatedUsd).toBeCloseTo(0.001);
            expect(ledger.byProvider['web-unlocker'].count).toBe(1);
        });

        it('should increment totals for scraping-browser', async () => {
            const service = new ResearchUsageService(mockApp, settings);
            await service.recordOperation('scraping-browser');

            const ledger = service.getLedger();
            expect(ledger.totals.estimatedUsd).toBeCloseTo(0.01);
            expect(ledger.byProvider['scraping-browser'].count).toBe(1);
        });

        it('should accumulate multiple operations correctly', async () => {
            const service = new ResearchUsageService(mockApp, settings);
            await service.recordOperation('brightdata-serp');
            await service.recordOperation('brightdata-serp');
            await service.recordOperation('web-unlocker');

            const ledger = service.getLedger();
            expect(ledger.totals.operations).toBe(3);
            expect(ledger.totals.estimatedUsd).toBeCloseTo(0.003 + 0.003 + 0.001);
            expect(ledger.byProvider['brightdata-serp'].count).toBe(2);
            expect(ledger.byProvider['web-unlocker'].count).toBe(1);
        });

        it('should increment daily counts', async () => {
            const service = new ResearchUsageService(mockApp, settings);
            await service.recordOperation('brightdata-serp');

            const ledger = service.getLedger();
            const today = new Date().toISOString().slice(0, 10);
            expect(ledger.dailyCounts).toBeDefined();
            expect(ledger.dailyCounts![today]).toBeDefined();
            expect(ledger.dailyCounts![today]['brightdata-serp']).toBe(1);
        });

        it('should accumulate daily counts for same provider', async () => {
            const service = new ResearchUsageService(mockApp, settings);
            await service.recordOperation('brightdata-serp');
            await service.recordOperation('brightdata-serp');

            const ledger = service.getLedger();
            const today = new Date().toISOString().slice(0, 10);
            expect(ledger.dailyCounts![today]['brightdata-serp']).toBe(2);
        });
    });

    describe('recordFreeOperation', () => {
        it('should only track daily counts without cost', async () => {
            const service = new ResearchUsageService(mockApp, settings);
            await service.recordFreeOperation('tavily');

            const ledger = service.getLedger();
            const today = new Date().toISOString().slice(0, 10);

            // No cost tracking
            expect(ledger.totals.estimatedUsd).toBe(0);
            expect(ledger.totals.operations).toBe(0);
            expect(ledger.byProvider['tavily']).toBeUndefined();

            // Daily count tracked
            expect(ledger.dailyCounts![today]['tavily']).toBe(1);
        });

        it('should accumulate free operations', async () => {
            const service = new ResearchUsageService(mockApp, settings);
            await service.recordFreeOperation('tavily');
            await service.recordFreeOperation('tavily');

            const ledger = service.getLedger();
            const today = new Date().toISOString().slice(0, 10);
            expect(ledger.dailyCounts![today]['tavily']).toBe(2);
        });
    });

    describe('getBudgetStatus', () => {
        it('should return ok when guardrails disabled', () => {
            const disabledSettings = createMockSettings({ enableResearchUsageGuardrails: false });
            const service = new ResearchUsageService(mockApp, disabledSettings);

            const status = service.getBudgetStatus();
            expect(status.level).toBe('ok');
            expect(status.budgetUsd).toBe(0);
            expect(status.percentUsed).toBe(0);
        });

        it('should return ok when under budget', async () => {
            const service = new ResearchUsageService(mockApp, settings);
            // Record a single operation (~$0.003 of $10 budget)
            await service.recordOperation('brightdata-serp');

            const status = service.getBudgetStatus();
            expect(status.level).toBe('ok');
            expect(status.estimatedSpendUsd).toBeCloseTo(0.003);
            expect(status.message).toBeUndefined();
        });

        it('should return warn at threshold', async () => {
            // Budget $10, warn at 80% = $8
            const service = new ResearchUsageService(mockApp, settings);
            // Record enough operations to reach ~$8 (8/0.01 = 800 scraping-browser ops)
            // Instead, manipulate ledger via multiple operations
            // We need to spend >= $8. scraping-browser = $0.01 each, so 800 ops
            // Too many ops; let's lower the budget instead
            const lowBudgetSettings = createMockSettings({
                researchMonthlyBudgetUsd: 0.05,
                researchWarnThresholdPercent: 80,
            });
            const service2 = new ResearchUsageService(mockApp, lowBudgetSettings);
            // $0.05 budget, 80% warn = $0.04. scraping-browser = $0.01 each, 4 ops = $0.04
            await service2.recordOperation('scraping-browser');
            await service2.recordOperation('scraping-browser');
            await service2.recordOperation('scraping-browser');
            await service2.recordOperation('scraping-browser');

            const status = service2.getBudgetStatus();
            expect(status.level).toBe('warn');
            expect(status.message).toBeDefined();
            expect(status.message).toContain('$');
        });

        it('should return blocked at limit', async () => {
            const lowBudgetSettings = createMockSettings({
                researchMonthlyBudgetUsd: 0.01,
                researchBlockAtLimit: true,
            });
            const service = new ResearchUsageService(mockApp, lowBudgetSettings);
            // $0.01 budget, scraping-browser = $0.01 each, 1 op = 100%
            await service.recordOperation('scraping-browser');

            const status = service.getBudgetStatus();
            expect(status.level).toBe('blocked');
            expect(status.message).toContain('limit reached');
        });

        it('should return warn (not blocked) when blockAtLimit is false and over 100%', async () => {
            const noblockSettings = createMockSettings({
                researchMonthlyBudgetUsd: 0.01,
                researchBlockAtLimit: false,
                researchWarnThresholdPercent: 80,
            });
            const service = new ResearchUsageService(mockApp, noblockSettings);
            await service.recordOperation('scraping-browser');

            const status = service.getBudgetStatus();
            // Over 100% but blockAtLimit=false, so it should be 'warn' (since >= warnThresholdPercent)
            expect(status.level).toBe('warn');
        });
    });

    describe('checkBudget', () => {
        it('should return allowed=true when guardrails disabled', () => {
            const disabledSettings = createMockSettings({ enableResearchUsageGuardrails: false });
            const service = new ResearchUsageService(mockApp, disabledSettings);

            const result = service.checkBudget('brightdata-serp');
            expect(result.allowed).toBe(true);
            expect(result.message).toBeUndefined();
        });

        it('should return allowed=false when blocked', async () => {
            const lowBudgetSettings = createMockSettings({
                researchMonthlyBudgetUsd: 0.01,
                researchBlockAtLimit: true,
            });
            const service = new ResearchUsageService(mockApp, lowBudgetSettings);
            await service.recordOperation('scraping-browser');

            const result = service.checkBudget('scraping-browser');
            expect(result.allowed).toBe(false);
            expect(result.message).toContain('budget limit reached');
        });

        it('should return allowed=true with warning message when warn level', async () => {
            const lowBudgetSettings = createMockSettings({
                researchMonthlyBudgetUsd: 0.05,
                researchWarnThresholdPercent: 80,
            });
            const service = new ResearchUsageService(mockApp, lowBudgetSettings);
            // 4 x $0.01 = $0.04 = 80% of $0.05
            await service.recordOperation('scraping-browser');
            await service.recordOperation('scraping-browser');
            await service.recordOperation('scraping-browser');
            await service.recordOperation('scraping-browser');

            const result = service.checkBudget('scraping-browser');
            expect(result.allowed).toBe(true);
            expect(result.message).toBeDefined();
            expect(result.message).toContain('$');
        });

        it('should return allowed=true with no message when under budget', () => {
            const service = new ResearchUsageService(mockApp, settings);
            const result = service.checkBudget('brightdata-serp');
            expect(result.allowed).toBe(true);
            expect(result.message).toBeUndefined();
        });
    });

    describe('getUsageSummary', () => {
        it('should format USD correctly', async () => {
            const service = new ResearchUsageService(mockApp, settings);
            await service.recordOperation('brightdata-serp');

            const summary = service.getUsageSummary();
            expect(summary.estimatedUsd).toBe('$0.00'); // $0.003 rounds to $0.00
            expect(summary.operations).toBe(1);
            expect(summary.status).toBe('ok');
        });

        it('should show higher amounts correctly', async () => {
            const service = new ResearchUsageService(mockApp, settings);
            // 10 x scraping-browser = $0.10
            for (let i = 0; i < 10; i++) {
                await service.recordOperation('scraping-browser');
            }

            const summary = service.getUsageSummary();
            expect(summary.estimatedUsd).toBe('$0.10');
            expect(summary.operations).toBe(10);
        });
    });

    describe('resetUsage', () => {
        it('should clear totals to zero', async () => {
            const service = new ResearchUsageService(mockApp, settings);
            await service.recordOperation('brightdata-serp');
            await service.recordOperation('scraping-browser');

            await service.resetUsage();

            const ledger = service.getLedger();
            expect(ledger.totals.estimatedUsd).toBe(0);
            expect(ledger.totals.operations).toBe(0);
            expect(ledger.byProvider).toEqual({});
            expect(ledger.dailyCounts).toEqual({});
        });

        it('should reset to fresh ledger with current month', async () => {
            const service = new ResearchUsageService(mockApp, settings);
            await service.recordOperation('brightdata-serp');
            await service.resetUsage();

            const ledger = service.getLedger();
            expect(ledger.version).toBe(1);
            expect(ledger.month).toMatch(/^\d{4}-\d{2}$/);
        });
    });

    describe('getLedger', () => {
        it('should return a copy (not the internal ledger)', () => {
            const service = new ResearchUsageService(mockApp, settings);
            const ledger1 = service.getLedger();
            const ledger2 = service.getLedger();

            // They should be equal but not the same reference
            expect(ledger1).toEqual(ledger2);
            expect(ledger1).not.toBe(ledger2);
        });
    });

    describe('ensureLoaded', () => {
        it('should handle missing file gracefully', async () => {
            // getAbstractFileByPath returns null (file doesn't exist)
            const service = new ResearchUsageService(mockApp, settings);
            await service.ensureLoaded();

            const ledger = service.getLedger();
            expect(ledger.version).toBe(1);
            expect(ledger.totals.operations).toBe(0);
        });

        it('should handle malformed file by creating backup', async () => {
            const mockFile = new TFile();
            mockFile.path = 'AI-Organiser/Config/research-usage.json';
            mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile);
            mockApp.vault.read.mockResolvedValue('{ "invalid": "no version" }');

            const service = new ResearchUsageService(mockApp, settings);
            await service.ensureLoaded();

            // Should have renamed to .bak
            expect(mockApp.vault.rename).toHaveBeenCalledWith(
                mockFile,
                expect.stringContaining('.bak'),
            );
        });
    });

    describe('month rollover', () => {
        it('should reset ledger when month changes', async () => {
            // Simulate a ledger from a previous month
            const pastMonthLedger = JSON.stringify({
                version: 1,
                month: '2024-01',
                totals: { estimatedUsd: 5.00, operations: 100 },
                byProvider: { 'brightdata-serp': { count: 100, estimatedUsd: 5.00 } },
                dailyCounts: { '2024-01-15': { 'brightdata-serp': 50 } },
            });

            const mockFile = new TFile();
            mockFile.path = 'AI-Organiser/Config/research-usage.json';
            mockApp.vault.getAbstractFileByPath.mockReturnValue(mockFile);
            mockApp.vault.read.mockResolvedValue(pastMonthLedger);

            const service = new ResearchUsageService(mockApp, settings);
            await service.ensureLoaded();

            // Month rollover should reset to empty
            const ledger = service.getLedger();
            const now = new Date();
            const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            expect(ledger.month).toBe(currentMonth);
            expect(ledger.totals.operations).toBe(0);
            expect(ledger.totals.estimatedUsd).toBe(0);
        });
    });
});
