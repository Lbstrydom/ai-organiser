import { describe, it, expect } from 'vitest';
import { SectionRegistryController } from '../src/services/minutes/sectionRegistryController';

describe('SectionRegistryController', () => {
    it('starts empty with no topics', () => {
        const r = new SectionRegistryController();
        expect(r.hasTopics()).toBe(false);
        expect(r.listTopics()).toEqual([]);
    });

    it('adds a topic with trimmed name', () => {
        const r = new SectionRegistryController();
        const res = r.addTopic('  VAT presentation  ');
        expect(res.ok).toBe(true);
        if (res.ok) expect(res.value.name).toBe('VAT presentation');
        expect(r.hasTopics()).toBe(true);
        expect(r.listTopics()).toHaveLength(1);
    });

    it('rejects empty name', () => {
        const r = new SectionRegistryController();
        const res = r.addTopic('   ');
        expect(res.ok).toBe(false);
    });

    it('rejects names over 40 chars', () => {
        const r = new SectionRegistryController();
        const long = 'a'.repeat(41);
        const res = r.addTopic(long);
        expect(res.ok).toBe(false);
    });

    it('disambiguates duplicates with (2), (3)', () => {
        const r = new SectionRegistryController();
        r.addTopic('Sales');
        const r2 = r.addTopic('Sales');
        const r3 = r.addTopic('Sales');
        expect(r2.ok && r2.value.name).toBe('Sales (2)');
        expect(r3.ok && r3.value.name).toBe('Sales (3)');
    });

    it('cannot remove general', () => {
        const r = new SectionRegistryController();
        const res = r.removeTopic('general');
        expect(res.ok).toBe(false);
    });

    it('removes an existing topic by id', () => {
        const r = new SectionRegistryController();
        const add = r.addTopic('Topic');
        if (!add.ok) throw new Error('add failed');
        const rem = r.removeTopic(add.value.id);
        expect(rem.ok).toBe(true);
        expect(r.hasTopics()).toBe(false);
    });

    it('resolveSection falls back to general for unknown id', () => {
        const r = new SectionRegistryController();
        const resolved = r.resolveSection('nonexistent');
        expect(resolved.id).toBe('general');
    });

    it('resolveSection returns topic for known id', () => {
        const r = new SectionRegistryController();
        const add = r.addTopic('Budget');
        if (!add.ok) throw new Error('add failed');
        const resolved = r.resolveSection(add.value.id);
        expect(resolved.id).toBe(add.value.id);
        expect(resolved.name).toBe('Budget');
    });

    it('pruneEmptyTopics removes topics with zero assignments', () => {
        const r = new SectionRegistryController();
        const a = r.addTopic('A');
        const b = r.addTopic('B');
        if (!a.ok || !b.ok) throw new Error('add failed');
        // A has 2, B has 0
        const counts = new Map<string, number>([[a.value.id, 2], [b.value.id, 0]]);
        const removed = r.pruneEmptyTopics((id) => counts.get(id) ?? 0);
        expect(removed).toEqual([b.value.id]);
        expect(r.listTopics()).toHaveLength(1);
    });

    it('displayLabel truncates names over 20 chars', () => {
        const long = 'a'.repeat(25);
        const label = SectionRegistryController.displayLabel(long);
        expect(label).toHaveLength(20);
        expect(label.endsWith('…')).toBe(true);
    });

    it('displayLabel passes short names through unchanged', () => {
        expect(SectionRegistryController.displayLabel('Short')).toBe('Short');
    });
});
