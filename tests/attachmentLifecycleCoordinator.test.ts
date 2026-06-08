/**
 * Attachment lifecycle coordinator tests (azure-capability-completion-v2 — C10/C12/C16,
 * Cluster A / Phase 1). Capture-order across BOTH link maps + dispatch isolation.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    AttachmentLifecycleCoordinator,
    captureAttachmentHosts,
    type AttachmentConsumer,
    type AttachmentChangeEvent,
    type MetadataLinkSource,
} from '../src/services/attachmentLifecycleCoordinator';
import { ok, err, type Result } from '../src/core/result';

const links = (resolved: Record<string, Record<string, number>>, unresolved: Record<string, Record<string, number>> = {}): MetadataLinkSource =>
    ({ resolvedLinks: resolved, unresolvedLinks: unresolved });

describe('captureAttachmentHosts (C10)', () => {
    it('finds a host via a RESOLVED link to the attachment path', () => {
        const hosts = captureAttachmentHosts(links({ 'note.md': { 'att/report.docx': 1 } }), 'att/report.docx');
        expect(hosts).toEqual(['note.md']);
    });

    it('finds a host via an UNRESOLVED link (delete moved target to unresolvedLinks before the event)', () => {
        // Obsidian frequently moves a deleted target into unresolvedLinks (by basename) BEFORE
        // the vault delete event — a resolved-only scan would orphan the host's vectors.
        const hosts = captureAttachmentHosts(links({}, { 'note.md': { 'report.docx': 1 } }), 'att/report.docx');
        expect(hosts).toEqual(['note.md']);
    });

    it('scans BOTH oldPath and newPath on rename', () => {
        const src = links({ 'a.md': { 'att/new.docx': 1 }, 'b.md': { 'att/old.docx': 1 } });
        const hosts = captureAttachmentHosts(src, 'att/new.docx', 'att/old.docx').sort();
        expect(hosts).toEqual(['a.md', 'b.md']);
    });

    it('returns ALL hosts for an attachment shared by N notes (deduped)', () => {
        const src = links({
            'one.md': { 'att/shared.docx': 1 },
            'two.md': { 'att/shared.docx': 3 },
            'three.md': { 'other.docx': 1 },
        }, { 'four.md': { 'shared.docx': 1 } });
        const hosts = captureAttachmentHosts(src, 'att/shared.docx').sort();
        expect(hosts).toEqual(['four.md', 'one.md', 'two.md']);
    });

    it('counts only markdown sources', () => {
        const src = links({ 'canvas.canvas': { 'att/x.docx': 1 }, 'real.md': { 'att/x.docx': 1 } });
        expect(captureAttachmentHosts(src, 'att/x.docx')).toEqual(['real.md']);
    });

    it('is case-insensitive on the target match', () => {
        const hosts = captureAttachmentHosts(links({ 'note.md': { 'Att/Report.DOCX': 1 } }), 'att/report.docx');
        expect(hosts).toEqual(['note.md']);
    });
});

describe('AttachmentLifecycleCoordinator.handleChange', () => {
    type OnChanged = AttachmentConsumer['onAttachmentChanged'];
    type Purge = AttachmentConsumer['purgeByAttachmentPath'];
    const consumer = (impl?: Partial<AttachmentConsumer>): AttachmentConsumer => ({
        onAttachmentChanged: impl?.onAttachmentChanged ?? (vi.fn(async () => ok(undefined)) as unknown as OnChanged),
        purgeByAttachmentPath: impl?.purgeByAttachmentPath ?? (vi.fn(async () => ok({ removed: 0 })) as unknown as Purge),
    });

    it('captures hosts once and dispatches the event to every consumer', async () => {
        const src = links({ 'host.md': { 'att/a.docx': 1 } });
        const c1 = consumer();
        const c2 = consumer();
        const coord = new AttachmentLifecycleCoordinator(() => src);
        coord.register(c1);
        coord.register(c2);
        await coord.handleChange('modify', 'att/a.docx');
        const expected: AttachmentChangeEvent = { path: 'att/a.docx', kind: 'modify', oldPath: undefined, hosts: ['host.md'] };
        expect(c1.onAttachmentChanged).toHaveBeenCalledWith(expected);
        expect(c2.onAttachmentChanged).toHaveBeenCalledWith(expected);
    });

    it('isolates a throwing/erroring consumer — the other still runs', async () => {
        const throwing = consumer({ onAttachmentChanged: vi.fn(async () => { throw new Error('boom'); }) });
        const erroring = consumer({ onAttachmentChanged: vi.fn(async () => err<void>('nope')) });
        const healthy = consumer();
        const coord = new AttachmentLifecycleCoordinator(() => links({}));
        coord.register(throwing);
        coord.register(erroring);
        coord.register(healthy);
        await expect(coord.handleChange('delete', 'att/x.docx')).resolves.toBeUndefined();
        expect(healthy.onAttachmentChanged).toHaveBeenCalledTimes(1);
    });

    it('passes oldPath through on rename', async () => {
        const c = consumer();
        const coord = new AttachmentLifecycleCoordinator(() => links({ 'h.md': { 'att/new.docx': 1 } }));
        coord.register(c);
        await coord.handleChange('rename', 'att/new.docx', 'att/old.docx');
        expect(c.onAttachmentChanged).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rename', oldPath: 'att/old.docx', hosts: ['h.md'] }));
    });

    it('hasConsumers reflects registration', () => {
        const coord = new AttachmentLifecycleCoordinator(() => links({}));
        expect(coord.hasConsumers).toBe(false);
        coord.register(consumer());
        expect(coord.hasConsumers).toBe(true);
    });
});
