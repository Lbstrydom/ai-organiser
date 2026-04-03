/**
 * Kindle Cookie & Book Extraction Bookmarklet Generator
 *
 * Generates JavaScript that runs on the Amazon notebook page to extract:
 * 1. document.cookie for authentication
 * 2. Book list from the rendered DOM (title, author, ASIN, highlight count)
 *
 * Output format: JSON string `{"c":"<cookies>","b":[{"a":"<asin>",...},...]}`
 * The plugin detects this JSON format and uses the pre-scraped books,
 * avoiding the need for HTTP-based book list fetching (which fails because
 * Amazon's notebook page loads books via JavaScript, not server-side rendering).
 */

/**
 * Non-book element IDs that match the kp-notebook-library- prefix
 * but are UI state placeholders, not actual book containers.
 */
const NON_BOOK_IDS = /^(spinner|load-error|no-results|loading|empty|placeholder|error|container|header|footer|wrapper|content|section|nav|menu)$/i;

/**
 * Build the inline JavaScript that extracts cookies + books from the DOM.
 * Used by both bookmarklet and console command generators.
 *
 * Multi-strategy book discovery:
 * 1. ID-based: `[id^="kp-notebook-library-"]` with non-book filtering
 * 2. data-asin fallback: `[data-asin]` attribute
 * 3. Link-based fallback: `<a href="...?asin=">` links
 */
function buildExtractionScript(opts: { copyMethod: 'clipboard' | 'devtools-copy' }): string {
    // Core extraction logic (runs in browser context on read.amazon.com/notebook)
    // Short variable names to keep bookmarklet URL compact
    const extractionLogic = [
        'var B=[],S={};',
        // extractBook helper
        'function X(e,a){',
        'var t=(e.querySelector("h2,h3,[class*=title]")||{}).textContent||"";',
        'var u=(e.querySelector("p,[class*=author]")||{}).textContent||"";',
        'u=u.replace(/^(by|von|de|di|por|da|par)\\s+/i,"").trim();',
        'var m=(e.textContent||"").match(/(\\d+)\\s*(highlight|annot|markier)/i);',
        'return{a:a,t:t.trim(),u:u,h:m?parseInt(m[1]):0,i:(e.querySelector("img")||{}).src||""}}',
        // Strategy 1: ID-based
        'document.querySelectorAll("[id^=\\"kp-notebook-library-\\"]").forEach(function(e){',
        'var a=e.id.replace("kp-notebook-library-","");',
        'if(a&&a.length>=4&&!/^(spinner|load-error|no-results|loading|empty|placeholder|error|container|header|footer|wrapper|content|section|nav|menu)$/i.test(a)&&!S[a]){S[a]=1;B.push(X(e,a))}});',
        // Strategy 2: data-asin fallback
        'if(!B.length){document.querySelectorAll("[data-asin]").forEach(function(e){',
        'var a=e.getAttribute("data-asin")||"";',
        'if(a&&!S[a]){S[a]=1;B.push(X(e,a))}})}',
        // Strategy 3: Link-based fallback
        'if(!B.length){document.querySelectorAll("a[href*=\\"asin=\\"]").forEach(function(e){',
        'var m=e.href.match(/asin=([A-Z0-9]{10})/i);',
        'if(m&&!S[m[1]]){S[m[1]]=1;var p=e.closest("[class*=library],[class*=book]")||e.parentElement;',
        'B.push(X(p||e,m[1]))}})}',
        // Build result
        'var R=JSON.stringify({c:document.cookie,b:B});',
    ].join('');

    if (opts.copyMethod === 'devtools-copy') {
        // DevTools console — use copy() built-in
        return extractionLogic + 'copy(R);"Copied "+B.length+" books"';
    }

    // Bookmarklet — clipboard with banner + prompt fallback
    return [
        '(function(){',
        extractionLogic,
        'function show(m){var d=document.createElement("div");d.textContent=m;',
        'd.style.cssText="position:fixed;top:0;left:0;right:0;padding:12px;background:#22c55e;color:#fff;text-align:center;z-index:99999;font-size:16px";',
        'document.body.appendChild(d);setTimeout(function(){d.remove()},5e3)}',
        'try{navigator.clipboard.writeText(R).then(function(){',
        'show("Copied! "+B.length+" books found. Return to Obsidian.")}).catch(function(){',
        'window.prompt("Copy:",R)})}catch(e){window.prompt("Copy:",R)}',
        '})();',
    ].join('');
}

/**
 * Generate a JavaScript bookmarklet URL that copies cookies + book list.
 *
 * When clicked on read.amazon.com/notebook:
 * 1. Extracts document.cookie
 * 2. Extracts book list from rendered DOM (3 fallback strategies)
 * 3. Copies JSON `{"c":"...","b":[...]}` to clipboard
 * 4. Shows green banner with book count
 */
export function generateCookieBookmarklet(): string {
    return `javascript:${encodeURIComponent(buildExtractionScript({ copyMethod: 'clipboard' }))}`;
}

/**
 * Generate a console script that copies cookies + book list.
 * Uses DevTools `copy()` built-in instead of clipboard API.
 */
export function generateConsoleScript(): string {
    return buildExtractionScript({ copyMethod: 'devtools-copy' });
}

export { NON_BOOK_IDS };
