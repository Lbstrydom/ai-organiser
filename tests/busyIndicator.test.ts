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
        vi.useFakeTimers();
        resetBusyState();
    });

    afterEach(() => {
        vi.useRealTimers();
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

    it('hideBusy defers removal for fast operations (minimum display)', () => {
        const plugin = createMockPlugin();
        showBusy(plugin);
        hideBusy(plugin);
        // Not removed yet — minimum display duration not elapsed
        expect(plugin.busyStatusBarEl.removeClass).not.toHaveBeenCalled();
        // After timer fires, class is removed
        vi.advanceTimersByTime(400);
        expect(plugin.busyStatusBarEl.removeClass).toHaveBeenCalledWith('ai-organiser-busy-active');
    });

    it('hideBusy removes immediately when minimum display has elapsed', () => {
        const plugin = createMockPlugin();
        showBusy(plugin);
        // Simulate 500ms passing
        vi.advanceTimersByTime(500);
        hideBusy(plugin);
        // Removed immediately — already past minimum
        expect(plugin.busyStatusBarEl.removeClass).toHaveBeenCalledWith('ai-organiser-busy-active');
    });

    it('hideBusy does not go below 0', () => {
        const plugin = createMockPlugin();
        showBusy(plugin);
        vi.advanceTimersByTime(500);
        hideBusy(plugin);
        hideBusy(plugin);
        hideBusy(plugin);
        // Should not throw
        expect(plugin.busyStatusBarEl.removeClass).toHaveBeenCalledWith('ai-organiser-busy-active');
    });

    it('concurrent operations: 2 showBusy, 1 hideBusy → still active', () => {
        const plugin = createMockPlugin();
        showBusy(plugin);
        showBusy(plugin);
        hideBusy(plugin);
        vi.advanceTimersByTime(500);
        // Should not remove class yet — still 1 active
        expect(plugin.busyStatusBarEl.removeClass).not.toHaveBeenCalled();
    });

    it('deferred hide cancelled by new showBusy', () => {
        const plugin = createMockPlugin();
        showBusy(plugin);
        hideBusy(plugin);
        // Timer is pending; now start a new operation
        showBusy(plugin);
        vi.advanceTimersByTime(500);
        // Should NOT have removed the class — new operation cancelled the timer
        expect(plugin.busyStatusBarEl.removeClass).not.toHaveBeenCalled();
    });

    it('withBusyIndicator shows/hides around successful operation', async () => {
        const plugin = createMockPlugin();
        const result = await withBusyIndicator(plugin, async () => 42);
        expect(result).toBe(42);
        expect(plugin.busyStatusBarEl.addClass).toHaveBeenCalledWith('ai-organiser-busy-active');
        // Fast operation — hide is deferred
        vi.advanceTimersByTime(400);
        expect(plugin.busyStatusBarEl.removeClass).toHaveBeenCalledWith('ai-organiser-busy-active');
    });

    it('withBusyIndicator hides on error (finally block)', async () => {
        const plugin = createMockPlugin();
        await expect(withBusyIndicator(plugin, async () => {
            throw new Error('test error');
        })).rejects.toThrow('test error');
        vi.advanceTimersByTime(400);
        expect(plugin.busyStatusBarEl.removeClass).toHaveBeenCalledWith('ai-organiser-busy-active');
    });

    it('resetBusyState clears refCount and pending timer', () => {
        const plugin = createMockPlugin();
        showBusy(plugin);
        hideBusy(plugin);
        // Timer is pending
        resetBusyState();
        vi.advanceTimersByTime(500);
        // Timer was cleared by reset — removeClass should NOT have been called
        expect(plugin.busyStatusBarEl.removeClass).not.toHaveBeenCalled();
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
