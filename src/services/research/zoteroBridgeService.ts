/**
 * Zotero Bridge Service
 *
 * Detects obsidian-zotero-desktop-connector, transforms research sources
 * to CSL-JSON, sends via Zotero's local HTTP API, with clipboard fallback (AD-17).
 *
 * No Zotero SDK dependency — all communication via requestUrl() to localhost.
 */

import { Platform, requestUrl } from 'obsidian';
import type { App } from 'obsidian';
import type { SourceMetadata, CslJsonItem } from './researchTypes';
import { ACADEMIC_DOMAINS } from './academicUtils';

const ZOTERO_CONNECTOR_PLUGIN_ID = 'obsidian-zotero-desktop-connector';
const ZOTERO_API_BASE = 'http://localhost:23119';

export class ZoteroBridgeService {
    /** Check if Zotero connector plugin is available. */
    isAvailable(app: App): boolean {
        if (Platform.isMobile) return false;
        return (app as any).plugins?.enabledPlugins?.has(ZOTERO_CONNECTOR_PLUGIN_ID) ?? false;
    }

    /** Whether the Zotero button should be shown (always on desktop for discoverability). */
    shouldShowButton(): boolean {
        return !Platform.isMobile;
    }

    /** Transform research sources into CSL-JSON format. */
    toCslJson(sources: SourceMetadata[]): CslJsonItem[] {
        const now = new Date();
        return sources.map(source => {
            const item: CslJsonItem = {
                type: this.inferItemType(source),
                title: source.title,
                URL: source.url,
                accessed: {
                    'date-parts': [[now.getFullYear(), now.getMonth() + 1, now.getDate()]],
                },
            };

            if (source.doi) {
                item.DOI = source.doi;
            }

            if (source.authors?.length) {
                item.author = source.authors.map(name => {
                    const parts = name.split(/\s+/);
                    if (parts.length >= 2) {
                        return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') };
                    }
                    return { family: name, given: '' };
                });
            }

            if (source.year) {
                item.issued = { 'date-parts': [[source.year]] };
            }

            item['container-title'] = source.domain;

            return item;
        });
    }

    /** Send items to Zotero via connector HTTP API. */
    async sendToZotero(
        items: CslJsonItem[],
        collection?: string,
    ): Promise<{ success: boolean; error?: string }> {
        try {
            const payload: any[] = items.map(item => ({
                ...item,
                ...(collection ? { collections: [collection] } : {}),
            }));

            await requestUrl({
                url: `${ZOTERO_API_BASE}/api/users/0/items`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            return { success: true };
        } catch (e) {
            return { success: false, error: (e as Error).message };
        }
    }

    /** Copy CSL-JSON to clipboard as fallback. */
    async copyToClipboard(items: CslJsonItem[]): Promise<void> {
        const json = JSON.stringify(items, null, 2);
        await navigator.clipboard.writeText(json);
    }

    /** Infer CSL-JSON item type from source metadata. */
    private inferItemType(source: SourceMetadata): CslJsonItem['type'] {
        // Academic domains → article-journal (single source of truth from academicUtils)
        if (ACADEMIC_DOMAINS.some(d => source.domain.includes(d))) return 'article-journal';
        if (source.doi) return 'article-journal';
        // .gov domains → report
        if (source.domain.endsWith('.gov') || source.domain.endsWith('.gov.uk')) return 'report';
        return 'webpage';
    }
}
