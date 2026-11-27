// Preflight for the local architectural-drift task (scripts/local/arch-drift-local.ps1).
//
// The task runs on whatever profile the owner's tooling resolves: the Azure work
// profile when it is configured, the public routes otherwise. It does not pick a
// profile itself; it only refuses to start a refresh that would publish an index
// with no summaries or no vectors.
//
// Every answer comes from the tooling's own oracles, never a raw env check:
//   - summariserAvailability()               (summary-route.mjs: the summariser's route,
//                                             Azure GPT / Foundry Claude / public Claude)
//   - azureConfig.active                     (config.mjs: on Azure, embeddings go to the
//                                             profile's embedding deployment)
//   - resolveProviderAvailability('gemini')  (provider-availability.mjs: the public embedder)
//   - dbConfig.url presence                  (config.mjs: the cloud store)
//
// Prints one JSON line of booleans, route names and reasons. Never prints a key, a DSN
// or a host. Exit 0 when the run may proceed; 1 with `problems` naming what is missing.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tooling = path.resolve('scripts/.claude-skills/lib');
const load = (f) => import(pathToFileURL(path.join(tooling, f)).href);

const { azureConfig, dbConfig } = await load('config.mjs');
const { summariserAvailability } = await load('summary-route.mjs');
const { resolveProviderAvailability } = await load('provider-availability.mjs');

const summariser = summariserAvailability();
const embedder = azureConfig.active
  ? { available: true, route: 'azure', reason: null }
  : resolveProviderAvailability('gemini');

const result = {
  profile: azureConfig.active ? 'azure' : 'public',
  cloudStore: Boolean(dbConfig.url),
  summariser: summariser.available,
  summaryRoute: summariser.route,
  embedder: Boolean(embedder.available),
  embedRoute: embedder.route,
  problems: [],
};
if (!result.cloudStore) result.problems.push('AUDIT_DB_URL is not set in ~/.audit-loop.env');
if (!result.summariser) result.problems.push(`no summariser route: ${summariser.reason}`);
if (!result.embedder) result.problems.push(`no embedding route: ${embedder.reason || 'add GEMINI_API_KEY to ~/.audit-loop.env'}`);

console.log(JSON.stringify(result));
process.exit(result.problems.length ? 1 : 0);
