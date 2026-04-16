/**
 * Newsletter Digest Types
 *
 * Interfaces for the Gmail → AI triage → vault inbox pipeline.
 */

export interface RawNewsletter {
    id: string;          // Gmail Message-ID
    from: string;        // "Newsletter Name <email@example.com>"
    subject: string;
    date: string;        // ISO timestamp
    body: string;        // HTML
    plain: string;       // Plain text fallback
}

export interface ProcessedNewsletter {
    id: string;
    from: string;
    subject: string;
    date: string;
    senderName: string;
    markdown: string;        // Full converted content
    triage: string | null;   // AI triage summary (null if LLM failed or extraction failed)
    llmFailed: boolean;
    /** True when extractNewsletterText produced too little text to triage reliably. */
    extractionFailed?: boolean;
    /** Resolved vault path set during note creation — used to build digest links. */
    _resolvedPath?: string;
    /** Key content links extracted from HTML body (spam-filtered, max 10). */
    keyLinks: Array<{text: string; href: string}>;
}

export interface NewsletterFetchResult {
    newsletters: ProcessedNewsletter[];
    totalFetched: number;
    totalNew: number;
    totalSkipped: number;
    errors: string[];
    hitLimit: boolean;  // true when totalFetched === the configured fetch limit
}
