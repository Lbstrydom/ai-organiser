/**
 * Digitisation utilities — shared helpers for image digitisation workflows.
 * Service-level (no UI dependencies) so both commands and modals can use them.
 */
import { TFile, App } from 'obsidian';
import type { DigitiseResult } from '../services/visionService';
import type { VisionService } from '../services/visionService';

/**
 * Build combined markdown from a DigitiseResult.
 * Moved from VisionPreviewModal to avoid UI→command dependency direction.
 */
export function buildDigitiseMarkdown(result: DigitiseResult): string {
    const parts: string[] = [];

    if (result.extractedText) {
        parts.push(result.extractedText);
    }

    if (result.diagram) {
        parts.push('', '## Diagram', '', '```mermaid', result.diagram, '```');
    }

    if (result.uncertainties && result.uncertainties.length > 0) {
        parts.push('', '## Uncertainties', '');
        for (const uncertainty of result.uncertainties) {
            parts.push(`- ${uncertainty}`);
        }
    }

    return parts.join('\n');
}

/**
 * Resolve vault image path to TFile.
 * Tries getFirstLinkpathDest (wiki-link resolution) then getAbstractFileByPath (direct path).
 */
export function resolveImageFile(app: App, imagePath: string, contextPath?: string): TFile | null {
    // Try wiki-link resolution first
    const resolved = app.metadataCache.getFirstLinkpathDest(imagePath, contextPath || '');
    if (resolved instanceof TFile) return resolved;

    // Fallback to direct path
    const direct = app.vault.getAbstractFileByPath(imagePath);
    if (direct instanceof TFile) return direct;

    return null;
}

/**
 * Digitise a vault image and return extracted markdown text.
 * Shared by both multi-source summarize and translate handlers.
 */
export async function extractImageText(
    visionService: VisionService,
    app: App,
    imagePath: string,
    contextPath?: string
): Promise<{ text: string; file: TFile } | { error: string }> {
    const file = resolveImageFile(app, imagePath, contextPath);
    if (!file) return { error: 'Image file not found in vault' };

    const result = await visionService.digitise(file);
    return { text: buildDigitiseMarkdown(result), file };
}
