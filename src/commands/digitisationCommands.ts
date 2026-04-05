/**
 * Digitisation Commands — Smart Digitisation Feature (Phase 3)
 */
import { Notice, MarkdownView, TFile, Editor, MarkdownFileInfo, Modal } from 'obsidian';
import AIOrganiserPlugin from '../main';
import { logger } from '../utils/logger';
import { VisionService, type DigitiseResult } from '../services/visionService';
import { VisionPreviewModal } from '../ui/modals/VisionPreviewModal';
import { CompressionConfirmModal } from '../ui/modals/CompressionConfirmModal';
import { ImageProcessorService, type ProcessedImage } from '../services/imageProcessorService';
import { withBusyIndicator } from '../utils/busyIndicator';
import { detectEmbeddedContent } from '../utils/embeddedContentDetector';
import { ensurePrivacyConsent } from '../services/privacyNotice';

export function registerDigitisationCommands(plugin: AIOrganiserPlugin) {
    const visionService = new VisionService(plugin);

    // Command: Digitise image
    plugin.addCommand({
        id: 'digitise-image',
        name: plugin.t.commands.digitiseImage || 'Digitise Image',
        icon: 'sparkles',
        editorCallback: async (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
            const view = ctx instanceof MarkdownView ? ctx : null;
            if (!view) return;
            await digitiseImageCommand(plugin, visionService, editor, view);
        }
    });
}

/**
 * Main digitise command handler — supports batch processing of multiple images
 */
async function digitiseImageCommand(
    plugin: AIOrganiserPlugin,
    visionService: VisionService,
    editor: Editor,
    view: MarkdownView
) {
    // Check if provider supports vision
    const canDigitise = visionService.canDigitise();
    if (!canDigitise.supported) {
        new Notice(canDigitise.reason || 'Vision not supported');
        return;
    }

    // Ensure privacy consent for cloud provider (once upfront)
    const serviceType = plugin.settings.serviceType === 'cloud'
        ? plugin.settings.cloudServiceType
        : plugin.settings.serviceType;
    const proceed = await ensurePrivacyConsent(plugin, serviceType);
    if (!proceed) return;

    // Find target image(s)
    const imageFiles = await findTargetImages(plugin, visionService, editor, view);
    if (imageFiles.length === 0) {
        new Notice(plugin.t.digitisation?.noImageFound || 'No image found to digitise');
        return;
    }

    // Process each image sequentially
    for (let i = 0; i < imageFiles.length; i++) {
        const progressMsg = imageFiles.length > 1
            ? `Digitising ${i + 1}/${imageFiles.length}: ${imageFiles[i].basename}...`
            : (plugin.t.digitisation?.digitising || 'Digitising image...');
        await digitiseSingleImage(plugin, visionService, imageFiles[i], progressMsg);
    }
}

/**
 * Process a single image: VLM call (busy), preview (interactive), optional compression
 */
