/**
 * Research Usage Service
 *
 * Tracks operation counts and estimated spend by day/month/provider/tier.
 * Provides budget status snapshots and guardrail enforcement (AD-11, AD-12).
 * Persists to AI-Organiser/Config/research-usage.json.
 */

import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { AIOrganiserSettings } from '../../core/settings';
import { resolvePluginPath } from '../../core/settings';
import { ensureFolderExists } from '../../utils/minutesUtils';
import type { PaidTier, UsageLedger, ResearchBudgetStatus, BudgetStatusLevel } from './researchTypes';
import { logger } from '../../utils/logger';

/** Per-operation cost estimates (AD-18). Not billing-accurate — documented approximations. */
const COST_PER_OPERATION: Record<PaidTier, number> = {
    'brightdata-serp': 0.003,
    'web-unlocker': 0.001,
    'scraping-browser': 0.010,
    'claude-web-search': 0.010,
};

function createEmptyLedger(): UsageLedger {
    const now = new Date();
    return {
        version: 1,
        month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
        totals: { estimatedUsd: 0, operations: 0 },
        byProvider: {},
        dailyCounts: {},
    };
}

function getCurrentMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function getTodayKey(): string {
    const now = new Date();
    return now.toISOString().slice(0, 10);
}

export class ResearchUsageService {
    private ledger: UsageLedger;
    private readonly filePath: string;
    private loaded = false;

    constructor(
        private app: App,
        private settings: AIOrganiserSettings,
    ) {
        this.ledger = createEmptyLedger();
        const folder = resolvePluginPath(settings, 'Config', 'Config');
        this.filePath = `${folder}/research-usage.json`;
    }

    /** Ensure ledger is loaded from disk. Idempotent. */
    async ensureLoaded(): Promise<void> {
        if (this.loaded) return;
        this.ledger = await this.loadLedger();
        this.checkMonthRollover();
        this.loaded = true;
    }

    /** Record a single paid operation. Persists to disk after recording. */
    async recordOperation(tier: PaidTier): Promise<void> {
        await this.ensureLoaded();
        this.checkMonthRollover();

        const cost = COST_PER_OPERATION[tier] ?? 0;
        this.ledger.totals.estimatedUsd += cost;
        this.ledger.totals.operations += 1;

        if (!this.ledger.byProvider[tier]) {
            this.ledger.byProvider[tier] = { count: 0, estimatedUsd: 0 };
        }
        this.ledger.byProvider[tier].count += 1;
        this.ledger.byProvider[tier].estimatedUsd += cost;

        // Track daily counts for informational display
        const today = getTodayKey();
        if (!this.ledger.dailyCounts) this.ledger.dailyCounts = {};
        if (!this.ledger.dailyCounts[today]) this.ledger.dailyCounts[today] = {};
        this.ledger.dailyCounts[today][tier] = (this.ledger.dailyCounts[today][tier] || 0) + 1;

        await this.persistLedger();
    }

    /** Record a free-tier operation for informational tracking only. */
    async recordFreeOperation(provider: string): Promise<void> {
        await this.ensureLoaded();
        const today = getTodayKey();
        if (!this.ledger.dailyCounts) this.ledger.dailyCounts = {};
        if (!this.ledger.dailyCounts[today]) this.ledger.dailyCounts[today] = {};
        this.ledger.dailyCounts[today][provider] = (this.ledger.dailyCounts[today][provider] || 0) + 1;
        await this.persistLedger();
    }

    /** Get current budget status against configured thresholds. */
    getBudgetStatus(): ResearchBudgetStatus {
        if (!this.settings.enableResearchUsageGuardrails) {
            return { level: 'ok', estimatedSpendUsd: this.ledger.totals.estimatedUsd, budgetUsd: 0, percentUsed: 0 };
        }

        const budget = this.settings.researchMonthlyBudgetUsd;
        const spent = this.ledger.totals.estimatedUsd;
        const percent = budget > 0 ? Math.round((spent / budget) * 100) : 0;

        let level: BudgetStatusLevel = 'ok';
        let message: string | undefined;

        if (this.settings.researchBlockAtLimit && percent >= 100) {
            level = 'blocked';
            message = `Monthly budget limit reached (~$${spent.toFixed(2)}).`;
        } else if (percent >= this.settings.researchWarnThresholdPercent) {
            level = 'warn';
            message = `Estimated spend: ~$${spent.toFixed(2)} of $${budget.toFixed(2)} monthly budget (${percent}%)`;
        }

        return { level, estimatedSpendUsd: spent, budgetUsd: budget, percentUsed: percent, message };
    }

