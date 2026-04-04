/**
 * URL Validator with SSRF Protection
 */

const BLOCKED_HOSTS = new Set([
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    '[::1]',
]);

const PRIVATE_IP_RANGES = [
    /^10\./,                          // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
    /^192\.168\./,                    // 192.168.0.0/16
    /^169\.254\./,                    // Link-local
    /^fc00:/i,                        // IPv6 private
    /^fe80:/i,                        // IPv6 link-local
];

export interface UrlValidationResult {
    valid: boolean;
    url?: string;
    error?: string;
}

/**
 * Validate and normalize a URL, blocking potentially dangerous URLs
 */
export function validateUrl(input: string): UrlValidationResult {
    try {
        let urlString = input.trim();

        // Reject non-HTTP(S) schemes before normalization
        // This prevents file://, ftp://, javascript:, data:, etc.
        const schemeMatch = urlString.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//);
        if (schemeMatch) {
            const scheme = schemeMatch[1].toLowerCase();
            if (scheme !== 'http' && scheme !== 'https') {
                return { valid: false, error: 'Only HTTP and HTTPS URLs are allowed' };
            }
        }

        // Add protocol if missing (for inputs like "example.com")
        if (!urlString.startsWith('http://') && !urlString.startsWith('https://')) {
            urlString = 'https://' + urlString;
        }

        const parsed = new URL(urlString);

        // Only allow http/https
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return { valid: false, error: 'Only HTTP and HTTPS URLs are allowed' };
        }

        // Block localhost and common local hostnames
        const hostname = parsed.hostname.toLowerCase();
        if (BLOCKED_HOSTS.has(hostname)) {
            return { valid: false, error: 'Local URLs are not allowed' };
        }

        // Block private IP ranges
        for (const pattern of PRIVATE_IP_RANGES) {
            if (pattern.test(hostname)) {
                return { valid: false, error: 'Private network URLs are not allowed' };
            }
        }

        // Block .local and .internal domains
        if (hostname.endsWith('.local') || hostname.endsWith('.internal')) {
            return { valid: false, error: 'Local network URLs are not allowed' };
        }

        return { valid: true, url: parsed.href };

    } catch (_e) {
        return { valid: false, error: 'Invalid URL format' };
    }
}

/**
 * Check if a URL appears to be a direct PDF link
 */
export function isPdfUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname.toLowerCase();
        return pathname.endsWith('.pdf');
    } catch {
        return false;
    }
}

/**
 * Extract filename from URL
 */
export function extractFilenameFromUrl(url: string): string | null {
    try {
        const pathname = new URL(url).pathname;
        const segments = pathname.split('/');
        const lastSegment = segments[segments.length - 1];
        if (lastSegment && lastSegment.includes('.')) {
            return decodeURIComponent(lastSegment);
        }
    } catch {
        // Ignore
    }
    return null;
}
