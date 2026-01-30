import { pluginContext, summarizeText, getServiceType } from '../src/services/llmFacade';

function createMockPlugin(overrides: Record<string, any> = {}) {
    return {
        llmService: {
            summarizeText: vi.fn().mockResolvedValue({ success: true, content: 'summary' }),
            ...overrides.llmService
        },
        settings: {
            serviceType: 'cloud' as const,
            cloudServiceType: 'openai',
            ...overrides.settings
        },
        extraProperty: 'should not appear'
    };
}

describe('pluginContext', () => {
    it('returns correct shape with llmService and settings', () => {
        const plugin = createMockPlugin();
        const ctx = pluginContext(plugin);
        expect(ctx).toHaveProperty('llmService');
        expect(ctx).toHaveProperty('settings');
        expect(ctx.settings.serviceType).toBe('cloud');
        expect(ctx.settings.cloudServiceType).toBe('openai');
    });

    it('does not expose extra plugin properties', () => {
        const plugin = createMockPlugin();
        const ctx = pluginContext(plugin);
        expect(Object.keys(ctx)).toEqual(['llmService', 'settings']);
        expect((ctx as any).extraProperty).toBeUndefined();
    });
});

describe('summarizeText', () => {
    it('returns content on success', async () => {
        const plugin = createMockPlugin();
        const ctx = pluginContext(plugin);
        const result = await summarizeText(ctx, 'test prompt');
        expect(result).toEqual({ success: true, content: 'summary' });
    });

    it('returns error on LLM failure', async () => {
        const plugin = createMockPlugin({
            llmService: {
                summarizeText: vi.fn().mockRejectedValue(new Error('API error'))
            }
        });
        const ctx = pluginContext(plugin);
        const result = await summarizeText(ctx, 'test prompt');
        expect(result).toEqual({ success: false, error: 'API error' });
    });
});

describe('getServiceType', () => {
    it('returns cloud mode for cloud service type', () => {
        const ctx = pluginContext(createMockPlugin());
        const info = getServiceType(ctx);
        expect(info).toEqual({ mode: 'cloud', provider: 'openai' });
    });

    it('returns local mode for local service type', () => {
        const ctx = pluginContext(createMockPlugin({ settings: { serviceType: 'local', cloudServiceType: '' } }));
        const info = getServiceType(ctx);
        expect(info).toEqual({ mode: 'local', provider: 'local' });
    });
});
