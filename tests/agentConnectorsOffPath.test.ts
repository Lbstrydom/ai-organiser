/**
 * Agent connectors: default off and byte-identical when off. No command, no section, no file; the
 * feature needs the agent index; settings migrate safely and the folder is never assumed.
 */
import { describe, it, expect, vi } from 'vitest';
import { FEATURE_BY_ID } from '../src/core/features';
import { isFeatureEnabled } from '../src/services/featureService';
import { DEFAULT_SETTINGS, migrateOldSettings } from '../src/core/settings';
import { REGISTER_BY_FEATURE, registerCommands } from '../src/commands/index';
import { registerAgentConnectorCommands } from '../src/commands/agentConnectorCommands';
import { en } from '../src/i18n/en';
import { GUIDANCE_CODES } from '../src/core/friendlyErrors';

describe('agent connectors off path', () => {
	it('is a default-off find row that needs the agent index', () => {
		const def = FEATURE_BY_ID['agent-connectors'];
		expect(def).toMatchObject({ defaultOn: false, stage: 'find', requires: ['agent-index'] });
		expect(isFeatureEnabled({ featureFlags: {} } as never, 'agent-connectors')).toBe(false);
		// Turned on, but the index it depends on is off: still off (fail closed).
		expect(isFeatureEnabled({ featureFlags: { 'agent-connectors': true } } as never, 'agent-connectors')).toBe(false);
		expect(isFeatureEnabled({ featureFlags: { 'agent-connectors': true, 'agent-index': true } } as never, 'agent-connectors')).toBe(true);
		expect(isFeatureEnabled({ featureFlags: { 'agent-connectors': 'yes', 'agent-index': true } } as never, 'agent-connectors')).toBe(false);
	});

	it('registers through its feature only, and nothing at all when off', () => {
		expect(REGISTER_BY_FEATURE['agent-connectors']).toEqual([registerAgentConnectorCommands]);
		const addCommand = vi.fn();
		const plugin = {
			settings: { ...structuredClone(DEFAULT_SETTINGS), featureFlags: {} },
			addCommand, registerEvent: vi.fn(), register: vi.fn(), registerInterval: vi.fn(), registerDomEvent: vi.fn(),
			app: { vault: { on: vi.fn() } },
			t: {},
		};
		let thrown: unknown = null;
		try { registerCommands(plugin as never); } catch (e) { thrown = e; /* other registrars need a fuller app */ }
		expect(String(thrown)).not.toMatch(/connector/i);
		const ids = addCommand.mock.calls.map((c) => (c[0] as { id: string }).id);
		expect(ids.filter((i) => /connector|vault-map/.test(i))).toEqual([]);
		expect(plugin.registerInterval).not.toHaveBeenCalled();
		expect(plugin.app.vault.on).not.toHaveBeenCalled();
	});

	it('registers its two commands when on', () => {
		const ids: string[] = [];
		registerAgentConnectorCommands({ addCommand: (c: { id: string }) => ids.push(c.id), t: en } as never);
		expect(ids).toEqual(['open-agent-connectors', 'export-vault-map']);
	});

	it('never assumes a folder, and migrates without change', () => {
		expect(DEFAULT_SETTINGS.agentConnectorFolder).toBe('');
		const migrated = migrateOldSettings(structuredClone(DEFAULT_SETTINGS) as never) as Record<string, unknown>;
		expect(migrated.agentConnectorFolder).toBe('');
		const odd = migrateOldSettings({ ...structuredClone(DEFAULT_SETTINGS), agentConnectorFolder: 42 } as never) as Record<string, unknown>;
		expect(odd.agentConnectorFolder).toBe('');
		const padded = migrateOldSettings({ ...structuredClone(DEFAULT_SETTINGS), agentConnectorFolder: '  Tools  ' } as never) as Record<string, unknown>;
		expect(padded.agentConnectorFolder).toBe('Tools');
	});

	it('has plain-language guidance for every code it can show', () => {
		for (const code of ['connector-folder-missing', 'connector-folder-invalid', 'connector-file-not-ours', 'connector-needs-desktop', 'connector-node-missing', 'connector-vault-path-unavailable', 'export-nothing-in-scope']) {
			expect(GUIDANCE_CODES).toContain(code);
			const g = (en.guidance as Record<string, { message: string; nextStep: string }>)[code];
			expect(g.message.length).toBeGreaterThan(10);
			expect(g.nextStep.length).toBeGreaterThan(10);
		}
	});
});
