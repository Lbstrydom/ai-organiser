/**
 * Image Processing Service — Phase 2
 * Centralised image loading, format conversion, compression, and resizing for VLM processing
 * 
 * Supported conversions:
 * - BMP, TIFF, AVIF → JPEG
 * - SVG → PNG (rasterisation)
 * - HEIC/HEIF → NOT SUPPORTED (throws error with guidance)
 */
import { TFile, App } from 'obsidian';
import { getAvailableFilePath } from '../utils/minutesUtils';
import {
    IMAGE_CONVERSION_REQUIRED,
    VLM_NATIVE_IMAGE_FORMATS,
    DEFAULT_IMAGE_MAX_DIMENSION,
    DEFAULT_IMAGE_QUALITY,
    MEDIA_SIZE_WARN_BYTES
} from '../core/constants';

export interface ProcessedImage {
    base64: string;              // Base64-encoded image data (without data: prefix)
    mediaType: string;           // e.g. 'image/jpeg', 'image/png'
    width: number;               // Final dimensions after processing
    height: number;
    originalSizeBytes: number;   // Original file size
    processedSizeBytes: number;  // Final base64 size estimate
    wasConverted: boolean;       // true if format changed (BMP→JPEG, SVG→PNG, etc.)
    wasResized: boolean;         // true if dimensions reduced
    replacementBlob?: ArrayBuffer; // Raw bytes for vault replacement (only when includeBlob=true)
}

export interface ImageProcessOptions {
    maxDimension?: number;       // Default: 1536 (longest edge)
    quality?: number;            // Default: 0.85 (JPEG quality 0-1)
    forceFormat?: 'image/jpeg' | 'image/png';  // Force output format
    includeBlob?: boolean;       // Also capture raw bytes for vault replacement
}

export interface ReplaceResult {
    newFile: TFile;
    backlinksMigrated: number;
    oldPath: string;
    newPath: string;
}

export class ImageProcessorService {
    constructor(private app: App) {}

    /**
     * Process an image file from vault: load → convert → resize → compress → base64
     * @param file - Image file from Obsidian vault
     * @param options - Processing options
     * @returns Processed image with base64 data
     */
    async processImage(file: TFile, options?: ImageProcessOptions): Promise<ProcessedImage> {
        const opts = {
            maxDimension: options?.maxDimension ?? DEFAULT_IMAGE_MAX_DIMENSION,
            quality: options?.quality ?? DEFAULT_IMAGE_QUALITY,
            forceFormat: options?.forceFormat,
            includeBlob: options?.includeBlob ?? false
        };

        // Read file as ArrayBuffer
        const arrayBuffer = await this.app.vault.readBinary(file);
        const originalSizeBytes = arrayBuffer.byteLength;
        const blob = new Blob([arrayBuffer]);

        // Determine media type from extension
        const extension = file.extension.toLowerCase();
        const originalMediaType = this.getMediaTypeFromExtension(extension);

        // Check if conversion is needed
        const needsConversion = IMAGE_CONVERSION_REQUIRED.includes(`.${extension}`);
        let processedBlob = blob;
        let wasConverted = false;
        let targetMediaType = originalMediaType;

        if (needsConversion || opts.forceFormat) {
            if (extension === 'heic' || extension === 'heif') {
                // HEIC conversion (lazy-load heic-to if available, else throw)
                processedBlob = await this.convertHeic(blob);
                wasConverted = true;
                targetMediaType = 'image/jpeg';
            } else if (extension === 'svg') {
                // SVG → PNG rasterisation
                processedBlob = await this.rasteriseSvg(blob);
                wasConverted = true;
                targetMediaType = 'image/png';
            } else if (['bmp', 'tiff', 'tif', 'avif'].includes(extension)) {
                // Generic conversion via canvas → JPEG
                processedBlob = await this.convertToJpeg(blob);
                wasConverted = true;
                targetMediaType = 'image/jpeg';
            }
        }

        // Apply forced format if specified
        if (opts.forceFormat && targetMediaType !== opts.forceFormat) {
            if (opts.forceFormat === 'image/jpeg') {
                processedBlob = await this.convertToJpeg(processedBlob);
            } else {
                processedBlob = await this.convertToPng(processedBlob);
            }
            wasConverted = true;
            targetMediaType = opts.forceFormat;
        }

        // Load into HTMLImageElement
        const img = await this.blobToImage(processedBlob);
        const originalWidth = img.naturalWidth;
        const originalHeight = img.naturalHeight;

        // Resize if needed
        let canvas: HTMLCanvasElement;
        let wasResized = false;
        const longestEdge = Math.max(originalWidth, originalHeight);

        if (longestEdge > opts.maxDimension) {
            canvas = await this.resize(img, opts.maxDimension);
            wasResized = true;
        } else {
            // No resize needed — draw to canvas at original size
            canvas = document.createElement('canvas');
            canvas.width = originalWidth;
            canvas.height = originalHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Failed to get 2D context');
            ctx.drawImage(img, 0, 0);
        }

        // Convert canvas to base64 and validate actual MIME type returned
        const { base64, actualMediaType } = await this.canvasToBase64(canvas, targetMediaType, opts.quality);
        const processedSizeBytes = Math.ceil((base64.length * 3) / 4); // Estimate from base64 length

        // Optionally capture raw blob for vault replacement
        let replacementBlob: ArrayBuffer | undefined;
        if (opts.includeBlob) {
            replacementBlob = await this.canvasToArrayBuffer(canvas, actualMediaType, opts.quality);
        }

        return {
            base64,
            mediaType: actualMediaType, // Use actual type, not requested
            width: canvas.width,
            height: canvas.height,
            originalSizeBytes,
            processedSizeBytes,
            wasConverted,
            wasResized,
            replacementBlob
        };
    }

