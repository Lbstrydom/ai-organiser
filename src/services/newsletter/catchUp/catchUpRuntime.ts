/**
 * Catch-up runtime — binds the orchestration's ports to the real plugin.
 *
 * The only place that knows about the LLM facade, the TTS key chain, the prompt builders and
 * story memory together. Everything else in `catchUp/` is injected-and-tested; this is the thin
 * seam that wires it to production.
 */

import type AIOrganiserPlugin from '../../../main';
import { ok, err, type Result } from '../../../core/result';
import { logger } from '../../../utils/logger';
import { summarizeText, pluginContext } from '../../llmFacade';
import { getMaxContentCharsForModel } from '../../tokenLimits';
import { getLanguageNameForPrompt } from '../../languages';
import { GeminiTtsEngine } from '../../tts/ttsEngine';
import { NARRATION_PROVIDERS } from '../../tts/ttsProviderRegistry';
import { isAzureMode } from '../../azure/endpointResolver';
import { isStoryMemoryEnabled } from '../newsletterMemoryPolicy';
import { loadLedger } from '../newsletterStoryLedger';
import { loadConsumption } from '../newsletterConsumption';
import { selectRecall } from '../newsletterRecall';
import { resolveNewsletterTts } from '../resolveNewsletterTts';
import type { RecallSelection } from '../newsletterMemoryTypes';
import {
    buildCatchUpScriptPrompt,
    buildShortenPrompt,
    insertCatchUpContent,
    recallForCatchUp,
} from './catchUpPrompts';
import type { CatchUpPorts, TtsResolution } from './catchUpService';
import type { TidyDeps } from './catchUpTidy';
import type { CatchUpPlan } from './catchUpTypes';
import { estimateSpokenChars } from './catchUpCoverage';

function memoryOrRegion(region: string | undefined): string | undefined {
    const trimmed = (region ?? '').trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

/** Light de-markdown for the ear: the prompt forbids markdown, this catches the stragglers. */
export function cleanSpokenScript(text: string): string {
    return text
        .replaceAll(/^#{1,6}\s+/gm, '')
        .replaceAll(/\*\*(.+?)\*\*/g, '$1')
        .replaceAll(/^\s*[-*]\s+/gm, '')
        .replaceAll(/\n{3,}/g, '\n\n')
        .trim();
}

async function resolveTts(plugin: AIOrganiserPlugin): Promise<TtsResolution> {
    const r = await resolveNewsletterTts(plugin);
    if (!r.ok) {
        // The notice text names the exact missing setting; the guidance code carries the next step.
        logger.warn('Newsletter', r.logWarn ?? r.notice);
        return { ok: false, code: 'catchup-no-tts' };
    }
    if (r.engine) {
        return { ok: true, tts: { engine: r.engine, providerId: r.engine.providerId, modelId: r.modelId ?? r.engine.providerId } };
    }
    const provider = NARRATION_PROVIDERS.gemini;
    const modelId = provider.getEffectiveModelId?.() ?? provider.modelId;
    return { ok: true, tts: { engine: new GeminiTtsEngine(r.apiKey, modelId), providerId: 'gemini', modelId } };
}

async function recallFor(plugin: AIOrganiserPlugin, plan: CatchUpPlan): Promise<RecallSelection | undefined> {
    if (!isStoryMemoryEnabled(plugin.settings)) return undefined;
    try {
        const [ledger, consumption] = await Promise.all([loadLedger(plugin), loadConsumption(plugin)]);
        return recallForCatchUp(selectRecall(ledger, consumption, plan.to), new Set(plan.entries.map((e) => e.date)));
    } catch (e) {
        logger.warn('Newsletter', 'Story memory unavailable — the catch-up is written without it', e);
        return undefined;
    }
}

export function createCatchUpPorts(plugin: AIOrganiserPlugin): CatchUpPorts {
    const settings = plugin.settings;
    const languageOf = () => getLanguageNameForPrompt(settings.newsletterPreferredLanguage) || undefined;

    return {
        app: plugin.app,
        plugin,
        settings,
        resolveTts: () => resolveTts(plugin),

        async generateScript(plan: CatchUpPlan, signal?: AbortSignal): Promise<Result<string>> {
            const cloudType = settings.cloudServiceType;
            const provider = settings.serviceType === 'local' ? 'local' : cloudType;
            const model = settings.serviceType === 'local' ? undefined : settings.providerSettings?.[cloudType]?.model;
            const prompt = buildCatchUpScriptPrompt({
                language: languageOf(),
                from: plan.from,
                to: plan.to,
                dayCount: plan.entries.length,
                capMinutes: plan.length.capMinutes,
                recall: await recallFor(plugin, plan),
                homeRegion: memoryOrRegion(settings.newsletterHomeRegion),
            });
            const { filled } = insertCatchUpContent(prompt, plan.entries, getMaxContentCharsForModel(provider, model));
            // Trimming a day's text to fit is fine; DROPPING a whole day is not, because the episode
            // would then claim coverage of material it never saw. Fail closed.
            const included = (filled.match(/^--- SOURCE: /gm) ?? []).length;
            if (included < plan.entries.length) {
                logger.warn('Newsletter', `Catch-up input exceeds the model budget: ${plan.entries.length - included} day(s) would be dropped`);
                return err('catchup-too-much');
            }
            try {
                const res = await summarizeText(pluginContext(plugin), filled, { signal });
                if (res.success && res.content) return ok(cleanSpokenScript(res.content));
                return err(res.error ?? 'empty response');
            } catch (e) {
                return err(e instanceof Error ? e.message : String(e));
            }
        },

        async shortenScript(script: string, wordBudget: number, signal?: AbortSignal): Promise<Result<string>> {
            try {
                const res = await summarizeText(pluginContext(plugin), buildShortenPrompt(script, wordBudget, languageOf()), { signal });
                if (res.success && res.content) return ok(cleanSpokenScript(res.content));
                return err(res.error ?? 'empty response');
            } catch (e) {
                return err(e instanceof Error ? e.message : String(e));
            }
        },
    };
}

/**
 * What the daily-audio tidy needs from the plugin: the note writer and the sentence for the dead embed.
 * The digest edit is a deterministic mechanical change to a plugin-generated note under the newsletter
 * folder (same documented exemption from reviewed edits as the audio cleanup); a baseline mismatch refuses it.
 */
export function createDailyTidyDeps(plugin: AIOrganiserPlugin): TidyDeps {
    return {
        app: plugin.app,
        plugin,
        settings: plugin.settings,
        writeNote: async (filePath, baseline, nextContent) => {
            const { applyNoteEdit } = await import('../../noteEdit/applyNoteEdit');
            return applyNoteEdit(plugin, { kind: 'full-replace', filePath, baseline, nextContent }, { review: false });
        },
        removedLine: (date) => plugin.t.settings.newsletter.catchUp.audioRemovedLine.replace('{date}', date),
    };
}

export interface CostPreview {
    /** Estimated TTS cost in USD, or null when it depends on a plan we cannot see (Azure). */
    ttsUsd: number | null;
    spokenChars: number;
}

/** Preview numbers only. The LLM cost is not priced: the user's model is unknown to us. */
export function previewCost(plugin: AIOrganiserPlugin, capMinutes: number): CostPreview {
    const spokenChars = estimateSpokenChars(capMinutes);
    if (isAzureMode(plugin.settings)) return { ttsUsd: null, spokenChars };
    return { ttsUsd: (spokenChars / 1_000_000) * NARRATION_PROVIDERS.gemini.costPerMillionCharsUsd, spokenChars };
}
