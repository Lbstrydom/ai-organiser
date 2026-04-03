/**
 * Bright Data Scraping Browser
 *
 * Full JS rendering via CDP over WebSocket.
 * Tier 3 (last resort) in the smart escalation chain.
 * Each call: connect → navigate → extract → close. Minimizes billing.
 */

import { CDPClient } from './cdpClient';

export class ScrapingBrowser {
    private activeClient: CDPClient | null = null;

    constructor(private getEndpoint: () => Promise<string | null>) {}

    async fetchHTML(url: string): Promise<string> {
        const endpoint = await this.getEndpoint();
        if (!endpoint) throw new Error('Scraping Browser endpoint not configured');

        const client = new CDPClient(30_000);
        try {
            await client.connect(endpoint);
            this.activeClient = client; // P2-5: assign AFTER connect succeeds
            await client.navigate(url);
            return await client.getPageHTML();
        } finally {
            this.activeClient = null;
            await client.close(); // ALWAYS close — billing stops on disconnect
        }
    }

    /**
     * Force-close any active CDP connection.
     * Called from plugin.onunload() to prevent zombie processes.
     */
    async forceClose(): Promise<void> {
        if (this.activeClient) {
            await this.activeClient.close();
            this.activeClient = null;
        }
    }

    async isConfigured(): Promise<boolean> {
        const endpoint = await this.getEndpoint();
        return !!endpoint;
    }
}
