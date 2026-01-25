/**
 * Tag Utilities Tests
 * Tests pure functions in tagUtils that don't require Obsidian API
 */

import { TagUtils } from '../src/utils/tagUtils';

describe('TagUtils.formatTag', () => {
  describe('basic formatting', () => {
    it('should remove leading # from tags', () => {
      expect(TagUtils.formatTag('#technology')).toBe('technology');
    });

    it('should handle tags without # prefix', () => {
      expect(TagUtils.formatTag('technology')).toBe('technology');
    });

    it('should trim whitespace', () => {
      expect(TagUtils.formatTag('  technology  ')).toBe('technology');
    });

    it('should replace spaces with hyphens', () => {
      expect(TagUtils.formatTag('machine learning')).toBe('machine-learning');
    });

    it('should handle multiple spaces', () => {
      expect(TagUtils.formatTag('deep   learning')).toBe('deep-learning');
    });
  });

  describe('special character handling', () => {
    it('should replace special characters with hyphens', () => {
      expect(TagUtils.formatTag('C++')).toBe('C');
    });

    it('should preserve forward slashes for nested tags', () => {
      expect(TagUtils.formatTag('science/biology')).toBe('science/biology');
    });

    it('should handle tags with underscores', () => {
      expect(TagUtils.formatTag('machine_learning')).toBe('machine-learning');
    });

    it('should collapse multiple consecutive hyphens', () => {
      expect(TagUtils.formatTag('test--tag')).toBe('test-tag');
      expect(TagUtils.formatTag('test---tag')).toBe('test-tag');
    });

    it('should remove leading and trailing hyphens', () => {
      expect(TagUtils.formatTag('-test-')).toBe('test');
      expect(TagUtils.formatTag('--test--')).toBe('test');
    });
  });

  describe('edge cases', () => {
    it('should handle null', () => {
      expect(TagUtils.formatTag(null)).toBe('');
    });

    it('should handle undefined', () => {
      expect(TagUtils.formatTag(undefined)).toBe('');
    });

    it('should handle numbers', () => {
      expect(TagUtils.formatTag(123)).toBe('123');
    });

    it('should handle empty string', () => {
      expect(TagUtils.formatTag('')).toBe('');
    });

    it('should handle only special characters', () => {
      expect(TagUtils.formatTag('!!@@##')).toBe('');
    });
  });

  describe('unicode support', () => {
    it('should preserve Chinese characters', () => {
      expect(TagUtils.formatTag('技术')).toBe('技术');
    });

    it('should preserve Japanese characters', () => {
      expect(TagUtils.formatTag('テクノロジー')).toBe('テクノロジー');
    });

    it('should preserve accented characters', () => {
      expect(TagUtils.formatTag('café')).toBe('café');
    });

    it('should handle mixed unicode and ASCII', () => {
      expect(TagUtils.formatTag('AI技术')).toBe('AI技术');
    });
  });
});

describe('TagUtils.formatTags', () => {
  it('should format an array of tags', () => {
    const tags = ['#tech', 'science', 'machine learning'];
    const result = TagUtils.formatTags(tags);
    expect(result).toEqual(['tech', 'science', 'machine-learning']);
  });

  it('should filter out null and undefined values', () => {
    const tags = ['tech', null, 'science', undefined];
    const result = TagUtils.formatTags(tags as any);
    expect(result).toEqual(['tech', 'science']);
  });

  it('should handle empty array', () => {
    expect(TagUtils.formatTags([])).toEqual([]);
  });

  it('should handle non-array input', () => {
    expect(TagUtils.formatTags('not an array' as any)).toEqual([]);
  });

  it('should add hash prefix when keepHashPrefix is true', () => {
    const tags = ['tech', 'science'];
    const result = TagUtils.formatTags(tags, true);
    expect(result).toEqual(['#tech', '#science']);
  });
});

