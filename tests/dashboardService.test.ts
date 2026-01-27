/**
 * DashboardService tests (production-driven)
 * Exercise private filter injection via the public createDashboard API.
 */

import { vi } from 'vitest';

vi.mock('obsidian', async () => await import('./mocks/obsidian'));

import { App, TFolder, TFile, clearMockNotices, mockNotices } from './mocks/obsidian';
import { DashboardService } from '../src/services/dashboardService';

interface Template {
    name: string;
    description: string;
    fileName: string;
    category: 'default' | 'persona';
    content: string;
}

describe('DashboardService', () => {
    let app: App;
    let createdPath = '';
    let createdContent = '';

    function setupService(templateContent: string, folderPath: string, fileName = 'template.base') {
        app = new App();
        createdPath = '';
        createdContent = '';
        clearMockNotices();

        const folder = new TFolder(folderPath);

        const template: Template = {
            name: 'Test Template',
            description: 'Test',
            fileName,
            category: 'default',
            content: templateContent
        };

        app.vault.getAbstractFileByPath = (path: string) => null;
        app.vault.create = async (path: string, content: string) => {
            createdPath = path;
            createdContent = content;
            return new TFile(path);
        };

        const plugin = {
            configService: {
                getBasesTemplateByName: vi.fn().mockResolvedValue(template)
            },
            basesService: {
                isBasesEnabled: vi.fn().mockReturnValue(false)
            }
        } as any;

        const service = new DashboardService(app as any, plugin);
        return { service, folder, plugin };
    }

    describe('Folder Filter Injection (via createDashboard)', () => {
        it('skips filter injection for root folder', async () => {
            const template = `---\nname: Test\ncolumns:\n  - file.name`;
            const { service, folder } = setupService(template, '/');

            const success = await service.createDashboard({ template: 'Test Template', folder });

            expect(success).toBe(true);
            expect(createdContent).toBe(template);
        });

        it('combines with existing simple filters using AND', async () => {
            const template = `---\nname: Test\nfilters: 'file.extension = "md"'\ncolumns:\n  - file.name`;
            const { service, folder } = setupService(template, 'Projects/Alpha');

            await service.createDashboard({ template: 'Test Template', folder });

            expect(createdContent).toContain('file.inFolder("Projects/Alpha")');
            expect(createdContent).toContain('file.extension = "md"');
            expect(createdContent).toContain('and:');
        });

        it('inserts folder filter into structured and: filters', async () => {
            const template = `---\nname: Test\nfilters:\n  and:\n    - 'status = "active"'\n    - 'priority > 0'\ncolumns:\n  - file.name`;
            const { service, folder } = setupService(template, 'Tasks');

            await service.createDashboard({ template: 'Test Template', folder });

            const folderIndex = createdContent.indexOf('file.inFolder("Tasks")');
            const statusIndex = createdContent.indexOf('status = "active"');
            expect(folderIndex).toBeGreaterThan(-1);
            expect(folderIndex).toBeLessThan(statusIndex);
        });

        it('adds filters when none exist', async () => {
            const template = `---\nname: Test\ncolumns:\n  - file.name`;
            const { service, folder } = setupService(template, 'Documents');

            await service.createDashboard({ template: 'Test Template', folder });

            expect(createdContent).toContain(`filters: 'file.inFolder("Documents")'`);
            expect(createdContent.indexOf('filters:')).toBeLessThan(createdContent.indexOf('columns:'));
        });

        it('escapes quotes in folder paths', async () => {
            const template = `---\nname: Test\ncolumns:\n  - file.name`;
            const { service, folder } = setupService(template, 'Folder "With" Quotes');

            await service.createDashboard({ template: 'Test Template', folder });

            expect(createdContent).toContain('Folder \\\"With\\\" Quotes');
        });
    });

    describe('File Naming Behavior', () => {
        it('adds .base extension when missing', async () => {
            const template = `---\nname: Test\ncolumns:\n  - file.name`;
            const { service, folder } = setupService(template, 'Dashboards', 'template');

            await service.createDashboard({ template: 'Test Template', folder });

            expect(createdPath.endsWith('.base')).toBe(true);
        });

        it('does not duplicate .base extension', async () => {
            const template = `---\nname: Test\ncolumns:\n  - file.name`;
            const { service, folder } = setupService(template, 'Dashboards', 'template.base');

            await service.createDashboard({ template: 'Test Template', folder });

            const baseCount = (createdPath.match(/\.base/g) || []).length;
            expect(baseCount).toBe(1);
        });

        it('appends .base for uppercase extensions (documented behavior)', async () => {
            const template = `---\nname: Test\ncolumns:\n  - file.name`;
            const { service, folder } = setupService(template, 'Dashboards', 'template.BASE');

            await service.createDashboard({ template: 'Test Template', folder });

            expect(createdPath.endsWith('template.BASE.base')).toBe(true);
        });
    });

    describe('Existing file handling', () => {
        it('returns false when dashboard already exists', async () => {
            const template = `---\nname: Test\ncolumns:\n  - file.name`;
            const { service, folder } = setupService(template, 'Dashboards');
            const expectedPath = `${folder.path}/template.base`;

            app.vault.getAbstractFileByPath = (path: string) =>
                path === expectedPath ? new TFile(path) : null;

            const success = await service.createDashboard({ template: 'Test Template', folder });

            expect(success).toBe(false);
            expect(mockNotices.length).toBeGreaterThan(0);
        });
    });
});
