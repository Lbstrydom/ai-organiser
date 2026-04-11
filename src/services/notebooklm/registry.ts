/**
 * Registry Service for NotebookLM Source Packs
 *
 * Manages pack versioning and revision tracking across sessions.
 * Stores registry in {configDir}/ai-organiser-notebooklm-registry.json
 */

import { App } from 'obsidian';
import { PackRegistry, PackRegistryEntry, PackManifest, PackEntry } from './types';
import { computePackHash } from './hashing';
import { logger } from '../../utils/logger';

/**
 * Normalize a raw registry entry from disk, filling in missing fields introduced
 * in later schema versions so legacy entries don't break incremental export.
 */
function normalizeRegistryEntry(raw: unknown): PackRegistryEntry {
    const e = raw as Record<string, unknown>;
    return {
        packId: (e.packId as string) ?? '',
        scopeKey: (e.scopeKey as string) ?? '',
        revision: (e.revision as number) ?? 1,
        packHash: (e.packHash as string) ?? '',
        lastExportedAt: (e.lastExportedAt as string) ?? new Date().toISOString(),
        packFolderPath: (e.packFolderPath as string) ?? '',
        // Empty string signals "no config hash stored" → forces full re-export on next run
        configHash: (e.configHash as string) ?? '',
    };
}

/**
 * Normalize a raw PackEntry from manifest JSON, accepting the legacy `pdfName`
 * field as a fallback for `outputName`.
 */
export function normalizePackEntry(raw: unknown): PackEntry {
    const e = raw as Record<string, unknown>;
    return {
        type: (e.type as PackEntry['type']) ?? 'note-pdf',
        filePath: (e.filePath as string) ?? '',
        // Accept legacy pdfName field
        outputName: ((e.outputName ?? e.pdfName) as string) ?? '',
        title: (e.title as string) ?? '',
        mtime: (e.mtime as string) ?? '',
        tags: (e.tags as string[]) ?? [],
        sizeBytes: (e.sizeBytes as number) ?? 0,
        sha256: (e.sha256 as string) ?? '',
    };
}

/**
 * Registry manager for source packs
 */
export class RegistryService {
    private registry: PackRegistry | null = null;

    constructor(private app: App) {}

    private get registryFile(): string {
        return `${this.app.vault.configDir}/ai-organiser-notebooklm-registry.json`;
    }

    /**
     * Load registry from disk, normalizing legacy entries
     */
    async loadRegistry(): Promise<void> {
        try {
            const file = this.app.vault.getAbstractFileByPath(this.registryFile);
            if (!file) {
                this.registry = { version: 1, packs: {} };
                return;
            }

            const content = await this.app.vault.adapter.read(this.registryFile);
            const raw = JSON.parse(content) as { version: number; packs: Record<string, unknown> };
            const packs: Record<string, PackRegistryEntry> = {};
            for (const [key, value] of Object.entries(raw.packs ?? {})) {
                packs[key] = normalizeRegistryEntry(value);
            }
            this.registry = { version: raw.version ?? 1, packs };
        } catch (error) {
            logger.error('Export', 'Failed to load NotebookLM registry:', error);
            this.registry = { version: 1, packs: {} };
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
            await this.app.vault.adapter.write(this.registryFile, content);
        } catch (error) {
            logger.error('Export', 'Failed to save NotebookLM registry:', error);
            throw error;
        }
    }

    /**
     * Get registry entry for a scope
     */
    getEntry(scopeKey: string): PackRegistryEntry | null {
        if (!this.registry) return null;
        return this.registry.packs[scopeKey] ?? null;
    }

    /**
     * Update or create registry entry, storing the configHash for future
     * incremental export validation.
     */
    async updateEntry(
        scopeKey: string,
        manifest: PackManifest,
        packFolderPath: string,
        configHash: string
    ): Promise<PackRegistryEntry> {
        if (!this.registry) {
            await this.loadRegistry();
        }

        const existingEntry = this.getEntry(scopeKey);
        const packHash = await computePackHash(manifest.entries.map(e => e.sha256));

        let revision = 1;
        if (existingEntry && existingEntry.packHash !== packHash) {
            revision = existingEntry.revision + 1;
        } else if (existingEntry) {
            revision = existingEntry.revision;
        }

        const entry: PackRegistryEntry = {
            packId: manifest.packId,
            scopeKey,
            revision,
            packHash,
            lastExportedAt: new Date().toISOString(),
            packFolderPath,
            configHash,
        };

        this.registry!.packs[scopeKey] = entry;
        await this.saveRegistry();

        return entry;
    }

    getNextRevision(scopeKey: string, currentPackHash: string): number {
        const existing = this.getEntry(scopeKey);
        if (!existing) return 1;
        if (existing.packHash === currentPackHash) return existing.revision;
        return existing.revision + 1;
    }

    /**
     * Get previous manifest for incremental export comparison.
     * Normalizes legacy PackEntry fields on load.
     */
    async getPreviousManifest(scopeKey: string): Promise<PackManifest | null> {
        const entry = this.getEntry(scopeKey);
        if (!entry) return null;

        try {
            const manifestPath = `${entry.packFolderPath}/manifest.json`;
            const file = this.app.vault.getAbstractFileByPath(manifestPath);
            if (!file) return null;

            const content = await this.app.vault.adapter.read(manifestPath);
            const raw = JSON.parse(content) as Omit<PackManifest, 'entries'> & { entries: unknown[] };
            return {
                ...raw,
                entries: (raw.entries ?? []).map(normalizePackEntry),
            };
        } catch (error) {
            logger.error('Export', 'Failed to load previous manifest:', error);
            return null;
        }
    }

    async deleteEntry(scopeKey: string): Promise<void> {
        if (!this.registry) {
            await this.loadRegistry();
        }
        delete this.registry!.packs[scopeKey];
        await this.saveRegistry();
    }

    getAllEntries(): PackRegistryEntry[] {
        if (!this.registry) return [];
        return Object.values(this.registry.packs);
    }

    hasBeenExported(scopeKey: string): boolean {
        return this.getEntry(scopeKey) !== null;
    }
}