    /**
     * Process an image from base64 string (for external images)
     * @param base64 - Base64 image data (with or without data: prefix)
     * @param mediaType - Original media type
     * @param options - Processing options
     */
    /**
     * Process image from base64 string (for external images)
     * Supports conversion pipeline for non-native formats (BMP, TIFF, AVIF, SVG)
     * @param base64 - Base64 string (with or without data: prefix)
     * @param mediaType - Image media type (e.g., 'image/jpeg')
     * @param options - Processing options
     * @returns Processed image with metadata
     */
    async processImageFromBase64(
        base64: string,
        mediaType: string,
        options?: ImageProcessOptions
    ): Promise<ProcessedImage> {
        // Strip data: prefix if present
        const base64Data = base64.includes(',') ? base64.split(',')[1] : base64;
        const originalSizeBytes = Math.ceil((base64Data.length * 3) / 4);

        // Convert to blob
        const byteString = atob(base64Data);
        const byteArray = new Uint8Array(byteString.length);
        for (let i = 0; i < byteString.length; i++) {
            byteArray[i] = byteString.charCodeAt(i);
        }
        let blob = new Blob([byteArray], { type: mediaType });

        // Check if conversion is needed based on media type
        let wasConverted = false;
        const needsConversion = !VLM_NATIVE_IMAGE_FORMATS.includes(mediaType);
        
        if (needsConversion) {
            // HEIC/HEIF not supported
            if (mediaType === 'image/heic' || mediaType === 'image/heif') {
                throw new Error(
                    'HEIC format not supported. ' +
                    'Please convert to JPEG using your device settings (iPhone: Settings → Camera → Formats → Most Compatible) ' +
                    'or use an Obsidian plugin like "Image Converter".'
                );
            }
            
            // Convert based on format
            if (mediaType === 'image/svg+xml') {
                blob = await this.rasteriseSvg(blob);
                wasConverted = true;
            } else {
                // BMP, TIFF, AVIF, or other non-native formats → JPEG
                blob = await this.convertToJpeg(blob);
                wasConverted = true;
            }
        }

        // Load into image
        const img = await this.blobToImage(blob);

        const opts = {
            maxDimension: options?.maxDimension ?? DEFAULT_IMAGE_MAX_DIMENSION,
            quality: options?.quality ?? DEFAULT_IMAGE_QUALITY,
            forceFormat: options?.forceFormat
        };

        // Resize if needed
        let canvas: HTMLCanvasElement;
        let wasResized = false;
        const longestEdge = Math.max(img.naturalWidth, img.naturalHeight);

        if (longestEdge > opts.maxDimension) {
            canvas = await this.resize(img, opts.maxDimension);
            wasResized = true;
        } else {
            canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth;
            canvas.height = img.naturalHeight;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Failed to get 2D context');
            ctx.drawImage(img, 0, 0);
        }

        // Determine target format (may have been converted already)
        let requestedMediaType = wasConverted 
            ? (mediaType === 'image/svg+xml' ? 'image/png' : 'image/jpeg')
            : mediaType;
        
        if (opts.forceFormat) {
            requestedMediaType = opts.forceFormat;
            wasConverted = true; // forceFormat overrides
        }

        // Export canvas and validate actual MIME type returned
        const { base64: processedBase64, actualMediaType } = await this.canvasToBase64(
            canvas,
            requestedMediaType,
            opts.quality
        );
        const processedSizeBytes = Math.ceil((processedBase64.length * 3) / 4);

        return {
            base64: processedBase64,
            mediaType: actualMediaType, // Use actual type, not requested
            width: canvas.width,
            height: canvas.height,
            originalSizeBytes,
            processedSizeBytes,
            wasConverted,
            wasResized
        };
    }

