import { buildSketchEmbed, exportSketchToVault } from '../src/services/sketch/sketchExport';

describe('sketchExport', () => {
    function createMockCanvas(withBlob = true): HTMLCanvasElement {
        return {
            toBlob: (callback: (blob: Blob | null) => void) => {
                if (!withBlob) {
                    callback(null);
                    return;
                }
                callback(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
            }
        } as unknown as HTMLCanvasElement;
    }

    it('exports a png sketch to vault', async () => {
        const createBinary = vi.fn().mockResolvedValue({ path: 'AI-Organiser/Sketches/sketch-1.png' });
        const app: any = {
            vault: {
                getAbstractFileByPath: vi.fn().mockReturnValue(null),
                createFolder: vi.fn().mockResolvedValue(undefined),
                createBinary
            }
        };

        const file = await exportSketchToVault(app, createMockCanvas(), 'AI-Organiser/Sketches');
        expect(createBinary).toHaveBeenCalledTimes(1);
        expect(file.path).toContain('AI-Organiser/Sketches/sketch-');
    });

    it('throws when canvas export fails', async () => {
        const app: any = {
            vault: {
                getAbstractFileByPath: vi.fn().mockReturnValue(null),
                createFolder: vi.fn().mockResolvedValue(undefined),
                createBinary: vi.fn()
            }
        };

        await expect(exportSketchToVault(app, createMockCanvas(false), 'AI-Organiser/Sketches'))
            .rejects.toThrow('Failed to export sketch');
    });

    it('builds embed text from file path', () => {
        const embed = buildSketchEmbed({ path: 'AI-Organiser/Sketches/sketch-1.png' } as any);
        expect(embed).toBe('![[AI-Organiser/Sketches/sketch-1.png]]');
    });
});

