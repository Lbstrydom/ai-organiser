// Preflight for the local architectural-drift task (scripts/local/arch-drift-local.ps1).
//
// The task deliberately runs WITHOUT the main checkout's .env (the caller points
// DOTENV_CONFIG_PATH at an empty file), so the Azure work profile defined there stays
// off for this process tree and the refresh summarises and embeds through the public
// routes. Everything else that reads that .env (interactive audits, the plugin's own
// tests) is untouched. The plugin's Azure setup in Obsidian is separate and unaffected.
//
// Every answer comes from the tooling's own oracles, never a raw env check:
//   - azureConfig.active                     (config.mjs: the Azure profile gate)
//   - isClaudeAvailableFor('sdk')            (anthropic-client.mjs: the summariser's route)
//   - resolveProviderAvailability('gemini')  (provider-availability.mjs: the embedder's route)
//   - dbConfig.url presence                  (config.mjs: the cloud store)
//
// Prints one JSON line of booleans and reasons. Never prints a key, a DSN or a host.
// Exit 0 when the run may proceed; 1 with `problems` naming what to add.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tooling = path.resolve('scripts/.claude-skills/lib');
const load = (f) => import(pathToFileURL(path.join(tooling, f)).href);

const { azureConfig, dbConfig } = await load('config.mjs');
const { isClaudeAvailableFor } = await load('anthropic-client.mjs');
const { resolveProviderAvailability } = await load('provider-availability.mjs');

const gemini = resolveProviderAvailability('gemini');
const result = {
  azureProfileActive: azureConfig.active,
  cloudStore: Boolean(dbConfig.url),
  claudePublic: !azureConfig.active && isClaudeAvailableFor('sdk'),
  geminiPublic: gemini.available && gemini.route === 'public',
  problems: [],
};
if (result.azureProfileActive) {
  result.problems.push('the Azure work profile is active in the task process; the task must not load the main checkout .env');
}
if (!result.cloudStore) result.problems.push('AUDIT_DB_URL is not set in ~/.audit-loop.env');
if (!result.claudePublic) result.problems.push('no public Claude route: add ANTHROPIC_API_KEY to ~/.audit-loop.env');
if (!result.geminiPublic) result.problems.push(`no public Gemini route: add GEMINI_API_KEY to ~/.audit-loop.env${gemini.reason ? ` (${gemini.reason})` : ''}`);

console.log(JSON.stringify(result));
process.exit(result.problems.length ? 1 : 0);
