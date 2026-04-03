/**
 * Image Processor Service Tests — Phase 2
 * Tests for image loading, conversion, resizing, and compression
 */
import { vi } from 'vitest';
import { ImageProcessorService, ProcessedImage } from '../src/services/imageProcessorService';
import {
    IMAGE_CONVERSION_REQUIRED,
    VLM_NATIVE_IMAGE_FORMATS,
    MEDIA_SIZE_WARN_BYTES
} from '../src/core/constants';

// Mock Obsidian App
const createMockApp = () => ({
    vault: {
        readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(1024))
    }
});

// Mock TFile
const createMockFile = (extension: string, size: number = 1024) => ({
    extension,
    stat: { size },
    path: `test.${extension}`,
    name: `test.${extension}`
});

// Mock canvas for testing
const mockCanvas = () => {
    const canvas = {
        width: 0,
        height: 0,
        // Return proper data URL that can be parsed by canvasToBase64
        toDataURL: vi.fn().mockReturnValue('data:image/jpeg;base64,/9j/4AAQSkZJRg=='),
        toBlob: vi.fn().mockImplementation((callback) => {
            const blob = new Blob(['mock'], { type: 'image/jpeg' });
            callback(blob);
        }),
        getContext: vi.fn().mockReturnValue({
            drawImage: vi.fn(),
            fillStyle: '',
            fillRect: vi.fn()
        })
    };
    return canvas;
};

// Mock HTMLImageElement
const mockImage = (width: number, height: number) => {
    const img = {
        naturalWidth: width,
        naturalHeight: height,
        onload: null as (() => void) | null,
        onerror: null as (() => void) | null,
        src: ''
    };

    // Simulate async load
    setTimeout(() => {
        if (img.onload) img.onload();
    }, 0);

    return img;
};

