/**
 * Tests for ProjectService tree structure, groups, and nesting
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectService, MAX_PROJECT_DEPTH } from '../src/services/chat/projectService';
import { createTFile, createTFolder, TFile, TFolder } from './mocks/obsidian';

function makeSettings(chatRootFolder = 'AI Chat') {
    return { chatRootFolder, outputRootFolder: '', pluginFolder: 'AI-Organiser' } as any;
}

/** Vault mock with hierarchical folder support. */
function makeApp() {
    const files: Record<string, string> = {};
    const folderMap = new Map<string, TFolder>();

    /** Get or create a TFolder at the given path, wiring parent/child links. */
    function ensureFolder(path: string): TFolder {
        if (folderMap.has(path)) return folderMap.get(path)!;
        const f = createTFolder(path);
        folderMap.set(path, f);

        // Wire parent
        const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
        if (parentPath) {
            const parent = ensureFolder(parentPath);
            if (!parent.children.includes(f)) parent.children.push(f);
            f.parent = parent;
        }
        return f;
    }

    /** Register a file in the mock vault, creating ancestor folders. */
    function addFile(path: string, content: string): TFile {
        files[path] = content;
        const tf = createTFile(path);
        const parentPath = path.slice(0, path.lastIndexOf('/'));
        if (parentPath) {
            const parent = ensureFolder(parentPath);
            // Avoid duplicates
            if (!parent.children.some(c => c instanceof TFile && c.path === path)) {
                parent.children.push(tf);
            }
        }
        return tf;
    }

    function addFolder(path: string): TFolder {
        return ensureFolder(path);
    }

    const app = {
        vault: {
            getAbstractFileByPath: (path: string) => {
                if (path in files) return createTFile(path);
                if (folderMap.has(path)) return folderMap.get(path)!;
                return null;
            },
            getFolderByPath: (path: string) => folderMap.get(path) ?? null,
            read: async (file: { path: string }) => files[file.path] ?? '',
            modify: async (file: { path: string }, content: string) => { files[file.path] = content; },
            create: async (path: string, content: string) => {
                addFile(path, content);
                return createTFile(path);
            },
            createFolder: async (path: string) => { ensureFolder(path); },
            rename: async (file: { path: string }, newPath: string) => {
                // Simple rename for folders: update all files under old path
                const oldPath = file.path;
                const keysToMove = Object.keys(files).filter(k => k.startsWith(oldPath + '/'));
                for (const key of keysToMove) {
                    const newKey = newPath + key.slice(oldPath.length);
                    files[newKey] = files[key];
                    delete files[key];
                }
                // Update folder map
                const folder = folderMap.get(oldPath);
                if (folder) {
                    folderMap.delete(oldPath);
                    folder.path = newPath;
                    folder.name = newPath.split('/').pop() ?? '';
                    folderMap.set(newPath, folder);
                }
            },
        },
        metadataCache: {
            getFirstLinkpathDest: () => null,
        },
        fileManager: {
            trashFile: async () => {},
        },
        _addFile: addFile,
        _addFolder: addFolder,
        _files: files,
    } as any;

    return app;
}

function projectMd(id: string, name: string): string {
    return [
        '---',
        'tags:',
        '  - ai-project',
        `project_id: "${id}"`,
        `created: 2024-01-01`,
        '---',
        '',
        `# ${name}`,
        '',
        '## Instructions',
        '',
        '_No instructions configured._',
        '',
        '## Memory',
        '',
        '_No memories yet._',
        '',
        '## Pinned Files',
        '',
    ].join('\n');
}

// getChatRootFullPath with outputRootFolder='' falls back to pluginFolder 'AI-Organiser'
// so the full path is 'AI-Organiser/AI Chat/Projects'
const PROJECTS_ROOT = 'AI-Organiser/AI Chat/Projects';

