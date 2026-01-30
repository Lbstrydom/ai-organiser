import { showBusy, hideBusy, withBusyIndicator, resetBusyState } from '../src/utils/busyIndicator';

function createMockPlugin() {
    return {
        busyStatusBarEl: {
            setText: vi.fn(),
            addClass: vi.fn(),
            removeClass: vi.fn(),
        } as any,
        t: { messages: { aiProcessing: 'AI processing...' } }
    };
}

describe('busyIndicator', () => {
    beforeEach(() => {
        resetBusyState();
    });

    it('showBusy adds active CSS class and sets text', () => {
        const plugin = createMockPlugin();
        showBusy(plugin);
        expect(plugin.busyStatusBarEl.addClass).toHaveBeenCalledWith('ai-organiser-busy-active');
        expect(plugin.busyStatusBarEl.setText).toHaveBeenCalledWith('AI processing...');
    });

    it('showBusy uses custom message when provided', () => {
        const plugin = createMockPlugin();
        showBusy(plugin, 'Custom message');
        expect(plugin.busyStatusBarEl.setText).toHaveBeenCalledWith('Custom message');
    });

    it('hideBusy removes class when refCount reaches 0', () => {
        const plugin = createMockPlugin();
        showBusy(plugin);
        hideBusy(plugin);
        expect(plugin.busyStatusBarEl.removeClass).toHaveBeenCalledWith('ai-organiser-busy-active');
    });

    it('hideBusy does not go below 0', () => {
        const plugin = createMockPlugin();
        showBusy(plugin);
        hideBusy(plugin);
        hideBusy(plugin);
        hideBusy(plugin);
        // Should not throw; removeClass called each time refCount is 0
        expect(plugin.busyStatusBarEl.removeClass).toHaveBeenCalledWith('ai-organiser-busy-active');
    });

    it('concurrent operations: 2 showBusy, 1 hideBusy → still active', () => {
        const plugin = createMockPlugin();
        showBusy(plugin);
        showBusy(plugin);
        hideBusy(plugin);
        // Should not remove class yet — still 1 active
        expect(plugin.busyStatusBarEl.removeClass).not.toHaveBeenCalled();
    });

    it('withBusyIndicator shows/hides around successful operation', async () => {
        const plugin = createMockPlugin();
        const result = await withBusyIndicator(plugin, async () => 42);
        expect(result).toBe(42);
        expect(plugin.busyStatusBarEl.addClass).toHaveBeenCalledWith('ai-organiser-busy-active');
        expect(plugin.busyStatusBarEl.removeClass).toHaveBeenCalledWith('ai-organiser-busy-active');
    });

    it('withBusyIndicator hides on error (finally block)', async () => {
        const plugin = createMockPlugin();
        await expect(withBusyIndicator(plugin, async () => {
            throw new Error('test error');
        })).rejects.toThrow('test error');
        expect(plugin.busyStatusBarEl.removeClass).toHaveBeenCalledWith('ai-organiser-busy-active');
    });

    it('resetBusyState clears refCount to 0', () => {
        const plugin = createMockPlugin();
        showBusy(plugin);
        showBusy(plugin);
        resetBusyState();
        // After reset, refCount is 0; hideBusy with refCount=0 still triggers removeClass
        hideBusy(plugin);
        expect(plugin.busyStatusBarEl.removeClass).toHaveBeenCalledWith('ai-organiser-busy-active');
    });

    it('showBusy with null statusBarEl is a no-op', () => {
        const plugin = {
            busyStatusBarEl: null,
            t: { messages: { aiProcessing: 'AI processing...' } }
        };
        // Should not throw
        expect(() => showBusy(plugin)).not.toThrow();
        expect(() => hideBusy(plugin)).not.toThrow();
    });
});