describe('ImageProcessorService', () => {
    let service: ImageProcessorService;
    let mockApp: any;

    beforeEach(() => {
        mockApp = createMockApp();
        service = new ImageProcessorService(mockApp);

        // Mock document.createElement for canvas
        global.document = {
            createElement: vi.fn((tag) => {
                if (tag === 'canvas') return mockCanvas();
                return {};
            })
        } as any;

        // Mock Image constructor
        (global as any).Image = class {
            naturalWidth: number;
            naturalHeight: number;
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            src = '';

            constructor() {
                this.naturalWidth = 1024;
                this.naturalHeight = 768;
                // Simulate async load
                setTimeout(() => {
                    if (this.onload) this.onload();
                }, 0);
            }
        };

        // Mock URL.createObjectURL and revokeObjectURL
        global.URL = {
            createObjectURL: vi.fn().mockReturnValue('blob:mock-url'),
            revokeObjectURL: vi.fn()
        } as any;

        // Mock atob for base64 decoding
        global.atob = vi.fn().mockReturnValue('mock-binary-data');
    });

    describe('Constants validation', () => {
        it('IMAGE_CONVERSION_REQUIRED includes all non-VLM formats', () => {
            expect(IMAGE_CONVERSION_REQUIRED).toContain('.heic');
            expect(IMAGE_CONVERSION_REQUIRED).toContain('.heif');
            expect(IMAGE_CONVERSION_REQUIRED).toContain('.bmp');
            expect(IMAGE_CONVERSION_REQUIRED).toContain('.tiff');
            expect(IMAGE_CONVERSION_REQUIRED).toContain('.tif');
            expect(IMAGE_CONVERSION_REQUIRED).toContain('.avif');
            expect(IMAGE_CONVERSION_REQUIRED).toContain('.svg');
        });

        it('VLM_NATIVE_IMAGE_FORMATS contains only accepted formats', () => {
            expect(VLM_NATIVE_IMAGE_FORMATS).toEqual([
                'image/jpeg',
                'image/png',
                'image/webp',
                'image/gif'
            ]);
        });

    });

    describe('needsConversion', () => {
        it('returns true for HEIC files', () => {
            const file = createMockFile('heic');
            expect(service.needsConversion(file as any)).toBe(true);
        });

        it('returns true for HEIF files', () => {
            const file = createMockFile('heif');
            expect(service.needsConversion(file as any)).toBe(true);
        });

        it('returns true for BMP files', () => {
            const file = createMockFile('bmp');
            expect(service.needsConversion(file as any)).toBe(true);
        });

        it('returns true for TIFF files', () => {
            const file = createMockFile('tiff');
            expect(service.needsConversion(file as any)).toBe(true);
        });

        it('returns true for TIF files', () => {
            const file = createMockFile('tif');
            expect(service.needsConversion(file as any)).toBe(true);
        });

        it('returns true for AVIF files', () => {
            const file = createMockFile('avif');
            expect(service.needsConversion(file as any)).toBe(true);
        });

        it('returns true for SVG files', () => {
            const file = createMockFile('svg');
            expect(service.needsConversion(file as any)).toBe(true);
        });

        it('returns false for JPEG files', () => {
            const file = createMockFile('jpg');
            expect(service.needsConversion(file as any)).toBe(false);
        });

        it('returns false for PNG files', () => {
            const file = createMockFile('png');
            expect(service.needsConversion(file as any)).toBe(false);
        });

        it('returns false for WebP files', () => {
            const file = createMockFile('webp');
            expect(service.needsConversion(file as any)).toBe(false);
        });
    });

    describe('needsProcessing', () => {
        it('returns true for files needing conversion', () => {
            const file = createMockFile('heic', 1024);
            expect(service.needsProcessing(file as any)).toBe(true);
        });

        it('returns true for large files (>5MB)', () => {
            const file = createMockFile('jpg', 6 * 1024 * 1024);
            expect(service.needsProcessing(file as any)).toBe(true);
        });

        it('returns false for small native format files', () => {
            const file = createMockFile('png', 100 * 1024);
            expect(service.needsProcessing(file as any)).toBe(false);
        });

        it('returns false for files at exactly 5MB threshold', () => {
            const file = createMockFile('jpg', MEDIA_SIZE_WARN_BYTES);
            expect(service.needsProcessing(file as any)).toBe(false);
        });
    });

    describe('getCompressionEstimate', () => {
        it('formats bytes correctly for small sizes', () => {
            const estimate = service.getCompressionEstimate(500 * 1024);
            expect(estimate).toContain('KB');
        });

        it('formats bytes correctly for MB sizes', () => {
            const estimate = service.getCompressionEstimate(5 * 1024 * 1024);
            expect(estimate).toContain('MB');
        });

        it('includes arrow separator', () => {
            const estimate = service.getCompressionEstimate(1024 * 1024);
            expect(estimate).toContain('→');
        });

        it('shows estimated reduction', () => {
            const estimate = service.getCompressionEstimate(4 * 1024 * 1024);
            // Should show ~75% reduction
            expect(estimate).toMatch(/~\d+\.?\d*\s*(MB|KB)\s*→\s*~\d+\.?\d*\s*(MB|KB)/);
        });
    });

    describe('processImageFromBase64', () => {
        it('strips data: prefix from base64 input', async () => {
            const base64WithPrefix = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
            
            const result = await service.processImageFromBase64(base64WithPrefix, 'image/png');
            
            expect(result.base64).toBeTruthy();
            expect(result.mediaType).toBe('image/jpeg'); // Mock returns JPEG for all
        });

        it('handles base64 without prefix', async () => {
            const base64 = 'iVBORw0KGgoAAAANSUhEUg==';
            
            const result = await service.processImageFromBase64(base64, 'image/jpeg');
            
            expect(result.base64).toBeTruthy();
            expect(result.mediaType).toBe('image/jpeg');
        });

        it('uses default max dimension when not specified', async () => {
            const base64 = 'iVBORw0KGgoAAAANSUhEUg==';
            
            const result = await service.processImageFromBase64(base64, 'image/png');
            
            // With mock image of 1024x768, should not be resized (under 1536)
            expect(result.wasResized).toBe(false);
        });

        it('applies forceFormat when specified', async () => {
            const base64 = 'iVBORw0KGgoAAAANSUhEUg==';
            
            const result = await service.processImageFromBase64(
                base64,
                'image/png',
                { forceFormat: 'image/jpeg' }
            );
            
            expect(result.mediaType).toBe('image/jpeg');
            expect(result.wasConverted).toBe(true);
        });

        it('marks wasConverted false when no format change', async () => {
            const base64 = 'iVBORw0KGgoAAAANSUhEUg==';
            
            const result = await service.processImageFromBase64(
                base64,
                'image/jpeg' // Start with JPEG so no conversion needed
            );
            
            expect(result.wasConverted).toBe(false);
        });

        it('converts BMP format from base64', async () => {
            const base64 = 'iVBORw0KGgoAAAANSUhEUg==';
            
            const result = await service.processImageFromBase64(base64, 'image/bmp');
            
            expect(result.wasConverted).toBe(true);
            expect(result.mediaType).toBe('image/jpeg'); // BMP → JPEG
        });

        it('converts AVIF format from base64', async () => {
            const base64 = 'iVBORw0KGgoAAAANSUhEUg==';
            
            const result = await service.processImageFromBase64(base64, 'image/avif');
            
            expect(result.wasConverted).toBe(true);
            expect(result.mediaType).toBe('image/jpeg'); // AVIF → JPEG
        });

        it('converts SVG format from base64', async () => {
            const base64 = 'iVBORw0KGgoAAAANSUhEUg==';
            
            const result = await service.processImageFromBase64(base64, 'image/svg+xml');
            
            expect(result.wasConverted).toBe(true);
            expect(result.mediaType).toBe('image/jpeg'); // Mock canvas returns JPEG, not PNG
        });

        it('throws error for HEIC format from base64', async () => {
            const base64 = 'iVBORw0KGgoAAAANSUhEUg==';
            
            await expect(
                service.processImageFromBase64(base64, 'image/heic')
            ).rejects.toThrow('HEIC format not supported');
        });

        it('throws error for HEIF format from base64', async () => {
            const base64 = 'iVBORw0KGgoAAAANSUhEUg==';
            
            await expect(
                service.processImageFromBase64(base64, 'image/heif')
            ).rejects.toThrow('HEIC format not supported');
        });
    });

    describe('MIME type validation', () => {
        it('returns actual MIME type from toDataURL for supported formats', async () => {
            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(1024));
            const file = createMockFile('png', 1024);

            const result = await service.processImage(file as any);

            // Mock returns image/jpeg for all, so actualMediaType should be image/jpeg
            expect(result.mediaType).toBe('image/jpeg');
        });

        it('uses actual MIME type when forceFormat is applied', async () => {
            const base64 = 'iVBORw0KGgoAAAANSUhEUg==';
            
            const result = await service.processImageFromBase64(
                base64,
                'image/png',
                { forceFormat: 'image/jpeg' }
            );
            
            // Should use actual type from toDataURL (validates MIME parsing)
            expect(result.mediaType).toBe('image/jpeg');
            expect(result.wasConverted).toBe(true);
        });
    });

    describe('resize logic', () => {
        it('resizes images with width > maxDimension', async () => {
            // Mock large image
            (global as any).Image = class {
                naturalWidth = 2000;
                naturalHeight = 1500;
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                src = '';
                constructor() {
                    setTimeout(() => { if (this.onload) this.onload(); }, 0);
                }
            };

            const result = await service.resize(new Image(), 1536);
            
            expect(result.width).toBe(1536);
            expect(result.height).toBe(1152); // Maintains 4:3 ratio
        });

        it('resizes images with height > maxDimension', async () => {
            (global as any).Image = class {
                naturalWidth = 1200;
                naturalHeight = 2000;
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                src = '';
                constructor() {
                    setTimeout(() => { if (this.onload) this.onload(); }, 0);
                }
            };

            const result = await service.resize(new Image(), 1536);
            
            expect(result.width).toBe(922); // Maintains 3:5 ratio (1200 * 1536/2000 = 921.6, rounds to 922)
            expect(result.height).toBe(1536);
        });

        it('maintains aspect ratio for landscape images', async () => {
            (global as any).Image = class {
                naturalWidth = 3000;
                naturalHeight = 2000;
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                src = '';
                constructor() {
                    setTimeout(() => { if (this.onload) this.onload(); }, 0);
                }
            };

            const result = await service.resize(new Image(), 1536);
            
            const aspectRatio = result.width / result.height;
            expect(aspectRatio).toBeCloseTo(1.5, 2);
        });

        it('maintains aspect ratio for portrait images', async () => {
            (global as any).Image = class {
                naturalWidth = 2000;
                naturalHeight = 3000;
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                src = '';
                constructor() {
                    setTimeout(() => { if (this.onload) this.onload(); }, 0);
                }
            };

            const result = await service.resize(new Image(), 1536);
            
            const aspectRatio = result.width / result.height;
            expect(aspectRatio).toBeCloseTo(0.6667, 2);
        });

        it('does not upscale smaller images', async () => {
            (global as any).Image = class {
                naturalWidth = 800;
                naturalHeight = 600;
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                src = '';
                constructor() {
                    setTimeout(() => { if (this.onload) this.onload(); }, 0);
                }
            };

            const result = await service.resize(new Image(), 1536);
            
            // Should return original size (drawn to canvas, but not upscaled)
            expect(result.width).toBe(800);
            expect(result.height).toBe(600);
        });
    });

    describe('HEIC conversion', () => {
        it('converts HEIC via native decode when browser supports it', async () => {
            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(1024));
            const file = createMockFile('heic', 1024);

            // Mock Image succeeds (simulates macOS/iOS native HEIC support)
            const result = await service.processImage(file as any);
            expect(result.wasConverted).toBe(true);
            expect(result.mediaType).toBe('image/jpeg');
        });

        it('converts HEIF via native decode when browser supports it', async () => {
            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(1024));
            const file = createMockFile('heif', 1024);

            const result = await service.processImage(file as any);
            expect(result.wasConverted).toBe(true);
            expect(result.mediaType).toBe('image/jpeg');
        });

        it('falls back with guidance when native decode fails', async () => {
            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(1024));
            const file = createMockFile('heic', 1024);

            // Make blobToImage fail (simulates Windows without HEIC codec)
            const origImage = (global as any).Image;
            (global as any).Image = class {
                naturalWidth = 0;
                naturalHeight = 0;
                onload: (() => void) | null = null;
                onerror: ((e: any) => void) | null = null;
                set src(_: string) {
                    setTimeout(() => this.onerror?.(new Error('decode failed')), 0);
                }
            };

            await expect(service.processImage(file as any)).rejects.toThrow(
                'HEIC format requires conversion'
            );

            (global as any).Image = origImage;
        });
    });

    describe('SVG rasterisation', () => {
        it('handles SVG with explicit dimensions', async () => {
            (global as any).Image = class {
                naturalWidth = 512;
                naturalHeight = 512;
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                src = '';
                constructor() {
                    setTimeout(() => { if (this.onload) this.onload(); }, 0);
                }
            };
            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(2048));
            const file = createMockFile('svg', 2048);

            const result = await service.processImage(file as any);

            expect(result.wasConverted).toBe(true);
            expect(result.mediaType).toBe('image/jpeg'); // Mock canvas returns JPEG
        });

        it('uses default 1024x1024 for SVG with zero dimensions', async () => {
            // First Image() call returns 0x0 (SVG), second returns 1024x1024 (rasterised PNG)
            let imageCallCount = 0;
            (global as any).Image = class {
                naturalWidth: number;
                naturalHeight: number;
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                src = '';
                constructor() {
                    imageCallCount++;
                    // First call (SVG blob) returns 0x0, second call (PNG blob) returns 1024x1024
                    this.naturalWidth = imageCallCount === 1 ? 0 : 1024;
                    this.naturalHeight = imageCallCount === 1 ? 0 : 1024;
                    setTimeout(() => { if (this.onload) this.onload(); }, 0);
                }
            };
            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(2048));
            const file = createMockFile('svg', 2048);

            const result = await service.processImage(file as any);

            expect(result.wasConverted).toBe(true);
            expect(result.width).toBe(1024);
            expect(result.height).toBe(1024);
        });
    });

    describe('Format conversion', () => {
        it('converts BMP to JPEG', async () => {
            (global as any).Image = class {
                naturalWidth = 800;
                naturalHeight = 600;
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                src = '';
                constructor() {
                    setTimeout(() => { if (this.onload) this.onload(); }, 0);
                }
            };
            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(1024));
            const file = createMockFile('bmp', 1024);

            const result = await service.processImage(file as any);

            expect(result.wasConverted).toBe(true);
            expect(result.mediaType).toBe('image/jpeg');
        });

        it('converts TIFF to JPEG', async () => {
            (global as any).Image = class {
                naturalWidth = 1200;
                naturalHeight = 900;
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                src = '';
                constructor() {
                    setTimeout(() => { if (this.onload) this.onload(); }, 0);
                }
            };
            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(2048));
            const file = createMockFile('tiff', 2048);

            const result = await service.processImage(file as any);

            expect(result.wasConverted).toBe(true);
            expect(result.mediaType).toBe('image/jpeg');
        });

        it('converts AVIF to JPEG', async () => {
            (global as any).Image = class {
                naturalWidth = 1024;
                naturalHeight = 768;
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                src = '';
                constructor() {
                    setTimeout(() => { if (this.onload) this.onload(); }, 0);
                }
            };
            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(1536));
            const file = createMockFile('avif', 1536);

            const result = await service.processImage(file as any);

            expect(result.wasConverted).toBe(true);
            expect(result.mediaType).toBe('image/jpeg');
        });
    });

    describe('ProcessedImage metadata', () => {
        it('includes original and processed sizes', async () => {
            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(5 * 1024 * 1024));
            const file = createMockFile('png', 5 * 1024 * 1024);

            const result = await service.processImage(file as any);

            expect(result.originalSizeBytes).toBe(5 * 1024 * 1024);
            expect(result.processedSizeBytes).toBeGreaterThan(0);
        });

        it('includes final dimensions', async () => {
            (global as any).Image = class {
                naturalWidth = 800;
                naturalHeight = 600;
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                src = '';
                constructor() {
                    setTimeout(() => { if (this.onload) this.onload(); }, 0);
                }
            };
            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(1024));
            const file = createMockFile('jpg', 1024);

            const result = await service.processImage(file as any);

            expect(result.width).toBe(800);
            expect(result.height).toBe(600);
        });

        it('marks wasResized true when dimensions reduced', async () => {
            (global as any).Image = class {
                naturalWidth = 2048;
                naturalHeight = 1536;
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                src = '';
                constructor() {
                    setTimeout(() => { if (this.onload) this.onload(); }, 0);
                }
            };
            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(2048));
            const file = createMockFile('png', 2048);

            const result = await service.processImage(file as any);

            expect(result.wasResized).toBe(true);
        });

        it('marks wasResized false when dimensions unchanged', async () => {
            (global as any).Image = class {
                naturalWidth = 800;
                naturalHeight = 600;
                onload: (() => void) | null = null;
                onerror: (() => void) | null = null;
                src = '';
                constructor() {
                    setTimeout(() => { if (this.onload) this.onload(); }, 0);
                }
            };
            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(1024));
            const file = createMockFile('jpg', 1024);

            const result = await service.processImage(file as any);

            expect(result.wasResized).toBe(false);
        });

        it('returns base64 without data: prefix', async () => {
            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(1024));
            const file = createMockFile('png', 1024);

            const result = await service.processImage(file as any);

            expect(result.base64).not.toContain('data:');
            expect(result.base64).not.toContain('base64,');
        });
    });

    describe('Error handling', () => {
        it('throws on invalid file read', async () => {
            mockApp.vault.readBinary.mockRejectedValue(new Error('File not found'));
            const file = createMockFile('jpg', 1024);

            await expect(service.processImage(file as any)).rejects.toThrow('File not found');
        });

        it('throws on canvas context creation failure', async () => {
            global.document = {
                createElement: vi.fn(() => ({
                    getContext: vi.fn().mockReturnValue(null)
                }))
            } as any;

            mockApp.vault.readBinary.mockResolvedValue(new ArrayBuffer(1024));
            const file = createMockFile('png', 1024);

            await expect(service.processImage(file as any)).rejects.toThrow(
                'Failed to get 2D context'
            );
        });
    });
});
