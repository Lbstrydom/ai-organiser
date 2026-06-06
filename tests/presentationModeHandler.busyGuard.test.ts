/**
 * F4 — Polish / Check-Brand report busy (not a silent no-op) while a mutating
 * op holds the run lock, consistent with export/save (presentation-demo-fixes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/ui/modals/PolishSelectorModal', () => ({
    PolishSelectorModal: vi.fn().mockImplementation(() => ({ open: vi.fn(), close: vi.fn() })),
}));

import { PresentationModeHandler } from '../src/ui/chat/PresentationModeHandler';
import { PolishSelectorModal } from '../src/ui/modals/PolishSelectorModal';
import { App } from './mocks/obsidian';
import { coffeeDeckIr } from './fixtures/coffeeDeckIr';
import { en } from '../src/i18n/en';

const PolishModalMock = PolishSelectorModal as unknown as ReturnType<typeof vi.fn>;

function makeCtx() {
    const settings = { summaryLanguage: 'en', pluginFolder: 'AI-Organiser', configFolderPath: 'Config' };
    return { app: new App(), plugin: { t: en, settings }, fullPlugin: { t: en, settings }, options: {} } as never;
}
function makeCallbacks() {
    return { showThinking: vi.fn(), hideThinking: vi.fn(), rerenderActions: vi.fn(), notify: vi.fn() } as never;
}
function makeHandler(): PresentationModeHandler {
    const h = new PresentationModeHandler();
    Object.assign((h as unknown as { deck: Record<string, unknown> }).deck, { html: '<deck>', deckIr: coffeeDeckIr });
    Object.assign(h as unknown as Record<string, unknown>, { brandEnabled: true, brandAvailable: true });
    return h;
}
function lock(h: PresentationModeHandler) {
    (h as unknown as { run: { lock: () => void } }).run.lock();
}

beforeEach(() => PolishModalMock.mockClear());

describe('F4 busy guard', () => {
    it('handlePolish notifies + opens no modal while a mutating op is in flight', async () => {
        const h = makeHandler();
        lock(h);
        const cb = makeCallbacks();
        await (h as never as { handlePolish: (c: never, cb: never) => Promise<void> }).handlePolish(makeCtx(), cb);
        expect((cb as unknown as { notify: ReturnType<typeof vi.fn> }).notify)
            .toHaveBeenCalledWith(en.modals.unifiedChat.presentationBusy);
        expect(PolishModalMock).not.toHaveBeenCalled();
    });

    it('handleBrandAudit notifies while a mutating op is in flight', async () => {
        const h = makeHandler();
        lock(h);
        const cb = makeCallbacks();
        await (h as never as { handleBrandAudit: (c: never, cb: never) => Promise<void> }).handleBrandAudit(makeCtx(), cb);
        expect((cb as unknown as { notify: ReturnType<typeof vi.fn> }).notify)
            .toHaveBeenCalledWith(en.modals.unifiedChat.presentationBusy);
    });

    it('assertNotBusy returns true + does not notify when idle', () => {
        const h = makeHandler();
        const cb = makeCallbacks();
        const ok = (h as never as { assertNotBusy: (c: never, cb: never) => boolean }).assertNotBusy(makeCtx(), cb);
        expect(ok).toBe(true);
        expect((cb as unknown as { notify: ReturnType<typeof vi.fn> }).notify).not.toHaveBeenCalled();
    });
});