describe('TagUtils.getExistingTags', () => {
  it('should extract tags from frontmatter array', () => {
    const frontmatter = { tags: ['tech', 'science'] };
    expect(TagUtils.getExistingTags(frontmatter)).toEqual(['tech', 'science']);
  });

  it('should handle single tag as string', () => {
    const frontmatter = { tags: 'single-tag' };
    expect(TagUtils.getExistingTags(frontmatter)).toEqual(['single-tag']);
  });

  it('should return empty array for null frontmatter', () => {
    expect(TagUtils.getExistingTags(null)).toEqual([]);
  });

  it('should return empty array when no tags property', () => {
    const frontmatter = { title: 'Test' };
    expect(TagUtils.getExistingTags(frontmatter as any)).toEqual([]);
  });

  it('should return empty array for null tags', () => {
    const frontmatter = { tags: null };
    expect(TagUtils.getExistingTags(frontmatter)).toEqual([]);
  });

  it('should convert non-string tags to strings', () => {
    const frontmatter = { tags: [123, 'tech'] };
    const result = TagUtils.getExistingTags(frontmatter as any);
    expect(result).toEqual(['123', 'tech']);
  });

  it('should filter out null values in tag array', () => {
    const frontmatter = { tags: ['tech', null, 'science'] };
    const result = TagUtils.getExistingTags(frontmatter as any);
    expect(result).toEqual(['tech', 'science']);
  });
});

describe('TagUtils.mergeTags', () => {
  it('should merge two arrays of tags', () => {
    const existing = ['tech', 'science'];
    const newTags = ['ai', 'ml'];
    const result = TagUtils.mergeTags(existing, newTags);
    expect(result).toContain('tech');
    expect(result).toContain('ai');
    expect(result.length).toBe(4);
  });

  it('should remove duplicates', () => {
    const existing = ['tech', 'science'];
    const newTags = ['tech', 'ai'];
    const result = TagUtils.mergeTags(existing, newTags);
    expect(result.filter(t => t === 'tech').length).toBe(1);
    expect(result.length).toBe(3);
  });

  it('should sort tags alphabetically', () => {
    const existing = ['zebra', 'apple'];
    const newTags = ['mango'];
    const result = TagUtils.mergeTags(existing, newTags);
    expect(result).toEqual(['apple', 'mango', 'zebra']);
  });

  it('should handle empty arrays', () => {
    expect(TagUtils.mergeTags([], [])).toEqual([]);
    expect(TagUtils.mergeTags(['tech'], [])).toEqual(['tech']);
    expect(TagUtils.mergeTags([], ['tech'])).toEqual(['tech']);
  });
});

describe('TagUtils.isFileExcluded', () => {
  // Create a minimal mock for TAbstractFile
  const createMockFile = (path: string) => ({ path } as any);

  it('should return false for empty patterns', () => {
    const file = createMockFile('notes/test.md');
    expect(TagUtils.isFileExcluded(file, [])).toBe(false);
  });

  it('should match exact path prefix', () => {
    const file = createMockFile('attachments/image.png');
    expect(TagUtils.isFileExcluded(file, ['attachments/'])).toBe(true);
  });

  it('should be case insensitive for path matching', () => {
    const file = createMockFile('Attachments/image.png');
    expect(TagUtils.isFileExcluded(file, ['attachments/'])).toBe(true);
  });

  it('should match glob patterns with *', () => {
    const file = createMockFile('notes/draft-post.md');
    expect(TagUtils.isFileExcluded(file, ['*draft*'])).toBe(true);
  });

  it('should match glob patterns with **', () => {
    const file = createMockFile('deep/nested/folder/file.md');
    expect(TagUtils.isFileExcluded(file, ['deep/**'])).toBe(true);
  });

  it('should match regex patterns', () => {
    const file = createMockFile('notes/2024-01-15-post.md');
    expect(TagUtils.isFileExcluded(file, ['/\\d{4}-\\d{2}-\\d{2}/'])).toBe(true);
  });

  it('should return false for non-matching patterns', () => {
    const file = createMockFile('notes/my-post.md');
    expect(TagUtils.isFileExcluded(file, ['attachments/', 'templates/'])).toBe(false);
  });

  it('should handle multiple patterns', () => {
    const file = createMockFile('templates/daily.md');
    expect(TagUtils.isFileExcluded(file, ['attachments/', 'templates/'])).toBe(true);
  });
});
