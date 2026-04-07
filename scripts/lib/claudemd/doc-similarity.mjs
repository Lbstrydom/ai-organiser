/**
 * @fileoverview Document-level Jaccard similarity for detecting duplicated content
 * between instruction files. Own implementation (not from ledger.mjs).
 * Markdown-aware: strips formatting, links, code blocks before tokenizing.
 */

/** Common English stopwords to exclude from token sets. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'can', 'shall', 'this', 'that',
  'these', 'those', 'it', 'its', 'not', 'no', 'if', 'then', 'else',
  'when', 'which', 'who', 'what', 'how', 'where', 'why', 'all', 'each',
  'every', 'any', 'as', 'so', 'than', 'too', 'very', 'just', 'also',
]);

/**
 * Normalize markdown text for comparison.
 * Strips formatting, links, inline code.
 * @param {string} text
 * @returns {string}
 */
function normalizeMarkdown(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')  // [text](url) → text
    .replace(/`[^`]+`/g, '')                    // strip inline code
    .replace(/\*\*([^*]+)\*\*/g, '$1')          // **bold** → bold
    .replace(/\*([^*]+)\*/g, '$1')              // *italic* → italic
    .replace(/#+\s*/g, '')                       // strip heading markers
    .replace(/[-*]\s+/g, '')                     // strip list markers
    .replace(/\|/g, ' ')                         // strip table pipes
    .toLowerCase();
}

/**
 * Tokenize text into a set of meaningful words.
 * @param {string} text
 * @returns {Set<string>}
 */
function tokenize(text) {
  const normalized = normalizeMarkdown(text);
  const words = normalized.match(/[a-z0-9_]{2,}/g) || [];
  return new Set(words.filter(w => !STOPWORDS.has(w)));
}

/**
 * Compute Jaccard similarity between two token sets.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number} 0.0 to 1.0
 */
export function jaccardSimilarity(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Extract paragraphs from markdown content (skipping code blocks).
 * @param {string} content
 * @returns {Array<{ text: string, startLine: number }>}
 */
export function extractParagraphs(content) {
  const paragraphs = [];
  const lines = content.split('\n');
  let current = [];
  let startLine = 0;
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      if (current.length > 0) {
        paragraphs.push({ text: current.join('\n'), startLine: startLine + 1 });
        current = [];
      }
      continue;
    }
    if (inCodeBlock) continue;

    if (line.trim() === '') {
      if (current.length > 0) {
        paragraphs.push({ text: current.join('\n'), startLine: startLine + 1 });
        current = [];
      }
    } else {
      if (current.length === 0) startLine = i;
      current.push(line);
    }
  }

  if (current.length > 0) {
    paragraphs.push({ text: current.join('\n'), startLine: startLine + 1 });
  }

  return paragraphs;
}

/**
 * Find similar paragraphs between two documents.
 * @param {string} contentA - First document
 * @param {string} contentB - Second document
 * @param {object} [options]
 * @param {number} [options.threshold=0.8] - Jaccard threshold
 * @param {number} [options.minTokens=50] - Minimum tokens in a paragraph
 * @returns {Array<{ paraA: { text: string, line: number }, paraB: { text: string, line: number }, score: number }>}
 */
export function findSimilarParagraphs(contentA, contentB, options = {}) {
  const threshold = options.threshold ?? 0.8;
  const minTokens = options.minTokens ?? 50;

  const parasA = extractParagraphs(contentA);
  const parasB = extractParagraphs(contentB);

  // Pre-tokenize B to avoid repeated work in inner loop
  const tokenizedB = parasB.map(b => ({ ...b, tokens: tokenize(b.text) }))
    .filter(b => b.tokens.size >= minTokens);

  const matches = [];

  for (const a of parasA) {
    const tokensA = tokenize(a.text);
    if (tokensA.size < minTokens) continue;

    for (const b of tokenizedB) {
      const tokensB = b.tokens;

      const score = jaccardSimilarity(tokensA, tokensB);
      if (score >= threshold) {
        matches.push({
          paraA: { text: a.text.slice(0, 100), line: a.startLine },
          paraB: { text: b.text.slice(0, 100), line: b.startLine },
          score,
        });
      }
    }
  }

  return matches;
}

export { tokenize, normalizeMarkdown, STOPWORDS };
