/**
 * @fileoverview Install receipt read/write with schema validation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { InstallReceiptSchema } from '../schemas-install.mjs';

/**
 * Read and validate an install receipt.
 * @param {string} receiptPath
 * @returns {{ receipt: object|null, error: string|null }}
 */
export function readReceipt(receiptPath) {
  if (!fs.existsSync(receiptPath)) {
    return { receipt: null, error: null }; // No receipt = no install
  }
  try {
    const raw = JSON.parse(fs.readFileSync(receiptPath, 'utf-8'));
    const receipt = InstallReceiptSchema.parse(raw);
    return { receipt, error: null };
  } catch (err) {
    return { receipt: null, error: `Invalid receipt: ${err.message}` };
  }
}

/**
 * Write an install receipt atomically.
 * @param {string} receiptPath
 * @param {object} receipt - Must match InstallReceiptSchema
 */
export function writeReceipt(receiptPath, receipt) {
  InstallReceiptSchema.parse(receipt); // Validate before write
  const tmpPath = receiptPath + '.tmp.' + process.pid;
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(receipt, null, 2) + '\n');
  fs.renameSync(tmpPath, receiptPath);
}

/**
 * Build a receipt from installed files.
 * @param {object} options
 * @param {string} options.bundleVersion
 * @param {string} options.sourceUrl
 * @param {string} options.surface
 * @param {Array<{ path: string, sha: string, skill?: string, blockSha?: string, merged?: boolean }>} options.managedFiles
 * @returns {object}
 */
export function buildReceipt({ bundleVersion, sourceUrl, surface, managedFiles }) {
  return {
    receiptVersion: 1,
    bundleVersion,
    installedAt: new Date().toISOString(),
    sourceUrl,
    surface,
    managedFiles,
  };
}
