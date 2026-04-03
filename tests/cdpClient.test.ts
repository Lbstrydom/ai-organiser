/**
 * CDPClient tests
 *
 * Tests CDP connect/send/navigate/getPageHTML/close lifecycle.
 * Uses a mock WebSocket to simulate CDP protocol.
 */

import { CDPClient } from '../src/services/research/brightdata/cdpClient';

// ── Mock WebSocket ──

class MockWebSocket {
    static readonly OPEN = 1;
    static instances: MockWebSocket[] = [];

    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    readyState = 1; // OPEN
    sent: string[] = [];
    closed = false;

    constructor(public url: string) {
        MockWebSocket.instances.push(this);
        // Auto-connect after microtask (Promise-based to work with fake timers)
        Promise.resolve().then(() => this.onopen?.());
    }

    send(data: string) {
        this.sent.push(data);
    }

    close() {
        this.closed = true;
        this.readyState = 3; // CLOSED
    }

    // Test helper: simulate receiving a CDP response
    simulateResponse(id: number, result: any) {
        this.onmessage?.({ data: JSON.stringify({ id, result }) });
    }

    // Test helper: simulate a CDP event
    simulateEvent(method: string, params?: any) {
        this.onmessage?.({ data: JSON.stringify({ method, params }) });
    }

    // Test helper: simulate an error response
    simulateError(id: number, message: string) {
        this.onmessage?.({ data: JSON.stringify({ id, error: { message } }) });
    }
}