    /**
     * Check if file needs conversion before VLM submission
     */
    needsConversion(file: TFile): boolean {
        const ext = `.${file.extension.toLowerCase()}`;
        return IMAGE_CONVERSION_REQUIRED.includes(ext);
    }

    /**
     * Check if file needs processing (conversion OR large size)
     */
    needsProcessing(file: TFile): boolean {
        return this.needsConversion(file) || file.stat.size > MEDIA_SIZE_WARN_BYTES;
    }

    /**
     * Get compression estimate string for UI
     * @param originalBytes - Original file size
     * @returns Formatted estimate like "~1.2 MB → ~340 KB"
     */
    getCompressionEstimate(originalBytes: number): string {
        // Rough estimate: resizing to 1536px + JPEG 0.85 reduces by ~70-85%
        const estimatedBytes = originalBytes * 0.25; // Conservative 75% reduction
        return `~${this.formatBytes(originalBytes)} → ~${this.formatBytes(estimatedBytes)}`;
    }

    /**
     * Convert HEIC/HEIF to JPEG
     * Strategy:
     * 1. Try native browser decode (works on macOS, iOS, Windows with HEIC codec)
     * 2. Try CDN-loaded heic2any library (same pattern as D3.js for tag network)
     * 3. Throw with actionable guidance
     */
    private async convertHeic(blob: Blob): Promise<Blob> {
        // Attempt 1: Native browser decode (macOS/iOS always, Windows with HEIC Image Extensions)
        try {
            const img = await this.blobToImage(blob);
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                // Browser decoded HEIC natively — convert to JPEG via canvas
                return await this.convertToJpeg(blob);
            }
        } catch {
            // Native decode not supported — try library
        }

        // Attempt 2: CDN-loaded heic2any (runtime fetch, not bundled)
        try {
            const heic2any = await this.loadHeicConverter();
            const result = await heic2any({ blob, toType: 'image/jpeg', quality: DEFAULT_IMAGE_QUALITY });
            return Array.isArray(result) ? result[0] : result;
        } catch {
            // Library load failed
        }

