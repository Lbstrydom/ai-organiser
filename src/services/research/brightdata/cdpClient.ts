/**
 * Minimal Chrome DevTools Protocol Client
 *
 * Purpose-built for Bright Data Scraping Browser.
 * Connect → navigate → extract → close. No login state, no cookies, no scrolling.
 */

export class CDPClient {
    private ws: WebSocket | null = null;
    private messageId = 0;
    private pending = new Map<number, {
        resolve: (value: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private eventHandlers = new Map<string, ((params: any) => void)>();
    private timeout: number;

    constructor(timeout = 30_000) {
        this.timeout = timeout;
    }

    /** Connect to Scraping Browser WSS endpoint. */
    async connect(endpoint: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('CDP connection timeout')), this.timeout);
            this.ws = new WebSocket(endpoint);
            this.ws.onopen = () => { clearTimeout(timer); resolve(); };
            this.ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP connection failed')); };
            this.ws.onmessage = (event) => this.handleMessage(event);
        });
    }

    /** Send CDP command and wait for response. */
    async send(method: string, params?: Record<string, unknown>): Promise<any> {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error('CDP not connected');
        }
        const id = ++this.messageId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP timeout: ${method}`));
            }, this.timeout);
            this.pending.set(id, { resolve, reject, timer });
            this.ws!.send(JSON.stringify({ id, method, params }));
        });
    }

    /** Navigate to URL and wait for page load. */
    async navigate(url: string, settleMs = 2000): Promise<void> {
        await this.send('Page.enable');
        const loadPromise = this.waitForEvent('Page.loadEventFired');
        await this.send('Page.navigate', { url });
        await loadPromise;
        // Settle time for JS rendering (P2-7: configurable)
        if (settleMs > 0) {
            await new Promise(resolve => setTimeout(resolve, settleMs));
        }
    }

    /** Extract full page HTML via Runtime.evaluate. */
    async getPageHTML(): Promise<string> {
        const result = await this.send('Runtime.evaluate', {
            expression: 'document.documentElement.outerHTML',
            returnByValue: true,
        });
        if (result.exceptionDetails) {
            throw new Error('Failed to extract page HTML');
        }
        return result.result.value;
    }

    /** Wait for a CDP event. */
    private waitForEvent(eventName: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.eventHandlers.delete(eventName);
                reject(new Error(`CDP event timeout: ${eventName}`));
            }, this.timeout);
            this.eventHandlers.set(eventName, (params) => {
                clearTimeout(timer);
                this.eventHandlers.delete(eventName);
                resolve(params);
            });
        });
    }

    private handleMessage(event: MessageEvent): void {
        const msg = JSON.parse(event.data as string);
        // Response to a command
        if (msg.id !== undefined && this.pending.has(msg.id)) {
            const { resolve, reject, timer } = this.pending.get(msg.id)!;
            clearTimeout(timer);
            this.pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        }
        // Event notification
        if (msg.method && this.eventHandlers.has(msg.method)) {
            this.eventHandlers.get(msg.method)!(msg.params);
        }
    }

    /** Close WebSocket connection. Always call this to stop billing. */
    async close(): Promise<void> {
        for (const { timer, reject } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error('CDP connection closed'));
        }
        this.pending.clear();
        this.eventHandlers.clear();
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}