    /** Get formatted summary for UI display. */
    getUsageSummary(): { estimatedUsd: string; operations: number; status: BudgetStatusLevel } {
        const status = this.getBudgetStatus();
        return {
            estimatedUsd: `$${this.ledger.totals.estimatedUsd.toFixed(2)}`,
            operations: this.ledger.totals.operations,
            status: status.level,
        };
    }

    /**
     * Convenience check for a specific tier. Returns whether the operation is allowed
     * and an optional user-facing message (warning or block reason).
     * Orchestrator calls this before each paid operation.
     */
    checkBudget(tier: PaidTier): { allowed: boolean; message?: string } {
        if (!this.settings.enableResearchUsageGuardrails) {
            return { allowed: true };
        }

        const status = this.getBudgetStatus();
        if (status.level === 'blocked') {
            const budget = this.settings.researchMonthlyBudgetUsd;
            return {
                allowed: false,
                message: `Monthly budget limit reached (~$${status.estimatedSpendUsd.toFixed(2)} of $${budget.toFixed(2)}). Override or adjust budget in settings.`,
            };
        }
        if (status.level === 'warn') {
            return { allowed: true, message: status.message };
        }
        return { allowed: true };
    }

    /** Reset ledger to empty state. Used from settings UI. */
    async resetUsage(): Promise<void> {
        this.ledger = createEmptyLedger();
        await this.persistLedger();
    }

    /** Get raw ledger for settings display. */
    getLedger(): UsageLedger {
        return { ...this.ledger };
    }

    // ═══ PRIVATE ═══

    /** Load ledger from disk. Handles malformed files gracefully (AD-11). */
    private async loadLedger(): Promise<UsageLedger> {
        try {
            const file = this.app.vault.getAbstractFileByPath(this.filePath);
            if (!file || !(file instanceof TFile)) return createEmptyLedger();

            const content = await this.app.vault.read(file);
            let parsed: any;
            try {
                parsed = JSON.parse(content);
            } catch {
                // JSON parse failure — backup corrupt file, start fresh
                logger.warn('Research', 'Research usage ledger corrupt (invalid JSON), creating backup and starting fresh');
                await this.app.vault.rename(file, this.filePath + '.bak');
                return createEmptyLedger();
            }

            if (!parsed.version || typeof parsed.version !== 'number') {
                // Parsed but malformed — rename to backup, start fresh
                logger.warn('Research', 'Research usage ledger malformed, creating backup and starting fresh');
                await this.app.vault.rename(file, this.filePath + '.bak');
                return createEmptyLedger();
            }

            return parsed as UsageLedger;
        } catch {
            // File access failure
            return createEmptyLedger();
        }
    }

    /** Check if month has rolled over; reset if so. */
    private checkMonthRollover(): void {
        const currentMonth = getCurrentMonth();
        if (this.ledger.month !== currentMonth) {
            this.ledger = createEmptyLedger();
        }
    }

    /** Persist ledger to disk. */
    private async persistLedger(): Promise<void> {
        try {
            const folder = resolvePluginPath(this.settings, 'Config', 'Config');
            await ensureFolderExists(this.app.vault, folder);
            const json = JSON.stringify(this.ledger, null, 2);
            const file = this.app.vault.getAbstractFileByPath(this.filePath);
            if (file && file instanceof TFile) {
                await this.app.vault.modify(file, json);
            } else {
                await this.app.vault.create(this.filePath, json);
            }
        } catch (e) {
            logger.warn('Research', 'Failed to persist research usage ledger:', e);
        }
    }
}
