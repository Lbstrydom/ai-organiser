/**
 * Obsidian + Playwright driver.
 *
 * Shared helpers for launching Obsidian with a CDP port, attaching Playwright,
 * waiting for plugin readiness, running commands directly through Obsidian's
 * internal API, and capturing screenshots.
 *
 * Detach-only by design: we never programmatically close Obsidian. Each run
 * starts fresh by checking whether Obsidian is already running and either
 * failing fast or attaching to an existing debug port.
 */

import { chromium } from '@playwright/test';
import { spawn, execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';

export const DEFAULT_OBSIDIAN_EXE = 'C:\\Program Files\\Obsidian\\Obsidian.exe';
export const DEFAULT_CDP_PORT = 9222;
export const DEFAULT_PLUGIN_ID = 'ai-organiser';
export const READY_COMMAND_ID = `${DEFAULT_PLUGIN_ID}:open-picker`;

/** Check whether any Obsidian.exe process is running (Windows only). */
export function isObsidianRunning() {
    try {
        const out = execSync('tasklist /FI "IMAGENAME eq Obsidian.exe" /FO CSV /NH', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        return out.toLowerCase().includes('obsidian.exe');
    } catch {
        return false;
    }
}

/** Wait for a TCP port to accept connections. */
export function waitForPort(port, host = '127.0.0.1', timeoutMs = 30_000) {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tryOnce = () => {
            const socket = net.connect({ port, host });
            socket.once('connect', () => { socket.end(); resolve(); });
            socket.once('error', () => {
                socket.destroy();
                if (Date.now() - started > timeoutMs) {
                    reject(new Error(`port ${port} not open within ${timeoutMs}ms`));
                } else {
                    setTimeout(tryOnce, 500);
                }
            });
        };
        tryOnce();
    });
}

/**
 * Launch Obsidian with a CDP port, or attach to an already-running instance
 * if it already exposes that port. Returns { browser, page, spawnedByUs }.
 *
 * If Obsidian is running but the port is not open, throws — user must close
 * Obsidian first so we can relaunch with the debug flag.
 */
export async function launchOrAttach(opts = {}) {
    const exe = opts.exe || process.env.OBSIDIAN_EXE || DEFAULT_OBSIDIAN_EXE;
    const port = opts.port || Number(process.env.CDP_PORT) || DEFAULT_CDP_PORT;
    const portReadyMs = opts.portReadyMs || 30_000;

    if (!existsSync(exe)) {
        throw new Error(`Obsidian.exe not found at ${exe}`);
    }

    const running = isObsidianRunning();
    let spawnedByUs = false;

    if (running) {
        // Try attaching on the assumption the user launched it with the debug port.
        try {
            await waitForPort(port, '127.0.0.1', 2_000);
        } catch {
            throw new Error(
                `Obsidian is already running but CDP port ${port} is not open. ` +
                `Close all Obsidian windows and re-run, or relaunch Obsidian with ` +
                `--remote-debugging-port=${port}.`
            );
        }
    } else {
        const child = spawn(exe, [`--remote-debugging-port=${port}`], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
        spawnedByUs = true;
        await waitForPort(port, '127.0.0.1', portReadyMs);
    }

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const page = await findMainPage(browser);
    return { browser, page, spawnedByUs };
}

/**
 * Find the page that hosts the Obsidian workspace. Obsidian's main window
 * loads app://obsidian.md/index.html; pop-out windows (settings in new window,
 * canvas-in-window) get their own pages.
 */
async function findMainPage(browser) {
    for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) {
            const url = p.url();
            if (url.startsWith('app://obsidian.md')) return p;
        }
    }
    // Fallback: first page of first context.
    const first = browser.contexts()[0]?.pages()[0];
    if (!first) throw new Error('no pages found on CDP connection');
    return first;
}

/**
 * If Obsidian lands on the vault picker (starter.html), click the requested
 * vault entry (or the first) so we end up with a real workspace page.
 * No-op if we're already on a vault.
 *
 * The starter page reloads itself into app://obsidian.md/index.html after
 * click; we wait for that transition. Playwright's `page` object follows
 * same-origin navigations automatically.
 */
