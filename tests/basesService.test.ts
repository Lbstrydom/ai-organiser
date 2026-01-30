import { BasesService } from '../src/services/basesService';
import type AIOrganiserPlugin from '../src/main';

describe('BasesService', () => {
    let service: BasesService;
    let mockApp: any;
    let mockPlugin: AIOrganiserPlugin;

    beforeEach(() => {
        mockApp = {
            plugins: {
                enabledPlugins: new Set(),
                plugins: {}
            }
        };
        mockPlugin = {} as AIOrganiserPlugin;
        service = new BasesService(mockApp, mockPlugin);
    });

    it('should detect when Bases is enabled', () => {
        mockApp.plugins.enabledPlugins.add('bases');
        expect(service.isBasesEnabled()).toBe(true);
    });

    it('should detect when Bases is disabled', () => {
        expect(service.isBasesEnabled()).toBe(false);
    });

    it('should get Bases version', () => {
        mockApp.plugins.enabledPlugins.add('bases');
        mockApp.plugins.plugins['bases'] = {
            manifest: { version: '1.10.0' }
        };
        expect(service.getBasesVersion()).toBe('1.10.0');
    });

    it('should detect v1.10 features', () => {
        mockApp.plugins.enabledPlugins.add('bases');
        mockApp.plugins.plugins['bases'] = {
            manifest: { version: '1.10.0' }
        };
        expect(service.supportsV110Features()).toBe(true);

        mockApp.plugins.plugins['bases'] = {
            manifest: { version: '1.9.0' }
        };
        expect(service.supportsV110Features()).toBe(false);
    });
});
