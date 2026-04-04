/**
 * Bases Integration Service
 *
 * Manages interaction with the Obsidian Bases plugin.
 * Future-proofs the integration by centralizing API detection and version checking.
 */

import { App, Plugin, TFile } from 'obsidian';
import type AIOrganiserPlugin from '../main';

export interface BasesPlugin extends Plugin {
    // Known Bases API surface (based on v1.10+)
    api?: {
        version: string;
        apiVersion: string;
        registerTemplate?: (id: string, template: any) => void;
        createDashboard?: (path: string, content: string) => Promise<TFile>;
    };
    settings?: {
        version: string;
    };
}

export class BasesService {
    private app: App;
    private plugin: AIOrganiserPlugin;

    constructor(app: App, plugin: AIOrganiserPlugin) {
        this.app = app;
        this.plugin = plugin;
    }

    /**
     * Check if Obsidian Bases plugin is installed and enabled
     */
    public isBasesEnabled(): boolean {
        // @ts-ignore - accessing internal plugins API
        return this.app.plugins.enabledPlugins.has('bases');
    }

    /**
     * Get the Bases plugin instance if available
     */
    public getBasesPlugin(): BasesPlugin | null {
        if (!this.isBasesEnabled()) return null;
        // @ts-ignore - accessing internal plugins API
        return this.app.plugins.plugins['bases'] as BasesPlugin;
    }

    /**
     * Get the Bases plugin version
     */
    public getBasesVersion(): string | null {
        const bases = this.getBasesPlugin();
        if (!bases) return null;
        return bases.manifest.version;
    }

    /**
     * Check if the installed Bases plugin supports v1.10+ features
     */
    public supportsV110Features(): boolean {
        const version = this.getBasesVersion();
        if (!version) return false;
        
        // Simple version check (assuming semantic versioning)
        const [major, minor] = version.split('.').map(Number);
        return major > 1 || (major === 1 && minor >= 10);
    }

    /**
     * Get the Bases API object if exposed
     */
     
    public getBasesApi(): any {
        const bases = this.getBasesPlugin();
        return bases?.api || null;
    }
}
