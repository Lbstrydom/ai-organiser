/**
 * @fileoverview Zod schemas for install infrastructure.
 * Manifest, receipt, cache, and bundle-history validation.
 */
import { z } from 'zod';

// ── Manifest Schema ─────────────────────────────────────────────────────────

export const SkillEntrySchema = z.object({
  path: z.string(),
  sha: z.string(),
  size: z.number(),
  summary: z.string(),
});

export const ManifestSchema = z.object({
  schemaVersion: z.number(),
  bundleVersion: z.string(),
  repoUrl: z.string(),
  rawUrlBase: z.string(),
  updatedAt: z.string(),
  skills: z.record(z.string(), SkillEntrySchema),
});

// ── Install Receipt Schema ──────────────────────────────────────────────────

export const ManagedFileSchema = z.object({
  path: z.string(),
  sha: z.string(),
  skill: z.string().optional(),
  blockSha: z.string().optional(),
  merged: z.boolean().optional(),
});

export const InstallReceiptSchema = z.object({
  receiptVersion: z.number(),
  bundleVersion: z.string(),
  installedAt: z.string(),
  sourceUrl: z.string(),
  surface: z.string(),
  managedFiles: z.array(ManagedFileSchema),
});

// ── Update Cache Schema ─────────────────────────────────────────────────────

export const UpdateCacheSchema = z.object({
  fetchedAt: z.string(),
  manifest: ManifestSchema,
});

// ── Bundle History Schema ───────────────────────────────────────────────────

export const BundleHistoryEntrySchema = z.object({
  sha: z.string(),
  ts: z.string(),
  commit: z.string(),
});

export const BundleHistorySchema = z.record(z.string(), BundleHistoryEntrySchema);