        throw new Error(
            'HEIC format requires conversion. ' +
            'On Windows, install "HEIC Image Extensions" from the Microsoft Store (free). ' +
            'On iPhone, go to Settings → Camera → Formats → Most Compatible to use JPEG instead.'
        );
    }

    /**
     * Load heic2any library from CDN at runtime (same pattern as D3.js in TagNetworkView)
     * Library is only loaded when a HEIC file is actually encountered.
     */
    private async loadHeicConverter(): Promise<any> {
        const win = globalThis as any;
        if (win.heic2any) return win.heic2any;

        const cdnUrls = [
            'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js',
            'https://unpkg.com/heic2any@0.0.4/dist/heic2any.min.js'
        ];

        for (const url of cdnUrls) {
            try {
                await this.loadScript(url);
                if (win.heic2any) return win.heic2any;
            } catch {
                continue;
            }
        }

        throw new Error('HEIC converter library not available');
    }

    /** Load an external script by URL (returns when loaded) */
    private loadScript(url: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error(`Failed to load ${url}`));
            document.head.appendChild(script);
        });
    }

    /**
     * Rasterise SVG to PNG via canvas
     * @param blob - SVG blob
     * @returns PNG blob
     */
    private async rasteriseSvg(blob: Blob): Promise<Blob> {
        const img = await this.blobToImage(blob);
        
        // SVG images may report 0 dimensions until rendered
        // Use viewBox or default to 1024x1024
        const width = img.naturalWidth || 1024;
        const height = img.naturalHeight || 1024;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Failed to get 2D context for SVG rasterisation');

        // White background for SVG transparency
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);

        return new Promise((resolve, reject) => {
            canvas.toBlob(
                (resultBlob) => {
                    if (resultBlob) resolve(resultBlob);
                    else reject(new Error('SVG rasterisation failed'));
                },
                'image/png',
                1.0
            );
        });
    }

    /**
     * Convert image to JPEG via canvas
     * @param blob - Source image blob
     * @returns JPEG blob
     */
    private async convertToJpeg(blob: Blob): Promise<Blob> {
        const img = await this.blobToImage(blob);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Failed to get 2D context');

        // White background for transparency
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);

        return new Promise((resolve, reject) => {
            canvas.toBlob(
                (resultBlob) => {
                    if (resultBlob) resolve(resultBlob);
                    else reject(new Error('JPEG conversion failed'));
                },
                'image/jpeg',
                DEFAULT_IMAGE_QUALITY
            );
        });
    }

    /**
     * Convert image to PNG via canvas
     * @param blob - Source image blob
     * @returns PNG blob
     */
    private async convertToPng(blob: Blob): Promise<Blob> {
        const img = await this.blobToImage(blob);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Failed to get 2D context');
        ctx.drawImage(img, 0, 0);

        return new Promise((resolve, reject) => {
            canvas.toBlob(
                (resultBlob) => {
                    if (resultBlob) resolve(resultBlob);
                    else reject(new Error('PNG conversion failed'));
                },
                'image/png',
                1.0
            );
        });
    }

    /**
     * Resize image maintaining aspect ratio
     * @param img - Source image
     * @param maxDimension - Max width or height
     * @returns Canvas with resized image
     */
    async resize(img: HTMLImageElement, maxDimension: number): Promise<HTMLCanvasElement> {
        const width = img.naturalWidth;
        const height = img.naturalHeight;
        const aspectRatio = width / height;

        let targetWidth: number;
        let targetHeight: number;

        if (width > height) {
            targetWidth = Math.min(width, maxDimension);
            targetHeight = Math.round(targetWidth / aspectRatio);
        } else {
            targetHeight = Math.min(height, maxDimension);
            targetWidth = Math.round(targetHeight * aspectRatio);
        }

        const canvas = document.createElement('canvas');
        canvas.width = targetWidth;
        canvas.height = targetHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Failed to get 2D context for resize');

        // Modern browsers handle EXIF rotation automatically
        ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

        return canvas;
    }

    /**
     * Convert canvas to base64 string (without data: prefix)
     */
    /**
     * Convert canvas to base64 string without data: prefix
     * Returns both the base64 string and the ACTUAL media type returned by toDataURL()
     * (browser may fall back to different format if requested format not supported)
     */
    private async canvasToBase64(
        canvas: HTMLCanvasElement,
        requestedMediaType: string,
        quality: number
    ): Promise<{ base64: string; actualMediaType: string }> {
        const dataUrl = canvas.toDataURL(requestedMediaType, quality);
        // Extract actual MIME type from data URL prefix
        const matches = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
        if (!matches) {
            throw new Error('Invalid data URL format from canvas.toDataURL()');
        }
        const actualMediaType = matches[1];
        const base64 = matches[2];
        return { base64, actualMediaType };
    }

    /**
     * Load blob into HTMLImageElement
     */
    private blobToImage(blob: Blob): Promise<HTMLImageElement> {
        return new Promise((resolve, reject) => {
            const img = new Image();
            const url = URL.createObjectURL(blob);

            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve(img);
            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to load image'));
            };

            img.src = url;
        });
    }

    /**
     * Get media type from file extension
     */
    private getMediaTypeFromExtension(ext: string): string {
        const map: Record<string, string> = {
            'png': 'image/png',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'gif': 'image/gif',
            'webp': 'image/webp',
            'bmp': 'image/bmp',
            'svg': 'image/svg+xml',
            'heic': 'image/heic',
            'heif': 'image/heif',
            'tiff': 'image/tiff',
            'tif': 'image/tiff',
            'avif': 'image/avif'
        };
        return map[ext] || 'application/octet-stream';
    }

    /**
     * Format bytes for human-readable display
     */
    private formatBytes(bytes: number): string {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
    }

    /**
     * Convert canvas to ArrayBuffer for vault replacement
     */
    private canvasToArrayBuffer(canvas: HTMLCanvasElement, mediaType: string, quality: number): Promise<ArrayBuffer> {
        return new Promise((resolve, reject) => {
            canvas.toBlob(
                (blob) => {
                    if (!blob) { reject(new Error('canvas.toBlob failed')); return; }
                    void blob.arrayBuffer().then(resolve, reject);
                },
                mediaType,
                quality
            );
        });
    }

    /**
     * Replace original vault file with compressed version.
     * Uses modifyBinary + fileManager.renameFile for backlink-safe replacement.
     */
    async replaceOriginal(file: TFile, replacementBlob: ArrayBuffer, newMediaType: string): Promise<ReplaceResult> {
        const oldPath = file.path;

        // 1. Write compressed content to the ORIGINAL file
        await this.app.vault.modifyBinary(file, replacementBlob);

        // 2. If extension changed (e.g., .bmp → .jpg), rename with collision-safe path
        const newExt = this.mediaTypeToExtension(newMediaType);
        const oldExt = file.extension.toLowerCase();
        let newPath = oldPath;

        if (newExt && newExt !== oldExt) {
            const dir = file.parent?.path || '';
            const baseName = file.basename;
            newPath = await getAvailableFilePath(this.app.vault, dir, `${baseName}.${newExt}`);
            await (this.app as any).fileManager.renameFile(file, newPath);
        }

        // 3. Count backlinks referencing the new path
        const backlinksMigrated = this.countBacklinks(newPath);

        const abstract = this.app.vault.getAbstractFileByPath(newPath);
        if (!(abstract instanceof TFile)) {
            throw new Error(`Expected TFile at ${newPath} after rename`);
        }
        return { newFile: abstract, backlinksMigrated, oldPath, newPath };
    }

    private countBacklinks(filePath: string): number {
        const resolved = (this.app.metadataCache as any).resolvedLinks;
        if (!resolved) return 0;
        let count = 0;
        for (const sourcePath in resolved) {
            if (resolved[sourcePath]?.[filePath]) count++;
        }
        return count;
    }

    /**
     * Map media type to file extension for vault replacement
     */
    mediaTypeToExtension(mediaType: string): string | null {
        const map: Record<string, string> = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'image/gif': 'gif',
        };
        return map[mediaType] || null;
    }
}
