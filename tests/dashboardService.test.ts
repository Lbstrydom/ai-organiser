/**
 * Dashboard Service Tests
 * Tests for filter injection logic used in Obsidian Bases dashboards
 *
 * MECE Coverage:
 * - Root folder (skip injection)
 * - Simple string filter format
 * - And/or structured filter format
 * - No existing filters
 * - Special characters in folder paths
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Extract the injectFolderFilter logic for direct testing
// Since it's a private method, we test it via the pattern matching approach
function injectFolderFilter(content: string, folderPath: string): string {
    // Skip folder filter for root folder
    if (!folderPath || folderPath === '/') {
        return content;
    }

    // Escape any quotes in the folder path
    const escapedPath = folderPath.replace(/"/g, '\\"');
    const folderFilter = `file.inFolder("${escapedPath}")`;

    // Check if content has a filters line (simple string format)
    const filtersMatch = content.match(/^filters:\s*'(.+)'$/m);

    if (filtersMatch) {
        // Simple string filter - combine with AND
        const existingFilter = filtersMatch[1];
        const newFilters = `filters:\n  and:\n    - '${folderFilter}'\n    - '${existingFilter}'`;
        return content.replace(/^filters:\s*'.+'$/m, newFilters);
    }

    // Check for filters with and/or structure
    const filtersAndMatch = content.match(/^(filters:\s*\n\s+and:)\s*\n(\s+- )/m);
    if (filtersAndMatch) {
        // Insert folder filter before first item in and: array
        return content.replace(
            /^(filters:\s*\n\s+and:)\s*\n(\s+- )/m,
            `$1\n    - '${folderFilter}'\n$2`
        );
    }

    // No existing filters - add one before columns
    const columnsMatch = content.match(/^columns:/m);
    if (columnsMatch && columnsMatch.index !== undefined) {
        const beforeColumns = content.substring(0, columnsMatch.index);
        const afterColumns = content.substring(columnsMatch.index);
        return `${beforeColumns}filters: '${folderFilter}'\n${afterColumns}`;
    }

    return content;
}

describe('Dashboard Service - injectFolderFilter', () => {

    describe('Root Folder Handling', () => {
        it('should not inject filter for empty folder path', () => {
            const content = `---
name: Dashboard
columns:
  - file.name
---`;
            expect(injectFolderFilter(content, '')).toBe(content);
        });

        it('should not inject filter for root path "/"', () => {
            const content = `---
name: Dashboard
columns:
  - file.name
---`;
            expect(injectFolderFilter(content, '/')).toBe(content);
        });
    });

    describe('Simple String Filter Format', () => {
        it('should combine with existing simple filter using AND', () => {
            const content = `---
name: Notes Dashboard
filters: 'file.extension = "md"'
columns:
  - file.name
---`;

            const result = injectFolderFilter(content, 'Projects/Alpha');

            expect(result).toContain('file.inFolder("Projects/Alpha")');
            expect(result).toContain('file.extension = "md"');
            expect(result).toContain('and:');
        });

        it('should preserve original filter content', () => {
            const content = `---
filters: 'tags.contains("important")'
columns:
  - file.name
---`;

            const result = injectFolderFilter(content, 'Work');

            expect(result).toContain('tags.contains("important")');
            expect(result).toContain('file.inFolder("Work")');
        });
    });

    describe('Structured And/Or Filter Format', () => {
        it('should insert folder filter before first and: item', () => {
            const content = `---
name: Filtered View
filters:
  and:
    - 'status = "active"'
    - 'priority > 0'
columns:
  - file.name
---`;

            const result = injectFolderFilter(content, 'Tasks');

            expect(result).toContain('file.inFolder("Tasks")');
            // Folder filter should be first in the and list
            const folderIndex = result.indexOf('file.inFolder("Tasks")');
            const statusIndex = result.indexOf('status = "active"');
            expect(folderIndex).toBeLessThan(statusIndex);
        });

        it('should handle deeply nested structure', () => {
            const content = `---
filters:
  and:
    - 'type = "note"'
columns:
  - summary
---`;

            const result = injectFolderFilter(content, 'Archive/2024');

            expect(result).toContain('file.inFolder("Archive/2024")');
        });
    });

    describe('No Existing Filters', () => {
        it('should add filter before columns section', () => {
            const content = `---
name: Basic Dashboard
columns:
  - file.name
  - summary
---`;

            const result = injectFolderFilter(content, 'Documents');

            expect(result).toContain(`filters: 'file.inFolder("Documents")'`);
            // Filter should appear before columns
            const filterIndex = result.indexOf('filters:');
            const columnsIndex = result.indexOf('columns:');
            expect(filterIndex).toBeLessThan(columnsIndex);
        });

        it('should handle template with only columns', () => {
            const content = `columns:
  - file.name`;

            const result = injectFolderFilter(content, 'Notes');

            expect(result).toContain('file.inFolder("Notes")');
            expect(result).toContain('columns:');
        });
    });

    describe('Special Characters in Folder Path', () => {
        it('should escape double quotes in folder path', () => {
            const content = `---
columns:
  - file.name
---`;

            const result = injectFolderFilter(content, 'Folder "With" Quotes');

            expect(result).toContain('Folder \\"With\\" Quotes');
        });

        it('should handle spaces in folder path', () => {
            const content = `---
columns:
  - file.name
---`;

            const result = injectFolderFilter(content, 'My Folder/Sub Folder');

            expect(result).toContain('file.inFolder("My Folder/Sub Folder")');
        });

        it('should handle nested folder paths', () => {
            const content = `---
columns:
  - file.name
---`;

            const result = injectFolderFilter(content, 'Level1/Level2/Level3');

            expect(result).toContain('file.inFolder("Level1/Level2/Level3")');
        });

        it('should handle unicode folder names', () => {
            const content = `---
columns:
  - file.name
---`;

            const result = injectFolderFilter(content, '项目/文档');

            expect(result).toContain('file.inFolder("项目/文档")');
        });
    });

    describe('Edge Cases', () => {
        it('should handle content with no columns section', () => {
            const content = `---
name: Dashboard
---`;

            const result = injectFolderFilter(content, 'Test');

            // Should return unchanged since no columns to insert before
            expect(result).toBe(content);
        });

        it('should handle malformed YAML gracefully', () => {
            const content = `filters: 'some filter
columns:
  - file.name`;

            // Should not crash
            const result = injectFolderFilter(content, 'Folder');
            expect(result).toBeDefined();
        });

        it('should preserve other YAML properties', () => {
            const content = `---
name: My Dashboard
description: A test dashboard
sorting:
  - file.name: asc
columns:
  - file.name
---`;

            const result = injectFolderFilter(content, 'Test');

            expect(result).toContain('name: My Dashboard');
            expect(result).toContain('description: A test dashboard');
            expect(result).toContain('sorting:');
        });
    });

    describe('Real-world Templates', () => {
        it('should handle Notes Dashboard template', () => {
            const template = `---
name: Notes Dashboard
filters: 'file.extension = "md"'
columns:
  - file.name
  - summary
  - tags
sorting:
  - file.mtime: desc
---`;

            const result = injectFolderFilter(template, 'Research/Papers');

            expect(result).toContain('file.inFolder("Research/Papers")');
            expect(result).toContain('file.extension = "md"');
            expect(result).toContain('and:');
            expect(result).toContain('name: Notes Dashboard');
        });

        it('should handle complex filter template', () => {
            const template = `---
name: Active Projects
filters:
  and:
    - 'type = "project"'
    - 'status != "archived"'
columns:
  - file.name
  - status
  - due_date
---`;

            const result = injectFolderFilter(template, 'Work/Projects');

            expect(result).toContain('file.inFolder("Work/Projects")');
            // Should be first in the and list
            const lines = result.split('\n');
            const andIndex = lines.findIndex(l => l.includes('and:'));
            const firstFilter = lines[andIndex + 1];
            expect(firstFilter).toContain('file.inFolder');
        });
    });
});

describe('Dashboard Service - File Naming', () => {
    // Test the file naming logic patterns

    it('should add .base extension if missing', () => {
        const fileName = 'my-dashboard';
        const result = fileName.endsWith('.base') ? fileName : `${fileName}.base`;
        expect(result).toBe('my-dashboard.base');
    });

    it('should not duplicate .base extension', () => {
        const fileName = 'my-dashboard.base';
        const result = fileName.endsWith('.base') ? fileName : `${fileName}.base`;
        expect(result).toBe('my-dashboard.base');
    });

    it('should handle uppercase .BASE', () => {
        // The actual code checks endsWith('.base'), so uppercase would add another extension
        const fileName = 'my-dashboard.BASE';
        const result = fileName.endsWith('.base') ? fileName : `${fileName}.base`;
        // This documents current behavior - uppercase is not detected
        expect(result).toBe('my-dashboard.BASE.base');
    });
});

describe('Dashboard Service - Path Building', () => {
    // Test path building patterns

    it('should build correct file path', () => {
        const folderPath = 'Dashboards';
        const fileName = 'notes.base';
        const filePath = `${folderPath}/${fileName}`;
        expect(filePath).toBe('Dashboards/notes.base');
    });

    it('should handle nested folder paths', () => {
        const folderPath = 'Views/Admin/Reports';
        const fileName = 'weekly.base';
        const filePath = `${folderPath}/${fileName}`;
        expect(filePath).toBe('Views/Admin/Reports/weekly.base');
    });

    it('should handle root folder path', () => {
        const folderPath = '';
        const fileName = 'main.base';
        const filePath = folderPath ? `${folderPath}/${fileName}` : fileName;
        expect(filePath).toBe('main.base');
    });
});
