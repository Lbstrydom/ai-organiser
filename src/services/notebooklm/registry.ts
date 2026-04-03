/**
 * Registry Service for NotebookLM Source Packs
 * 
 * Manages pack versioning and revision tracking across sessions.
 * Stores registry in .obsidian/ai-organiser-notebooklm-registry.json
 */

import { App } from 'obsidian';
import { PackRegistry, PackRegistryEntry, PackManifest } from './types';
import { computePackHash } from './hashing';
import { logger } from '../../utils/logger';

const REGISTRY_FILE = '.obsidian/ai-organiser-notebooklm-registry.json';

/**
 * Registry manager for source packs
 */
export class RegistryService {
    private registry: PackRegistry | null = null;

    constructor(private app: App) {}

    /**
     * Load registry from disk
     */
    async loadRegistry(): Promise<void> {
        try {
            const file = this.app.vault.getAbstractFileByPath(REGISTRY_FILE);
            if (!file) {
                // Initialize empty registry
                this.registry = {
                    version: 1,
                    packs: {}
                };
                return;
            }

            const content = await this.app.vault.adapter.read(REGISTRY_FILE);
            this.registry = JSON.parse(content);
        } catch (error) {
            logger.error('Export', 'Failed to load NotebookLM registry:', error);
            // Initialize empty registry on error
            this.registry = {
                version: 1,
                packs: {}
            };
        }
    }

    /**
     * Save registry to disk
     */
    async saveRegistry(): Promise<void> {
        if (!this.registry) {
            await this.loadRegistry();
        }

        try {
            const content = JSON.stringify(this.registry, null, 2);
            await this.app.vault.adapter.write(REGISTRY_FILE, content);
        } catch (error) {
            logger.error('Export', 'Failed to save NotebookLM registry:', error);
            throw error;
        }
    }

    /**
     * Get registry entry for a scope
     * @param scopeKey Scope identifier (e.g., 'tag:notebooklm', 'folder:Projects')
     * @returns Registry entry or null
     */
    getEntry(scopeKey: string): PackRegistryEntry | null {
        if (!this.registry) {
            return null;
        }

        return this.registry.packs[scopeKey] || null;
    }

    /**
     * Update or create registry entry
     * @param scopeKey Scope identifier
     * @param manifest Pack manifest
     * @param packFolderPath Path to pack folder
     * @returns Updated registry entry
     */
    async updateEntry(
        scopeKey: string,
        manifest: PackManifest,
        packFolderPath: string
    ): Promise<PackRegistryEntry> {
        if (!this.registry) {
            await this.loadRegistry();
        }

        const existingEntry = this.getEntry(scopeKey);
        const packHash = computePackHash(manifest.entries.map(e => e.sha256));

        let revision = 1;
        if (existingEntry && existingEntry.packHash !== packHash) {
            // Content changed, increment revision
            revision = existingEntry.revision + 1;
        } else if (existingEntry) {
            // No content change, keep same revision
            revision = existingEntry.revision;
        }

        const entry: PackRegistryEntry = {
            packId: manifest.packId,
            scopeKey,
            revision,
            packHash,
            lastExportedAt: new Date().toISOString(),
            packFolderPath
        };

        this.registry!.packs[scopeKey] = entry;
        await this.saveRegistry();

        return entry;
    }

    /**
     * Get next revision number for a scope
     * @param scopeKey Scope identifier
     * @param currentPackHash Hash of current pack content
     * @returns Next revision number
     */
    getNextRevision(scopeKey: string, currentPackHash: string): number {
        const existingEntry = this.getEntry(scopeKey);

        if (!existingEntry) {
            return 1; // First export
        }

        if (existingEntry.packHash === currentPackHash) {
            return existingEntry.revision; // No changes, keep same revision
        }

        return existingEntry.revision + 1; // Content changed
    }

    /**
     * Get previous manifest for changelog comparison
     * @param scopeKey Scope identifier
     * @returns Previous manifest or null
     */
    async getPreviousManifest(scopeKey: string): Promise<PackManifest | null> {
        const entry = this.getEntry(scopeKey);
        if (!entry) {
            return null;
        }

        try {
            const manifestPath = `${entry.packFolderPath}/manifest.json`;
            const file = this.app.vault.getAbstractFileByPath(manifestPath);
            if (!file) {
                return null;
            }

            const content = await this.app.vault.adapter.read(manifestPath);
            return JSON.parse(content);
        } catch (error) {
            logger.error('Export', 'Failed to load previous manifest:', error);
            return null;
        }
    }

    /**
     * Delete registry entry
     * @param scopeKey Scope identifier
     */
    async deleteEntry(scopeKey: string): Promise<void> {
        if (!this.registry) {
            await this.loadRegistry();
        }

        delete this.registry!.packs[scopeKey];
        await this.saveRegistry();
    }

    /**
     * Get all registry entries
     * @returns Array of all registry entries
     */
    getAllEntries(): PackRegistryEntry[] {
        if (!this.registry) {
            return [];
        }

        return Object.values(this.registry.packs);
    }

    /**
     * Check if pack has been exported before
     * @param scopeKey Scope identifier
     * @returns True if pack exists in registry
     */
    hasBeenExported(scopeKey: string): boolean {
        return this.getEntry(scopeKey) !== null;
    }
}