export async function ensureVaultOpen(browser, page, vaultName = 'Second Brain', timeoutMs = 30_000) {
    if (!page.url().includes('starter.html')) return page;

    // Click the matching recent-vault entry. The starter page closes the old
    // window and spawns a new app://obsidian.md/index.html page, so we can't
    // wait on the starter page afterwards — the page reference becomes stale.
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        let clicked = false;
        try {
            clicked = await page.evaluate((name) => {
                const items = Array.from(
                    document.querySelectorAll('.recent-vaults-list-item')
                );
                if (items.length === 0) return false;
                let target = items[0];
                if (name) {
                    const match = items.find((el) => {
                        const nameEl = el.querySelector('.recent-vaults-list-item-name');
                        return nameEl?.textContent?.trim().toLowerCase() === name.toLowerCase();
                    });
                    if (match) target = match;
                }
                target.scrollIntoView();
                /** @type {HTMLElement} */ (target).click();
                return true;
            }, vaultName);
        } catch { /* starter page likely closed — proceed to poll for new page */ }
        if (clicked) break;
        await new Promise((r) => setTimeout(r, 500));
    }

    // Poll until a non-starter app://obsidian.md page shows up in any context.
    const pollStarted = Date.now();
    while (Date.now() - pollStarted < timeoutMs) {
        for (const ctx of browser.contexts()) {
            for (const p of ctx.pages()) {
                try {
                    const url = p.url();
                    if (url.startsWith('app://obsidian.md') && !url.includes('starter.html')) {
                        await new Promise((r) => setTimeout(r, 2_000));
                        return p;
                    }
                } catch { /* page closing */ }
            }
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('Timed out waiting for vault to open after clicking starter entry');
}

/**
 * Wait until a given plugin command is registered, which is a reliable signal
 * that (a) the workspace loaded, (b) the plugin finished enabling.
 */
export async function waitForPluginReady(page, commandId = READY_COMMAND_ID, timeoutMs = 30_000) {
    await page.waitForFunction(
        (id) => {
            const app = /** @type {any} */ (globalThis).app;
            return Boolean(app && app.commands && app.commands.commands && app.commands.commands[id]);
        },
        commandId,
        { timeout: timeoutMs, polling: 500 }
    );
}

/**
 * Run an Obsidian command by id, bypassing the command palette's fuzzy match.
 * Returns true if the command existed and was executed.
 */
export async function runCommand(page, commandId) {
    return await page.evaluate((id) => {
        const app = /** @type {any} */ (globalThis).app;
        if (!app?.commands?.commands?.[id]) return false;
        app.commands.executeCommandById(id);
        return true;
    }, commandId);
}

/** Open the AI Organiser command picker modal directly via command id. */
export async function openPluginCommandPicker(page) {
    const ok = await runCommand(page, READY_COMMAND_ID);
    if (!ok) throw new Error(`command not registered: ${READY_COMMAND_ID}`);
    // Wait for the picker modal to render. The plugin's CommandPickerModal uses
    // the default Obsidian modal chrome, so .modal is a stable selector.
    await page.waitForSelector('.modal', { timeout: 5_000 });
}

/**
 * Open the AI Organiser command picker via the ribbon icon on the left bar —
 * the real user entry point. This exercises the registered ribbon icon rather
 * than invoking the command directly, so screenshots reflect the authentic flow.
 *
 * Obsidian renders ribbon buttons as .side-dock-ribbon-action with aria-label
 * equal to the tooltip text ("AI Organiser" from main.ts).
 */
export async function openPluginCommandPickerViaRibbon(page, tooltip = 'AI organiser') {
    const locator = page.locator(`.side-dock-ribbon-action[aria-label="${tooltip}"]`);
    await locator.first().click();
    await page.waitForSelector('.modal', { timeout: 5_000 });
}

/**
 * Right-click a file in the file tree by visible name. Captures Obsidian's
 * context menu with any plugin items the plugin's `file-menu` handler added.
 */
export async function rightClickFileInTree(page, fileName) {
    const item = page.locator(`.nav-file-title-content:has-text("${fileName}")`).first();
    await item.click({ button: 'right' });
    await page.waitForSelector('.menu', { timeout: 3_000 });
}

/**
 * Right-click the current editor body. Captures the editor context menu with
 * any plugin items the plugin's `editor-menu` handler added.
 */
export async function rightClickEditor(page) {
    const body = page.locator('.cm-content').first();
    await body.click({ button: 'right' });
    await page.waitForSelector('.menu', { timeout: 3_000 });
}

/**
 * Select a word in the editor (triple-click = line, double-click = word) then
 * right-click to trigger selection-based menu items (Highlight, Ask AI,
 * Translate, Add to pending, Quick Peek).
 */
export async function rightClickEditorWithSelection(page) {
    const body = page.locator('.cm-content').first();
    await body.dblclick();
    await page.waitForTimeout(200);
    await body.click({ button: 'right' });
    await page.waitForSelector('.menu', { timeout: 3_000 });
}

/**
 * Open a specific note in the vault by its vault-relative path, via the
 * Obsidian workspace API. Useful to put the persona on a known starting note
 * before running actions.
 *
 * Example:
 *   await openVaultFile(page, 'AI-Organiser/Persona test/Test URL.md');
 */
export async function openVaultFile(page, vaultPath) {
    const ok = await page.evaluate(async (path) => {
        const app = /** @type {any} */ (globalThis).app;
        const file = app?.vault?.getAbstractFileByPath?.(path);
        if (!file) return false;
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(file);
        return true;
    }, vaultPath);
    if (!ok) throw new Error(`vault file not found: ${vaultPath}`);
    await page.waitForTimeout(400);
}

/** Read the items in the currently visible context menu. */
export async function readVisibleMenuItems(page) {
    return await page.$$eval('.menu .menu-item', (items) =>
        items.map((el) => ({
            text: el.textContent?.trim() || '',
            hasSubmenu: el.classList.contains('mod-submenu'),
        }))
    );
}

/** Open Obsidian's native command palette (Ctrl+P) and type a query. */
export async function openPaletteAndType(page, query) {
    await page.keyboard.press('Control+KeyP');
    await page.waitForSelector('.prompt-input', { timeout: 5_000 });
    if (query) await page.keyboard.type(query, { delay: 20 });
}

/** Dismiss any open modal / palette via Escape. */
export async function dismissModal(page) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
}

/**
 * Read the AI Organiser command picker's current structure directly from the
 * plugin — not via DOM scraping. Returns the category tree exactly as the
 * picker sees it, useful for documenting the UX in docs/features-overlap.md.
 *
 * Relies on the plugin's buildCommandCategories being re-derivable from its
 * settings + translations. We call through the Obsidian app reference.
 */
export async function dumpCommandPickerStructure(page) {
    return await page.evaluate(() => {
        const app = /** @type {any} */ (globalThis).app;
        const allCommands = app?.commands?.commands || {};
        const aiCommands = Object.keys(allCommands)
            .filter((id) => id.startsWith('ai-organiser:'))
            .map((id) => ({
                id,
                name: allCommands[id].name,
                icon: allCommands[id].icon || null,
            }));
        return { commandCount: aiCommands.length, commands: aiCommands };
    });
}

/** Screenshot helper that stamps paths with a timestamp. */
export function stampedName(label, stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
    return `${stamp}-${label}.png`;
}
