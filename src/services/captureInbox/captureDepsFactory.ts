/**
 * Wires the capture runtime to the real plugin: the existing transcription service, the existing
 * digitisation pipeline, the existing tagging prompt and provider, the sweep's policy and ledger. This is
 * the only file of the feature that knows the plugin object; everything else takes injected deps.
 */
import { TFile, TFolder } from 'obsidian';
import type AIOrganiserPlugin from '../../main';
import { ok, err } from '../../core/result';
import { isInsideOrEqual, normalisePath } from '../../core/protectedPaths';
import { getAudioTranscriptionApiKey } from '../apiKeyHelpers';
import { transcribeAudioFromData } from '../audioTranscriptionService';
import { sha256Hex } from '../attachmentDuplicateService';
import { isFeatureEnabled } from '../featureService';
import { sweepPolicy } from '../inboxSweep/sweepCommit';
import { isSwept } from '../inboxSweep/sweepLedger';
import { VisionService } from '../visionService';
import { TagUtils } from '../../utils/tagUtils';
import { captureOutputRoots, readCaptureConfig } from './captureConfig';
import type { CaptureJournalStore } from './captureJournalStore';
import { pathExclusion } from './capturePolicy';
import type { RuntimeDeps } from './captureRuntime';
import { createVaultPort } from './captureVaultPort';
import { createWriterPort, type WriterDeps } from './captureWriter';

export function buildRuntimeDeps(plugin: AIOrganiserPlugin, store: CaptureJournalStore): RuntimeDeps {
    const { app } = plugin;
    const vault = createVaultPort(app);
    const config = () => readCaptureConfig(plugin.settings);
    const policy = () => sweepPolicy(plugin);
    const now = () => Date.now();
    const sweptAlready = async (path: string, text: string): Promise<boolean> =>
        isSwept(plugin.settings.sweepLedger, path, await sha256Hex(new TextEncoder().encode(text).buffer));
    const outputRoots = () => captureOutputRoots(plugin.settings);

    const writer: WriterDeps = {
        port: createWriterPort(plugin),
        journal: store,
        config,
        policy,
        isSwept: sweptAlready,
        protectedFolders: () => plugin.settings.protectedFolders,
        outputRoots,
        now,
    };

    return {
        journal: store,
        config,
        policy,
        port: vault,
        vault,
        isSwept: sweptAlready,
        isEnabled: () => isFeatureEnabled(plugin.settings, 'capture-inbox'),
        now,
        digitisationEnabled: () => isFeatureEnabled(plugin.settings, 'digitisation'),
        transcribe: async (bytes, fileName, extension) => {
            const resolved = await getAudioTranscriptionApiKey(plugin);
            if (!resolved) return err('The transcription provider is not configured.');
            const result = await transcribeAudioFromData(bytes, fileName, {
                provider: resolved.provider,
                apiKey: resolved.key,
                azureEndpoint: resolved.azureEndpoint,
                extension,
            });
            return result.success && typeof result.transcript === 'string' ? ok(result.transcript) : err(result.error ?? 'Transcription failed');
        },
        digitise: async (path) => {
            const file = app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) return err('The image is gone.');
            try {
                const result = await new VisionService(plugin).digitise(file);
                return ok(result.extractedText);
            } catch (e) {
                return err(e instanceof Error ? e.message : 'Image reading failed');
            }
        },
        // The shared tagging prompt through the public provider route. The Azure triage route and the taxonomy
        // guardrail are deliberately not used: the proposal is reviewed by the user before anything is written.
        classify: async (parts) => {
            const res = await plugin.llmService.generateTags(parts.prompt, { stablePrefix: parts.stablePrefix, label: 'capture-inbox' });
            return res.success ? ok({ tags: res.tags, suggestedTitle: res.suggestedTitle, suggestedFolder: res.suggestedFolder }) : err(res.error ?? 'Tagging failed');
        },
        taxonomyPrompt: () => plugin.configService.getTaxonomyForPrompt(),
        language: () => plugin.settings.language,
        maxTags: () => plugin.settings.maxTags,
        formatTags: (tags) => TagUtils.formatTags(tags),
        listFolders: () =>
            app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder && f.path !== '/').map((f) => f.path),
        folderAllowed: (path) =>
            pathExclusion(path, policy()) === null && !outputRoots().some((root) => isInsideOrEqual(normalisePath(path), root)),
        writer,
        isVisible: () => activeDocument.visibilityState === 'visible',
        autoRunAllowed: () => plugin.settings.captureConfirmedAt !== '',
    };
}
