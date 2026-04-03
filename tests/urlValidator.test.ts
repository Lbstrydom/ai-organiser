/**
 * URL Validator Tests
 * Tests SSRF protection and URL validation
 */

import { validateUrl, isPdfUrl, extractFilenameFromUrl } from '../src/utils/urlValidator';

describe('validateUrl', () => {
  describe('valid URLs', () => {
    it('should accept valid HTTPS URLs', () => {
      const result = validateUrl('https://example.com/article');
      expect(result.valid).toBe(true);
      expect(result.url).toBe('https://example.com/article');
    });

    it('should accept valid HTTP URLs', () => {
      const result = validateUrl('http://example.com/page');
      expect(result.valid).toBe(true);
      expect(result.url).toBe('http://example.com/page');
    });

    it('should add https:// if no protocol provided', () => {
      const result = validateUrl('example.com/article');
      expect(result.valid).toBe(true);
      expect(result.url).toBe('https://example.com/article');
    });

    it('should handle URLs with query parameters', () => {
      const result = validateUrl('https://example.com/search?q=test&page=1');
      expect(result.valid).toBe(true);
      expect(result.url).toContain('q=test');
    });

    it('should handle URLs with fragments', () => {
      const result = validateUrl('https://example.com/page#section');
      expect(result.valid).toBe(true);
      expect(result.url).toContain('#section');
    });

    it('should handle URLs with ports', () => {
      const result = validateUrl('https://example.com:8080/api');
      expect(result.valid).toBe(true);
    });
  });

  describe('SSRF protection - blocked hosts', () => {
    it('should block localhost', () => {
      const result = validateUrl('http://localhost/admin');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Local');
    });

    it('should block 127.0.0.1', () => {
      const result = validateUrl('http://127.0.0.1/api');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Local');
    });

    it('should block 0.0.0.0', () => {
      const result = validateUrl('http://0.0.0.0/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Local');
    });

    it('should block IPv6 localhost', () => {
      const result = validateUrl('http://[::1]/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Local');
    });
  });

  describe('SSRF protection - private IP ranges', () => {
    it('should block 10.x.x.x private range', () => {
      const result = validateUrl('http://10.0.0.1/internal');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Private');
    });

    it('should block 172.16.x.x private range', () => {
      const result = validateUrl('http://172.16.0.1/internal');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Private');
    });

    it('should block 192.168.x.x private range', () => {
      const result = validateUrl('http://192.168.1.1/router');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Private');
    });

    it('should block 169.254.x.x link-local range', () => {
      const result = validateUrl('http://169.254.1.1/');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Private');
    });
  });

  describe('SSRF protection - special domains', () => {
    it('should block .local domains', () => {
      const result = validateUrl('http://myserver.local/api');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Local network');
    });

    it('should block .internal domains', () => {
      const result = validateUrl('http://api.internal/endpoint');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Local network');
    });
  });

  describe('invalid URLs', () => {
    it('should reject malformed URLs', () => {
      const result = validateUrl('not a valid url');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Invalid');
    });

    it('should reject file:// URLs', () => {
      // Security: file:// URLs should be rejected before any normalization
      const result = validateUrl('file:///etc/passwd');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Only HTTP and HTTPS');
    });

    it('should reject ftp:// URLs', () => {
      // Security: ftp:// URLs should be rejected before any normalization
      const result = validateUrl('ftp://ftp.example.com/file');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Only HTTP and HTTPS');
    });

    it('should reject javascript: URLs', () => {
      const result = validateUrl('javascript:alert(1)');
      expect(result.valid).toBe(false);
    });

    it('should reject data: URLs', () => {
      const result = validateUrl('data:text/html,<script>alert(1)</script>');
      expect(result.valid).toBe(false);
    });

    it('should handle empty string', () => {
      const result = validateUrl('');
      expect(result.valid).toBe(false);
    });
  });
});

describe('isPdfUrl', () => {
  it('should detect PDF URLs by extension', () => {
    expect(isPdfUrl('https://example.com/document.pdf')).toBe(true);
  });

  it('should be case insensitive', () => {
    expect(isPdfUrl('https://example.com/document.PDF')).toBe(true);
  });

  it('should return false for non-PDF URLs', () => {
    expect(isPdfUrl('https://example.com/page.html')).toBe(false);
    expect(isPdfUrl('https://example.com/article')).toBe(false);
  });

  it('should handle URLs with query parameters', () => {
    expect(isPdfUrl('https://example.com/document.pdf?token=abc')).toBe(true);
  });

  it('should return false for invalid URLs', () => {
    expect(isPdfUrl('not a url')).toBe(false);
  });
});

describe('extractFilenameFromUrl', () => {
  it('should extract filename from URL path', () => {
    expect(extractFilenameFromUrl('https://example.com/docs/report.pdf')).toBe('report.pdf');
  });

  it('should handle URL-encoded filenames', () => {
    expect(extractFilenameFromUrl('https://example.com/my%20file.pdf')).toBe('my file.pdf');
  });

  it('should return null for URLs without filename', () => {
    expect(extractFilenameFromUrl('https://example.com/')).toBe(null);
    expect(extractFilenameFromUrl('https://example.com/folder/')).toBe(null);
  });

  it('should return null for invalid URLs', () => {
    expect(extractFilenameFromUrl('not a url')).toBe(null);
  });

  it('should handle filenames with multiple dots', () => {
    expect(extractFilenameFromUrl('https://example.com/report.2024.01.pdf')).toBe('report.2024.01.pdf');
  });
});
