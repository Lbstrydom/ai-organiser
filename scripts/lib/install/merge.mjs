/**
 * @fileoverview Block-marker merge for .github/copilot-instructions.md.
 * Preserves operator-authored content, replaces only managed block.
 */

const START_MARKER = '<!-- audit-loop-bundle:start -->';
const END_MARKER = '<!-- audit-loop-bundle:end -->';

/**
 * Default block content for copilot-instructions.
 */
export const COPILOT_BLOCK = `${START_MARKER}
## Engineering Skills Bundle

This repo uses \`claude-engineering-skills\`. Five skills are available:

- \`/audit-loop\` -- multi-model plan-audit-fix orchestration with persistent debt memory
- \`/plan-backend\` -- backend architecture planning
- \`/plan-frontend\` -- frontend/UX planning
- \`/ship\` -- autonomous commit/push with docs update
- \`/audit\` -- single-pass plan audit

Source: https://github.com/Lbstrydom/claude-engineering-skills

## Keeping Skills Current
- Check for updates: \`node .audit-loop/bootstrap.mjs check\`
- Install latest: \`node .audit-loop/bootstrap.mjs install --surface both\`
${END_MARKER}`;

/**
 * Merge the managed block into copilot-instructions content.
 * @param {string|null} existing - Current file content (null if file doesn't exist)
 * @param {string} [block=COPILOT_BLOCK] - Block content to merge
 * @returns {string} Merged content
 */
export function mergeBlock(existing, block = COPILOT_BLOCK) {
  if (!existing) {
    // File absent — create with just our block
    return block + '\n';
  }

  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    // File present, no markers — append our block at end
    const trimmed = existing.trimEnd();
    return trimmed + '\n\n' + block + '\n';
  }

  // File present, markers found — replace only content between markers
  const before = existing.slice(0, startIdx);
  const after = existing.slice(endIdx + END_MARKER.length);
  return before + block + after;
}

/**
 * Extract just the managed block from content (for SHA comparison).
 * @param {string} content
 * @returns {string|null}
 */
export function extractBlock(content) {
  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1) return null;
  return content.slice(startIdx, endIdx + END_MARKER.length);
}

export { START_MARKER, END_MARKER };
