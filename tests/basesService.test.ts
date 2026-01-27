import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BasesService } from '../src/services/basesService';
import type { App, Plugin } from 'obsidian';
import type AIOrganiserPlugin from '../src/main';

describe('BasesService', () => {
    let service: BasesService;
    let mockApp: App;
    let mockPlugin: AIOrganiserPlugin;

    beforeEach(() => {
        mockApp = {
            plugins: {
                enabledPlugins: new Set(),
                plugins: {}
            }
        } as unknown as App;
        mockPlugin = {} as AIOrganiserPlugin;
        service = new BasesService(mockApp, mockPlugin);
    });

    it('should detect when Bases is enabled', () => {
        (mockApp.plugins as any).enabledPlugins.add('bases');
        expect(service.isBasesEnabled()).toBe(true);
    });

    it('should detect when Bases is disabled', () => {
        expect(service.isBasesEnabled()).toBe(false);
    });

    it('should get Bases version', () => {
        (mockApp.plugins as any).enabledPlugins.add('bases');
        (mockApp.plugins as any).plugins['bases'] = {
            manifest: { version: '1.10.0' }
        };
        expect(service.getBasesVersion()).toBe('1.10.0');
    });

    it('should detect v1.10 features', () => {
        (mockApp.plugins as any).enabledPlugins.add('bases');
        (mockApp.plugins as any).plugins['bases'] = {
            manifest: { version: '1.10.0' }
        };
        expect(service.supportsV110Features()).toBe(true);

        (mockApp.plugins as any).plugins['bases'] = {
            manifest: { version: '1.9.0' }
        };
        expect(service.supportsV110Features()).toBe(false);
    });
});
