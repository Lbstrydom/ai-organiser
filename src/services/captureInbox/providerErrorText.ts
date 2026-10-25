/**
 * The one line a failed capture shows for a provider failure. A provider answers with raw JSON, status codes and
 * request ids that mean nothing to the user and can echo parts of the request, so the journal and the queue only
 * ever hold this friendly sentence; the detail goes to the debug log. Pure.
 */

const PATTERNS: Array<{ test: RegExp; text: string }> = [
    { test: /\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[^.]{0,20}key|no api key|not configured/i, text: 'The provider rejected the request. Check the API key in the plugin settings.' },
    { test: /\b429\b|rate.?limit|too many requests|quota|insufficient[_ ]funds|billing/i, text: 'The provider is limiting requests or your account has no credit left.' },
    { test: /\b413\b|too large|payload|exceeds[^.]{0,30}(size|limit)|file size|maximum content size/i, text: 'The provider says the file is too large.' },
    { test: /\b(5\d\d)\b|bad gateway|service unavailable|overloaded|time(?:d)? ?out|econn|enotfound|network|fetch failed|offline|could not be reached/i, text: 'The provider could not be reached or had a problem. This is often temporary.' },
    { test: /\b(400|415|422)\b|unsupported|invalid[^.]{0,20}(file|format|audio|image)|could not (read|decode|load)|failed to load/i, text: 'The provider could not read the file.' },
];

/** Friendly text for a provider failure, ending in a full stop. Never contains the raw provider message. */
export function friendlyProviderError(raw: string): string {
    const hit = PATTERNS.find((p) => p.test.test(raw));
    return hit ? hit.text : 'The provider could not complete the request.';
}

/** A sentence that ends in punctuation, so two can be joined without running together. */
export function endSentence(text: string): string {
    const t = text.trim();
    return t === '' || /[.!?]$/.test(t) ? t : `${t}.`;
}
