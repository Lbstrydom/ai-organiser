/**
 * Model-family rules live in modelCapabilities.ts and Azure defaults in
 * core/azureDefaults.ts. A name check written at a call site is how every GPT-6
 * text request came to fail, so this fails the build when one reappears.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src');
const OWNER = 'modelCapabilities.ts';
const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts') && !f.endsWith(OWNER));

/** A GPT / o-series version tested by prefix or substring. */
const VERSION_CHECK = /\.(startsWith|includes)\(\s*['"`](gpt-\d|o\d)/;

describe('model name convention', () => {
    it('the pattern catches the check that caused the defect', () => {
        expect(VERSION_CHECK.test("modelName.startsWith('gpt-5') ||")).toBe(true);
        expect(files.length).toBeGreaterThan(100);
    });

    it('no source file outside modelCapabilities tests a GPT version by name', () => {
        const offenders = files.filter((f) => VERSION_CHECK.test(readFileSync(join(SRC, f), 'utf8')));
        expect(offenders).toEqual([]);
    });
});
