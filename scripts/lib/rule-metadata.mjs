/**
 * @fileoverview Rule metadata registry — maps tool rule IDs to canonical audit taxonomy.
 * One registry per tool. Unknown rules fall back to the tool's _default, then the global _default.
 *
 * Contribution path: when a rule feels misclassified in practice, add a specific entry.
 * The registry grows organically from audit outcomes.
 * @module scripts/lib/rule-metadata
 */

export const RULE_METADATA = Object.freeze({
  eslint: Object.freeze({
    // Fatal parse/config errors — ESLint couldn't analyze the file at all.
    // Emitted by parseEslintOutput() when msg.fatal === true.
    'fatal-parse-error': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },
    // Bugs (runtime-breaking)
    'no-undef': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },
    'no-unreachable': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },
    'no-dupe-keys': { severity: 'HIGH', sonarType: 'BUG', effort: 'TRIVIAL', isQuickFix: false },
    'no-dupe-args': { severity: 'HIGH', sonarType: 'BUG', effort: 'TRIVIAL', isQuickFix: false },
    'use-before-define': { severity: 'MEDIUM', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },
    // Vulnerabilities
    'no-eval': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM', isQuickFix: false },
    'no-implied-eval': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM', isQuickFix: false },
    // Code smells
    'no-unused-vars': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL', isQuickFix: false },
    'no-console': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL', isQuickFix: false },
    'prefer-const': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL', isQuickFix: false },
    '@typescript-eslint/no-explicit-any': { severity: 'MEDIUM', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false },
    '@typescript-eslint/no-unused-vars': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL', isQuickFix: false },
    _default: { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false },
  }),

  ruff: Object.freeze({
    // Security (S-prefix = bandit-integrated rules)
    'S102': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM', isQuickFix: false }, // exec-builtin
    'S301': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM', isQuickFix: false }, // pickle
    'S307': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM', isQuickFix: false }, // eval-used
    'S608': { severity: 'HIGH', sonarType: 'VULNERABILITY', effort: 'MEDIUM', isQuickFix: false }, // sql injection
    'S324': { severity: 'MEDIUM', sonarType: 'VULNERABILITY', effort: 'EASY', isQuickFix: false }, // weak hash
    // Bugs (F-prefix = pyflakes)
    'F401': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL', isQuickFix: false }, // unused import
    'F811': { severity: 'MEDIUM', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },        // redefined
    'F821': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },          // undefined name
    'F841': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL', isQuickFix: false }, // unused variable
    // Bugbear
    'B006': { severity: 'MEDIUM', sonarType: 'BUG', effort: 'EASY', isQuickFix: false }, // mutable default arg
    'B008': { severity: 'MEDIUM', sonarType: 'BUG', effort: 'EASY', isQuickFix: false }, // function call in default
    'E722': { severity: 'MEDIUM', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false }, // bare except
    _default: { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false },
  }),

  tsc: Object.freeze({
    'TS2304': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },  // Cannot find name
    'TS2322': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },  // Type not assignable
    'TS2339': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },  // Property does not exist
    'TS2345': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },  // Argument type mismatch
    'TS7006': { severity: 'MEDIUM', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false }, // Implicit any
    'TS7053': { severity: 'MEDIUM', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false }, // Index expression
    'TS18048': { severity: 'MEDIUM', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },       // possibly undefined
    _default: { severity: 'MEDIUM', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },
  }),

  flake8: Object.freeze({
    // Flake8 uses same E/F/W codes as ruff for overlapping rules
    'F401': { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'TRIVIAL', isQuickFix: false },
    'F821': { severity: 'HIGH', sonarType: 'BUG', effort: 'EASY', isQuickFix: false },
    'E722': { severity: 'MEDIUM', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false },
    _default: { severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false },
  }),

  _default: Object.freeze({
    severity: 'LOW', sonarType: 'CODE_SMELL', effort: 'EASY', isQuickFix: false,
  }),
});

/**
 * Look up metadata for a rule. Falls back to the tool's `_default`, then to the global `_default`.
 * @param {string} toolId - e.g. 'eslint', 'ruff', 'tsc', 'flake8'
 * @param {string} ruleId - e.g. 'no-unused-vars', 'F401', 'TS2304'
 * @returns {{ severity: string, sonarType: string, effort: string, isQuickFix: boolean }}
 */
export function getRuleMetadata(toolId, ruleId) {
  const toolRegistry = RULE_METADATA[toolId];
  if (!toolRegistry) return RULE_METADATA._default;
  return toolRegistry[ruleId] || toolRegistry._default || RULE_METADATA._default;
}
