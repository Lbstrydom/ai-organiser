/**
 * @fileoverview SARIF output formatter for CLAUDE.md hygiene linter.
 * Hand-built SARIF JSON (no external dependency).
 */

/**
 * Convert a hygiene report to SARIF format.
 * @param {object} report - HygieneReport
 * @returns {object} SARIF JSON
 */
export function toSarif(report) {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'claudemd-lint',
          version: '1.0.0',
          informationUri: 'https://github.com/Lbstrydom/claude-engineering-skills',
          rules: buildRuleDescriptors(report.findings),
        },
      },
      results: report.findings.map(f => ({
        ruleId: f.ruleId,
        level: sarifLevel(f.severity),
        message: { text: f.message },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: f.file },
            region: f.line ? { startLine: f.line } : undefined,
          },
        }],
        fingerprints: { semanticId: f.semanticId },
      })),
    }],
  };
}

function sarifLevel(severity) {
  switch (severity) {
    case 'error': return 'error';
    case 'warn': return 'warning';
    case 'info': return 'note';
    default: return 'note';
  }
}

function buildRuleDescriptors(findings) {
  const seen = new Set();
  const rules = [];
  for (const f of findings) {
    if (seen.has(f.ruleId)) continue;
    seen.add(f.ruleId);
    rules.push({
      id: f.ruleId,
      shortDescription: { text: ruleDescription(f.ruleId) },
      defaultConfiguration: { level: sarifLevel(f.severity) },
    });
  }
  return rules;
}

function ruleDescription(ruleId) {
  const descs = {
    'size/claude-md': 'CLAUDE.md exceeds size budget',
    'size/agents-md': 'AGENTS.md exceeds size budget',
    'size/skill-md': 'SKILL.md exceeds size budget',
    'stale/file-ref': 'Referenced file path does not exist',
    'stale/function-ref': 'Referenced function/class not found',
    'stale/env-var': 'Referenced env var not found',
    'dup/cross-file': 'Paragraph-level duplication between files',
    'ref/deep-code-detail': 'Too many code blocks in instruction file',
    'sync/claude-agents': 'CLAUDE.md and AGENTS.md heading conflict',
  };
  return descs[ruleId] || ruleId;
}
