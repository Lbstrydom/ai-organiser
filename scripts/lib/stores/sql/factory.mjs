/**
 * @fileoverview Factory that composes per-interface SQL repositories into a full adapter.
 * Used by both SQLite and Postgres adapters.
 */
import { GLOBAL_REPO_ID } from '../interfaces.mjs';

const SCHEMA_VERSION = 1;

/**
 * Verify schema version at runtime (read-only check).
 * @param {object} driver
 */
async function assertSchemaVersion(driver) {
  try {
    const { rows } = await driver.query(
      `SELECT v FROM schema_version ORDER BY v DESC LIMIT 1`, []
    );
    if (!rows.length) {
      throw new Error('No schema_version found. Run the setup CLI to initialize the database.');
    }
    const version = rows[0].v;
    if (version < SCHEMA_VERSION) {
      throw new Error(
        `Schema version ${version} but adapter requires ${SCHEMA_VERSION}. ` +
        `Run the setup CLI with --migrate.`
      );
    }
  } catch (err) {
    if (err.message?.includes('no such table') || err.code === '42P01') {
      throw new Error('Database not initialized. Run the setup CLI first.');
    }
    throw err;
  }
}

/**
 * Create a full SQL adapter from a driver.
 * @param {object} driver - Must implement query(), exec(), dialect, placeholder()
 * @param {object} [opts]
 * @param {string} [opts.schema] - Postgres schema name
 * @returns {Promise<object>} Adapter sub-interfaces
 */
