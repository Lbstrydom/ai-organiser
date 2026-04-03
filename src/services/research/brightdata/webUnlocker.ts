/**
 * Bright Data Web Unlocker
 *
 * REST-based anti-bot bypass. Handles Cloudflare, CAPTCHA pages, etc.
 * Tier 2 in the smart escalation chain.
 */

import { requestUrl } from 'obsidian';

export class WebUnlocker {
    constructor(private getApiKey: () => Promise<string | null>) {}

    /**
     * Fetch page HTML through Web Unlocker (anti-bot bypass).
     * Uses Bright Data zone API endpoint via requestUrl().
     * Returns raw HTML string.
     */
    async fetchHTML(url: string): Promise<string> {
        const apiKey = await this.getApiKey();
        if (!apiKey) throw new Error('Web Unlocker API key not configured');

        const response = await requestUrl({
            url: 'https://api.brightdata.com/request',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                zone: 'web_unlocker1',
                url,
                format: 'raw',
            }),
            throw: false,
        });

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`Web Unlocker failed (${response.status})`);
        }
        return response.text;
    }

    /** Check if Web Unlocker credentials are stored. */
    async isConfigured(): Promise<boolean> {
        const key = await this.getApiKey();
        return !!key;
    }
}