describe('CDPClient', () => {
    let originalWebSocket: typeof WebSocket;

    beforeEach(() => {
        MockWebSocket.instances = [];
        originalWebSocket = globalThis.WebSocket;
        (globalThis as any).WebSocket = MockWebSocket;
    });

    afterEach(() => {
        globalThis.WebSocket = originalWebSocket;
    });

    describe('connect()', () => {
        it('connects to the given endpoint', async () => {
            const client = new CDPClient(5000);
            await client.connect('wss://test-endpoint:9222');

            expect(MockWebSocket.instances).toHaveLength(1);
            expect(MockWebSocket.instances[0].url).toBe('wss://test-endpoint:9222');
        });

        it('rejects on connection error', async () => {
            (globalThis as any).WebSocket = class {
                onopen: (() => void) | null = null;
                onerror: (() => void) | null = null;
                onmessage: ((event: any) => void) | null = null;
                readyState = 0;

                constructor() {
                    setTimeout(() => this.onerror?.(), 0);
                }

                send() {}
                close() {}
            };

            const client = new CDPClient(5000);
            await expect(client.connect('wss://bad-endpoint')).rejects.toThrow('CDP connection failed');
        });

        it('rejects on connection timeout', async () => {
            vi.useFakeTimers();

            (globalThis as any).WebSocket = class {
                onopen: (() => void) | null = null;
                onerror: (() => void) | null = null;
                onmessage: ((event: any) => void) | null = null;
                readyState = 0;

                constructor() {
                    // Never calls onopen or onerror
                }

                send() {}
                close() {}
            };

            const client = new CDPClient(1000);
            const connectPromise = client.connect('wss://slow-endpoint');

            vi.advanceTimersByTime(1001);

            await expect(connectPromise).rejects.toThrow('CDP connection timeout');

            vi.useRealTimers();
        });
    });

    describe('send()', () => {
        it('sends JSON message with incrementing IDs', async () => {
            const client = new CDPClient(5000);
            await client.connect('wss://test:9222');

            const ws = MockWebSocket.instances[0];

            // Start two sends
            const p1 = client.send('Page.enable');
            ws.simulateResponse(1, {});
            await p1;

            const p2 = client.send('Runtime.evaluate', { expression: 'test' });
            ws.simulateResponse(2, { result: { value: 'ok' } });
            const result = await p2;

            expect(ws.sent).toHaveLength(2);
            const msg1 = JSON.parse(ws.sent[0]);
            expect(msg1.id).toBe(1);
            expect(msg1.method).toBe('Page.enable');

            const msg2 = JSON.parse(ws.sent[1]);
            expect(msg2.id).toBe(2);
            expect(msg2.method).toBe('Runtime.evaluate');
            expect(msg2.params).toEqual({ expression: 'test' });

            expect(result).toEqual({ result: { value: 'ok' } });
        });

        it('throws when not connected', async () => {
            const client = new CDPClient(5000);

            await expect(client.send('Page.enable')).rejects.toThrow('CDP not connected');
        });

        it('rejects on CDP error response', async () => {
            const client = new CDPClient(5000);
            await client.connect('wss://test:9222');

            const ws = MockWebSocket.instances[0];
            const p = client.send('Invalid.method');
            ws.simulateError(1, 'Method not found');

            await expect(p).rejects.toThrow('Method not found');
        });

        it('rejects on send timeout', async () => {
            vi.useFakeTimers();

            const client = new CDPClient(1000);
            // Manually construct to avoid async timer issues
            const ws = new MockWebSocket('wss://test:9222');
            (client as any).ws = ws;

            const sendPromise = client.send('Slow.method');
            vi.advanceTimersByTime(1001);

            await expect(sendPromise).rejects.toThrow('CDP timeout: Slow.method');

            vi.useRealTimers();
        });
    });

    describe('getPageHTML()', () => {
        it('returns page HTML from Runtime.evaluate', async () => {
            const client = new CDPClient(5000);
            await client.connect('wss://test:9222');

            const ws = MockWebSocket.instances[0];
            const p = client.getPageHTML();
            ws.simulateResponse(1, {
                result: { value: '<html><body>Hello</body></html>' },
            });

            const html = await p;

            expect(html).toBe('<html><body>Hello</body></html>');
        });

        it('throws on exception in evaluation', async () => {
            const client = new CDPClient(5000);
            await client.connect('wss://test:9222');

            const ws = MockWebSocket.instances[0];
            const p = client.getPageHTML();
            ws.simulateResponse(1, {
                exceptionDetails: { text: 'ReferenceError' },
            });

            await expect(p).rejects.toThrow('Failed to extract page HTML');
        });
    });

    describe('close()', () => {
        it('closes the WebSocket connection', async () => {
            const client = new CDPClient(5000);
            await client.connect('wss://test:9222');

            const ws = MockWebSocket.instances[0];
            await client.close();

            expect(ws.closed).toBe(true);
        });

        it('rejects all pending requests on close', async () => {
            const client = new CDPClient(5000);
            await client.connect('wss://test:9222');

            const p = client.send('Page.enable');
            await client.close();

            await expect(p).rejects.toThrow('CDP connection closed');
        });

        it('is safe to call multiple times', async () => {
            const client = new CDPClient(5000);
            await client.connect('wss://test:9222');

            await client.close();
            await client.close(); // Should not throw
        });

        it('handles close when never connected', async () => {
            const client = new CDPClient(5000);
            await client.close(); // Should not throw
        });
    });

    describe('event handling', () => {
        it('dispatches CDP events to registered handlers via navigate', async () => {
            const client = new CDPClient(5000);
            await client.connect('wss://test:9222');
            const ws = MockWebSocket.instances[0];

            // Set up auto-responding to CDP messages
            ws.send = function (data: string) {
                this.sent.push(data);
                const msg = JSON.parse(data);
                // Auto-respond to Page.enable and Page.navigate
                if (msg.method === 'Page.enable') {
                    Promise.resolve().then(() => this.simulateResponse(msg.id, {}));
                } else if (msg.method === 'Page.navigate') {
                    Promise.resolve().then(() => {
                        this.simulateResponse(msg.id, { frameId: 'abc' });
                        this.simulateEvent('Page.loadEventFired', {});
                    });
                }
            };

            // navigate has a 2s settle time - use real timers but override settle
            const originalSetTimeout = globalThis.setTimeout;
            (globalThis as any).setTimeout = (fn: () => void, ms?: number) => {
                // Fire settle time immediately in test
                if (ms === 2000) return originalSetTimeout(fn, 0);
                return originalSetTimeout(fn, ms);
            };

            await client.navigate('https://example.com');

            globalThis.setTimeout = originalSetTimeout;

            expect(ws.sent).toHaveLength(2);
            expect(JSON.parse(ws.sent[0]).method).toBe('Page.enable');
            expect(JSON.parse(ws.sent[1]).method).toBe('Page.navigate');
        });
    });
});