export async function createSqlAdapter(driver, opts = {}) {
  const ph = (n) => driver.placeholder ? driver.placeholder(n) : (driver.dialect === 'postgres' ? `$${n}` : '?');
  const schema = opts.schema;
  const tbl = (name) => schema ? `"${schema}"."${name}"` : `"${name}"`;
  const now = () => new Date().toISOString();

  return {
    debt: {
      async upsertDebtEntries(repoId, entries) {
        let inserted = 0;
        for (const e of entries) {
          try {
            await driver.exec(
              `INSERT INTO ${tbl('debt_entries')} (repo_id, topic_id, severity, category, detail, payload_json, created_at, updated_at)
               VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)}, ${ph(7)}, ${ph(8)})
               ON CONFLICT (repo_id, topic_id) DO UPDATE SET severity = EXCLUDED.severity, detail = EXCLUDED.detail, payload_json = EXCLUDED.payload_json, updated_at = EXCLUDED.updated_at`,
              [repoId, e.topicId || e.topic_id, e.severity, e.category, e.detail?.slice(0, 500), JSON.stringify(e), now(), now()]
            );
            inserted++;
          } catch (err) { process.stderr.write(`  [sql] debt upsert error: ${err.message}\n`); }
        }
        return { ok: true, inserted, updated: 0 };
      },

      async readDebtEntries(repoId) {
        const { rows } = await driver.query(
          `SELECT * FROM ${tbl('debt_entries')} WHERE repo_id = ${ph(1)}`, [repoId]
        );
        return rows;
      },

      async removeDebtEntry(repoId, topicId) {
        const { changes } = await driver.exec(
          `DELETE FROM ${tbl('debt_entries')} WHERE repo_id = ${ph(1)} AND topic_id = ${ph(2)}`, [repoId, topicId]
        );
        return { ok: true, removed: changes > 0 };
      },

      async appendDebtEvents(repoId, events) {
        let inserted = 0;
        for (const e of events) {
          try {
            const key = e.idempotencyKey || e.idempotency_key;
            if (!key) {
              process.stderr.write(`  [sql] WARN: appendDebtEvents skipped event without idempotencyKey\n`);
              continue;
            }
            await driver.exec(
              `INSERT INTO ${tbl('debt_events')} (repo_id, idempotency_key, topic_id, event, payload_json, created_at)
               VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)})
               ON CONFLICT (idempotency_key) DO NOTHING`,
              [repoId, key, e.topicId || e.topic_id, e.event, JSON.stringify(e), e.ts || now()]
            );
            inserted++;
          } catch (err) { process.stderr.write(`  [sql] debt event error: ${err.message}\n`); }
        }
        return { inserted };
      },

      async readDebtEvents(repoId, sinceTs) {
        let sql = `SELECT * FROM ${tbl('debt_events')} WHERE repo_id = ${ph(1)}`;
        const params = [repoId];
        if (sinceTs) {
          sql += ` AND created_at >= ${ph(2)}`;
          params.push(sinceTs);
        }
        sql += ' ORDER BY created_at ASC';
        const { rows } = await driver.query(sql, params);
        return rows;
      },
    },

    run: {
      async recordRunStart(repoId, planFile, mode, runId) {
        if (!runId) runId = crypto.randomUUID();
        await driver.exec(
          `INSERT INTO ${tbl('audit_runs')} (run_id, repo_id, plan_file, mode, started_at)
           VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)})
           ON CONFLICT (run_id) DO NOTHING`,
          [runId, repoId, planFile, mode, now()]
        );
        return runId;
      },

      async recordRunComplete(runId, stats) {
        await driver.exec(
          `UPDATE ${tbl('audit_runs')} SET completed_at = ${ph(1)}, stats_json = ${ph(2)} WHERE run_id = ${ph(3)}`,
          [now(), JSON.stringify(stats), runId]
        );
      },

      async recordFindings(runId, findings, passName, round) {
        for (const f of findings) {
          const hash = f._hash || f.id;
          if (!hash) {
            process.stderr.write(`  [sql] WARN: recordFindings skipped finding without _hash or id\n`);
            continue;
          }
          try {
            await driver.exec(
              `INSERT INTO ${tbl('audit_findings')} (run_id, finding_hash, pass_name, round, severity, category, detail, created_at)
               VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)}, ${ph(7)}, ${ph(8)})
               ON CONFLICT (run_id, finding_hash) DO NOTHING`,
              [runId, hash, passName, round, f.severity, f.category, f.detail?.slice(0, 500), now()]
            );
          } catch (err) { process.stderr.write(`  [sql] finding record error: ${err.message}\n`); }
        }
      },

      async recordPassStats(runId, passName, stats) {
        await driver.exec(
          `INSERT INTO ${tbl('audit_pass_stats')} (run_id, pass_name, stats_json, created_at)
           VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)})
           ON CONFLICT (run_id, pass_name) DO UPDATE SET stats_json = EXCLUDED.stats_json`,
          [runId, passName, JSON.stringify(stats), now()]
        );
      },

      async recordAdjudicationEvent(runId, fingerprint, event) {
        await driver.exec(
          `INSERT INTO ${tbl('adjudication_events')} (run_id, fingerprint, event_json, created_at)
           VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)})`,
          [runId, fingerprint, JSON.stringify(event), now()]
        );
      },

      async recordSuppressionEvents(runId, result) {
        await driver.exec(
          `INSERT INTO ${tbl('suppression_events')} (run_id, result_json, created_at)
           VALUES (${ph(1)}, ${ph(2)}, ${ph(3)})`,
          [runId, JSON.stringify(result), now()]
        );
      },
    },

    learningState: {
      async syncBanditArms(repoId, arms) {
        const armsJson = JSON.stringify(arms);
        await driver.exec(
          `INSERT INTO ${tbl('bandit_arms')} (repo_id, arms_json, updated_at)
           VALUES (${ph(1)}, ${ph(2)}, ${ph(3)})
           ON CONFLICT (repo_id) DO UPDATE SET arms_json = EXCLUDED.arms_json, updated_at = EXCLUDED.updated_at`,
          [repoId, armsJson, now()]
        );
      },

      async loadBanditArms(repoId) {
        const { rows } = await driver.query(
          `SELECT arms_json FROM ${tbl('bandit_arms')} WHERE repo_id = ${ph(1)}`, [repoId]
        );
        if (!rows.length) return null;
        try { return JSON.parse(rows[0].arms_json); } catch { return null; }
      },

      async syncFalsePositivePatterns(repoId, patterns) {
        const patternsJson = JSON.stringify(patterns);
        await driver.exec(
          `INSERT INTO ${tbl('fp_patterns')} (repo_id, patterns_json, updated_at)
           VALUES (${ph(1)}, ${ph(2)}, ${ph(3)})
           ON CONFLICT (repo_id) DO UPDATE SET patterns_json = EXCLUDED.patterns_json, updated_at = EXCLUDED.updated_at`,
          [repoId, patternsJson, now()]
        );
      },

      async loadFalsePositivePatterns(repoId) {
        const { rows } = await driver.query(
          `SELECT repo_id, patterns_json FROM ${tbl('fp_patterns')} WHERE repo_id IN (${ph(1)}, ${ph(2)})`,
          [repoId, GLOBAL_REPO_ID]
        );
        let repoPatterns = {}, globalPatterns = {};
        for (const row of rows) {
          try {
            const parsed = JSON.parse(row.patterns_json);
            if (row.repo_id === GLOBAL_REPO_ID) globalPatterns = parsed;
            else repoPatterns = parsed;
          } catch (err) { process.stderr.write(`  [sql] FP pattern parse error: ${err.message}\n`); }
        }
        return { repoPatterns, globalPatterns };
      },
    },

    globalState: {
      async syncPromptRevision(passName, revisionId, text) {
        await driver.exec(
          `INSERT INTO ${tbl('prompt_variants')} (pass_name, variant_id, text, updated_at)
           VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)})
           ON CONFLICT (pass_name, variant_id) DO UPDATE SET text = EXCLUDED.text, updated_at = EXCLUDED.updated_at`,
          [passName, revisionId, text, now()]
        );
      },

      async listGlobalPromptVariants() {
        const { rows } = await driver.query(
          `SELECT * FROM ${tbl('prompt_variants')} ORDER BY updated_at DESC`, []
        );
        return rows;
      },
    },

    repo: {
      async upsertRepo(profile, repoName) {
        const fingerprint = profile?.repoFingerprint;
        if (!fingerprint) return null;
        // Check existing first
        const { rows } = await driver.query(
          `SELECT repo_id FROM ${tbl('repos')} WHERE fingerprint = ${ph(1)}`, [fingerprint]
        );
        if (rows.length) return rows[0].repo_id;
        // Insert new
        const repoId = fingerprint.slice(0, 32);
        await driver.exec(
          `INSERT INTO ${tbl('repos')} (repo_id, fingerprint, name, profile_json, created_at, updated_at)
           VALUES (${ph(1)}, ${ph(2)}, ${ph(3)}, ${ph(4)}, ${ph(5)}, ${ph(6)})
           ON CONFLICT (fingerprint) DO UPDATE SET name = EXCLUDED.name, profile_json = EXCLUDED.profile_json, updated_at = EXCLUDED.updated_at`,
          [repoId, fingerprint, repoName || '', JSON.stringify(profile), now(), now()]
        );
        return repoId;
      },

      async getRepoByFingerprint(fingerprint) {
        const { rows } = await driver.query(
          `SELECT repo_id, fingerprint FROM ${tbl('repos')} WHERE fingerprint = ${ph(1)}`, [fingerprint]
        );
        return rows.length ? { id: rows[0].repo_id, fingerprint: rows[0].fingerprint } : null;
      },
    },
  };
}

// Need crypto for UUID generation
import crypto from 'node:crypto';

export { SCHEMA_VERSION };