async function digitiseSingleImage(
    plugin: AIOrganiserPlugin,
    visionService: VisionService,
    imageFile: TFile,
    progressMsg: string
): Promise<void> {
    try {
        // VLM call inside busy indicator
        const { result, processedImage } = await withBusyIndicator(plugin,
            () => visionService.digitiseWithImage(imageFile), progressMsg);

        // Preview modal OUTSIDE busy indicator (user decision)
        const imageDataUrl = await loadImageDataUrl(plugin.app, imageFile);
        const action = await showVisionPreview(plugin, result, imageDataUrl);

        if (action === 'insert') {
            new Notice(plugin.t.digitisation?.inserted || 'Digitised content inserted');
        } else if (action === 'copy') {
            new Notice(plugin.t.digitisation?.copied || 'Copied to clipboard');
        }

        // Compression offer OUTSIDE busy indicator
        if (action !== 'discard' && shouldOfferCompression(plugin, imageFile, processedImage)) {
            await offerImageCompression(plugin, imageFile, processedImage);
        }
    } catch (error) {
        logger.error('Digitise', 'Error:', error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        new Notice(`Digitisation failed: ${errorMessage}`);
    }
}

/**
 * Promise-wrap VisionPreviewModal for deterministic chaining
 */
function showVisionPreview(
    plugin: AIOrganiserPlugin,
    result: DigitiseResult,
    imageDataUrl: string
): Promise<'insert' | 'copy' | 'discard'> {
    return new Promise(resolve => {
        new VisionPreviewModal(plugin, result, imageDataUrl, resolve).open();
    });
}

/**
 * Determine if image compression offer should be shown (image-scoped; audio uses postRecordingStorage).
 */
export function shouldOfferCompression(
    plugin: AIOrganiserPlugin,
    file: TFile,
    processed: ProcessedImage
): boolean {
    const setting = plugin.settings.offerMediaCompression;
    if (setting === 'never') return false;

    // Only offer if there's meaningful savings (>10%)
    if (processed.originalSizeBytes > 0) {
        const savingsPercent = 1 - (processed.processedSizeBytes / processed.originalSizeBytes);
        if (savingsPercent < 0.1) return false;
    }

    // Must have replacement blob available
    if (!processed.replacementBlob) return false;

    if (setting === 'always') return true;
    // 'large-files'
    return file.stat.size > plugin.settings.mediaCompressionThreshold;
}

/**
 * Show compression confirm modal and perform replacement if user accepts
 */
async function offerImageCompression(
    plugin: AIOrganiserPlugin,
    imageFile: TFile,
    processedImage: ProcessedImage
): Promise<void> {
    const modal = new CompressionConfirmModal(
        plugin,
        processedImage.originalSizeBytes,
        processedImage.processedSizeBytes,
        imageFile.name,
        processedImage.wasConverted
    );
    modal.open();
    const choice = await modal.waitForChoice();

    if (choice.action !== 'keep-compressed' || !processedImage.replacementBlob) return;

    try {
        const imageProcessor = new ImageProcessorService(plugin.app);
        const replaceResult = await imageProcessor.replaceOriginal(
            imageFile, processedImage.replacementBlob, processedImage.mediaType
        );
        const t = plugin.t.compression;
        const msg = replaceResult.backlinksMigrated > 0
            ? `${t?.replaceSuccess || 'File replaced'} (${(t?.backlinksMigrated || '{n} backlinks updated').replace('{n}', String(replaceResult.backlinksMigrated))})`
            : t?.replaceSuccess || 'File replaced successfully';
        new Notice(msg);
    } catch (err) {
        logger.error('Digitise', 'Replace failed:', err);
        new Notice(plugin.t.compression?.replaceFailed || 'Failed to replace file');
    }
}

/**
 * Find target image(s) to digitise.
 * Priority:
 * 1. Cursor on/near image embed (within ±3 lines) → single-element array
 * 2. Single image in note → single-element array
 * 3. Multiple images → multi-select picker
 * Exported for testability.
 */
export async function findTargetImages(
    plugin: AIOrganiserPlugin,
    visionService: VisionService,
    editor: Editor,
    view: MarkdownView
): Promise<TFile[]> {
    const content = editor.getValue();
    const cursor = editor.getCursor();

    // Strategy 1: Find image near cursor
    const nearestImage = visionService.findNearestImage(content, cursor.line, 3);
    if (nearestImage && nearestImage.resolvedFile instanceof TFile) {
        return [nearestImage.resolvedFile];
    }

    // Strategy 2: Detect all images in note
    const detectionResult = detectEmbeddedContent(plugin.app, content, view.file || undefined);
    const images = detectionResult.items.filter(
        item => item.type === 'image' && item.resolvedFile instanceof TFile
    );

    if (images.length === 0) {
        return [];
    }

    if (images.length === 1) {
        const file = images[0].resolvedFile;
        return file instanceof TFile ? [file] : [];
    }

    // Strategy 3: Multiple images — show multi-select picker
    const resolved = images.map(img => img.resolvedFile).filter((f): f is TFile => f instanceof TFile);
    return await showMultiImagePicker(plugin, resolved);
}

/** Max images to auto-select to avoid accidental VLM cost */
const MAX_AUTO_SELECT = 5;

/**
 * Show multi-select picker modal for batch digitisation.
 * Exported for testability.
 */
export async function showMultiImagePicker(plugin: AIOrganiserPlugin, images: TFile[]): Promise<TFile[]> {
    return new Promise((resolve) => {
        class MultiImagePickerModal extends Modal {
            private readonly selectedSet = new Set<TFile>();
            private confirmed = false;
            private ctaButton!: HTMLButtonElement;

            onOpen() {
                const { contentEl } = this;
                contentEl.empty();
                contentEl.addClass('ai-organiser-multi-image-picker');

                const t = plugin.t.digitisation;

                contentEl.createEl('h2', {
                    text: t?.selectImages || 'Select Images to Digitise'
                });

                // Select All / Deselect All controls
                const controls = contentEl.createEl('div', { cls: 'select-controls' });
                const selectAllBtn = controls.createEl('button', {
                    text: t?.selectAll || 'Select All'
                });
                const deselectAllBtn = controls.createEl('button', {
                    text: t?.deselectAll || 'Deselect All'
                });

                selectAllBtn.onclick = () => {
                    images.forEach(img => this.selectedSet.add(img));
                    this.updateCheckboxes(contentEl);
                };
                deselectAllBtn.onclick = () => {
                    this.selectedSet.clear();
                    this.updateCheckboxes(contentEl);
                };

                // Image list with checkboxes
                const list = contentEl.createEl('div', { cls: 'ai-organiser-image-picker-list' });

                // Pre-select if ≤ threshold
                if (images.length <= MAX_AUTO_SELECT) {
                    images.forEach(img => this.selectedSet.add(img));
                }

                for (const image of images) {
                    const item = list.createEl('label', { cls: 'ai-organiser-image-picker-item' });
                    const checkbox = item.createEl('input', { type: 'checkbox' });
                    checkbox.checked = this.selectedSet.has(image);
                    checkbox.dataset.path = image.path;
                    checkbox.onchange = () => {
                        if (checkbox.checked) {
                            this.selectedSet.add(image);
                        } else {
                            this.selectedSet.delete(image);
                        }
                        this.updateCta();
                    };
                    const textContainer = item.createEl('span', { cls: 'ai-organiser-image-picker-label' });
                    textContainer.createEl('span', { text: image.basename });
                    textContainer.createEl('small', { text: ` (${image.parent?.path || ''})` });
                }

                // Action buttons
                const buttonContainer = contentEl.createEl('div', { cls: 'modal-button-container' });
                const cancelButton = buttonContainer.createEl('button', {
                    text: plugin.t.common?.cancel || 'Cancel'
                });
                cancelButton.onclick = () => {
                    this.selectedSet.clear();
                    this.close();
                };
                this.ctaButton = buttonContainer.createEl('button', { cls: 'mod-cta' });
                this.updateCta();
                this.ctaButton.onclick = () => {
                    this.confirmed = true;
                    this.close();
                };
            }

            private updateCta() {
                const count = this.selectedSet.size;
                const t = plugin.t.digitisation;
                this.ctaButton.textContent = (t?.digitiseCount || 'Digitise {count} images')
                    .replace('{count}', String(count));
                this.ctaButton.disabled = count === 0;
            }

            private updateCheckboxes(container: HTMLElement) {
                const checkboxes = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
                checkboxes.forEach(cb => {
                    const img = images.find(i => i.path === cb.dataset.path);
                    cb.checked = img ? this.selectedSet.has(img) : false;
                });
                this.updateCta();
            }

            onClose() {
                const { contentEl } = this;
                contentEl.empty();
                // Only return selections if user explicitly clicked the CTA button
                resolve(this.confirmed ? [...this.selectedSet] : []);
            }
        }

        new MultiImagePickerModal(plugin.app).open();
    });
}

/**
 * Load image as data URL for preview
 */
async function loadImageDataUrl(app: import('obsidian').App, file: TFile): Promise<string> {
    const arrayBuffer = await app.vault.readBinary(file);
    const blob = new Blob([arrayBuffer]);

    // Convert to base64 data URL
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (typeof reader.result === 'string') {
                resolve(reader.result);
            } else {
                reject(new Error('Failed to read image as data URL'));
            }
        };
        reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
        reader.readAsDataURL(blob);
    });
}
