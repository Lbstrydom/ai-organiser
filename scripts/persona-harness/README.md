# Persona harness

Playwright drivers that run Obsidian against the real vault. Outputs go to
`sessions/` (gitignored).

## First step: back up the deployed plugin

Persona runs deploy a fresh build and change plugin settings in the live vault.
Back up first:

```bash
node scripts/persona-harness/vault-backup.mjs backup     # main.js, manifest.json, styles.css, data.json
node scripts/persona-harness/vault-backup.mjs list
node scripts/persona-harness/vault-backup.mjs restore    # newest backup, or pass a backup folder
```

Backups land in `sessions/backups/<UTC timestamp>/`. Targets come from
`deploy.local.json` (repo root or the main checkout) or `AIORG_DEPLOY_TARGETS`;
with none configured the backup is a no-op that says so. `launchOrAttach()` in
`driver.mjs` also runs the backup once per process before anything else
(`AIORG_SKIP_VAULT_BACKUP=1` opts out). Builds from a linked worktree do not
deploy at all (`AIORG_DEPLOY_FROM_WORKTREE=1` for a deliberate test deploy).