describe('ProjectService tree', () => {
    let settings: any;

    beforeEach(() => {
        settings = makeSettings();
    });

    // ── listProjectTree ────────────────────────────────────────────

    describe('listProjectTree', () => {
        it('returns empty array for empty Projects folder', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            const svc = new ProjectService(app, settings);

            const result = await svc.listProjectTree();
            expect(result.ok).toBe(true);
            if (result.ok) expect(result.value).toEqual([]);
        });

        it('returns empty array when Projects folder does not exist', async () => {
            const app = makeApp();
            const svc = new ProjectService(app, settings);

            const result = await svc.listProjectTree();
            expect(result.ok).toBe(true);
            if (result.ok) expect(result.value).toEqual([]);
        });

        it('lists flat projects at root level', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            app._addFolder(`${PROJECTS_ROOT}/alpha`);
            app._addFile(`${PROJECTS_ROOT}/alpha/_project.md`, projectMd('id-a', 'Alpha'));
            app._addFolder(`${PROJECTS_ROOT}/beta`);
            app._addFile(`${PROJECTS_ROOT}/beta/_project.md`, projectMd('id-b', 'Beta'));

            const svc = new ProjectService(app, settings);
            const result = await svc.listProjectTree();
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            expect(result.value).toHaveLength(2);
            expect(result.value[0].type).toBe('project');
            expect(result.value[0].name).toBe('Alpha');
            expect(result.value[0].project?.id).toBe('id-a');
            expect(result.value[1].name).toBe('Beta');
        });

        it('builds nested tree: group > project', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            app._addFolder(`${PROJECTS_ROOT}/work`);
            app._addFolder(`${PROJECTS_ROOT}/work/my-project`);
            app._addFile(`${PROJECTS_ROOT}/work/my-project/_project.md`, projectMd('id-wp', 'My Project'));

            const svc = new ProjectService(app, settings);
            const result = await svc.listProjectTree();
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            expect(result.value).toHaveLength(1);
            const group = result.value[0];
            expect(group.type).toBe('group');
            expect(group.name).toBe('work');
            expect(group.children).toHaveLength(1);
            expect(group.children[0].type).toBe('project');
            expect(group.children[0].name).toBe('My Project');
            expect(group.children[0].depth).toBe(2);
        });

        it('sorts groups before projects, alphabetically within', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            // A group named "aaa-group"
            app._addFolder(`${PROJECTS_ROOT}/aaa-group`);
            // A project named "bbb-project"
            app._addFolder(`${PROJECTS_ROOT}/bbb-project`);
            app._addFile(`${PROJECTS_ROOT}/bbb-project/_project.md`, projectMd('id-b', 'BBB'));
            // A project named "aaa-project"
            app._addFolder(`${PROJECTS_ROOT}/aaa-project`);
            app._addFile(`${PROJECTS_ROOT}/aaa-project/_project.md`, projectMd('id-a', 'AAA'));

            const svc = new ProjectService(app, settings);
            const result = await svc.listProjectTree();
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            expect(result.value).toHaveLength(3);
            expect(result.value[0].type).toBe('group');
            expect(result.value[0].name).toBe('aaa-group');
            expect(result.value[1].type).toBe('project');
            expect(result.value[1].name).toBe('AAA');
            expect(result.value[2].type).toBe('project');
            expect(result.value[2].name).toBe('BBB');
        });

        it('ignores folders deeper than MAX_PROJECT_DEPTH', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            // Build nesting 4 levels deep (depth 1, 2, 3, 4)
            app._addFolder(`${PROJECTS_ROOT}/l1`);
            app._addFolder(`${PROJECTS_ROOT}/l1/l2`);
            app._addFolder(`${PROJECTS_ROOT}/l1/l2/l3`);
            app._addFile(`${PROJECTS_ROOT}/l1/l2/l3/_project.md`, projectMd('id-deep', 'Deep'));
            // l1/l2/l3/l4 should be ignored (depth 4 > MAX_PROJECT_DEPTH=3)
            app._addFolder(`${PROJECTS_ROOT}/l1/l2/l3/l4`);
            app._addFile(`${PROJECTS_ROOT}/l1/l2/l3/l4/_project.md`, projectMd('id-too-deep', 'Too Deep'));

            const svc = new ProjectService(app, settings);
            const result = await svc.listProjectTree();
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            // l3 project should be at depth 3 (within limit)
            const l1 = result.value[0];
            expect(l1.type).toBe('group');
            const l2 = l1.children[0];
            expect(l2.type).toBe('group');
            const l3 = l2.children[0];
            expect(l3.type).toBe('project');
            expect(l3.name).toBe('Deep');
            expect(l3.depth).toBe(3);

            // No l4 child should appear
            expect(l3.children).toHaveLength(0);
        });
    });

    // ── createGroup ────────────────────────────────────────────────

    describe('createGroup', () => {
        it('creates folder without _project.md', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            const svc = new ProjectService(app, settings);

            const result = await svc.createGroup('Work');
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            expect(result.value).toBe(`${PROJECTS_ROOT}/Work`);
            // Should NOT have _project.md
            expect(app._files[`${PROJECTS_ROOT}/Work/_project.md`]).toBeUndefined();
        });

        it('rejects duplicate sibling name (case-insensitive)', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            app._addFolder(`${PROJECTS_ROOT}/work`);

            const svc = new ProjectService(app, settings);
            const result = await svc.createGroup('Work');
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toContain('already exists');
        });

        it('rejects depth exceeding MAX_PROJECT_DEPTH', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            app._addFolder(`${PROJECTS_ROOT}/l1`);
            app._addFolder(`${PROJECTS_ROOT}/l1/l2`);
            app._addFolder(`${PROJECTS_ROOT}/l1/l2/l3`);

            const svc = new ProjectService(app, settings);
            // l1/l2/l3/l4 would be depth 4
            const result = await svc.createGroup('l4', `${PROJECTS_ROOT}/l1/l2/l3`);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toContain('depth');
        });

        it('rejects empty name', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            const svc = new ProjectService(app, settings);

            const result = await svc.createGroup('  ');
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toContain('empty');
        });
    });

    // ── createProjectInGroup ───────────────────────────────────────

    describe('createProjectInGroup', () => {
        it('creates project with _project.md under parent', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            app._addFolder(`${PROJECTS_ROOT}/work`);

            const svc = new ProjectService(app, settings);
            const result = await svc.createProjectInGroup('My Task', `${PROJECTS_ROOT}/work`);
            expect(result.ok).toBe(true);
            if (!result.ok) return;

            // result.value is the UUID
            expect(result.value).toBeTruthy();
            // _project.md should exist
            const mdPath = `${PROJECTS_ROOT}/work/My-Task/_project.md`;
            expect(app._files[mdPath]).toBeDefined();
            expect(app._files[mdPath]).toContain('# My Task');
            expect(app._files[mdPath]).toContain('project_id:');
        });

        it('rejects depth exceeding limit', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            app._addFolder(`${PROJECTS_ROOT}/l1`);
            app._addFolder(`${PROJECTS_ROOT}/l1/l2`);
            app._addFolder(`${PROJECTS_ROOT}/l1/l2/l3`);

            const svc = new ProjectService(app, settings);
            // l1/l2/l3/project would be depth 4
            const result = await svc.createProjectInGroup('Deep', `${PROJECTS_ROOT}/l1/l2/l3`);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toContain('depth');
        });

        it('rejects sibling collision', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            app._addFolder(`${PROJECTS_ROOT}/existing`);

            const svc = new ProjectService(app, settings);
            const result = await svc.createProjectInGroup('Existing', PROJECTS_ROOT);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toContain('already exists');
        });
    });

    // ── moveProject ────────────────────────────────────────────────

    describe('moveProject', () => {
        it('moves project to new parent', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            app._addFolder(`${PROJECTS_ROOT}/alpha`);
            app._addFile(`${PROJECTS_ROOT}/alpha/_project.md`, projectMd('id-a', 'Alpha'));
            app._addFolder(`${PROJECTS_ROOT}/target-group`);

            const svc = new ProjectService(app, settings);
            const result = await svc.moveProject('id-a', `${PROJECTS_ROOT}/target-group`);
            expect(result.ok).toBe(true);

            // Old path should be gone from folder map, new path should exist
            const newMdPath = `${PROJECTS_ROOT}/target-group/alpha/_project.md`;
            expect(app._files[newMdPath]).toBeDefined();
            expect(app._files[newMdPath]).toContain('# Alpha');
        });

        it('rejects circular nesting (move into own subtree)', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            app._addFolder(`${PROJECTS_ROOT}/parent`);
            app._addFile(`${PROJECTS_ROOT}/parent/_project.md`, projectMd('id-p', 'Parent'));

            const svc = new ProjectService(app, settings);
            // Try to move parent into parent (self)
            const result = await svc.moveProject('id-p', `${PROJECTS_ROOT}/parent`);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toContain('own subtree');
        });

        it('rejects depth violation after move', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);
            app._addFolder(`${PROJECTS_ROOT}/proj`);
            app._addFile(`${PROJECTS_ROOT}/proj/_project.md`, projectMd('id-p', 'Proj'));
            // Deep target: l1/l2/l3 — moving proj here would be depth 4
            app._addFolder(`${PROJECTS_ROOT}/l1`);
            app._addFolder(`${PROJECTS_ROOT}/l1/l2`);
            app._addFolder(`${PROJECTS_ROOT}/l1/l2/l3`);

            const svc = new ProjectService(app, settings);
            const result = await svc.moveProject('id-p', `${PROJECTS_ROOT}/l1/l2/l3`);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toContain('depth');
        });

        it('returns error for non-existent project', async () => {
            const app = makeApp();
            app._addFolder(PROJECTS_ROOT);

            const svc = new ProjectService(app, settings);
            const result = await svc.moveProject('nonexistent-id', PROJECTS_ROOT);
            expect(result.ok).toBe(false);
            if (!result.ok) expect(result.error).toContain('not found');
        });
    });
});
