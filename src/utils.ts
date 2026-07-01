// ============================================================
// Utility Functions
// ============================================================

import * as crypto from "crypto";
import * as path from "path";
import { FileCategory } from "./types";
import { TEXT_EXTENSIONS, BINARY_EXTENSIONS, HASH_SIZE_LIMIT_BYTES } from "./constants";

// ============================================================
// File Hashing
// ============================================================

/**
 * Compute the SHA-256 hex digest of a file asynchronously.
 * For files larger than HASH_SIZE_LIMIT_BYTES (5 MB), returns an empty string
 * as a performance safeguard (large files use mtime-based comparison instead).
 */
export async function computeFileHash(filePath: string): Promise<string> {
  try {
    const { access, constants: fsConstants } = await import("fs/promises");
    await access(filePath, fsConstants.R_OK);
  } catch {
    return "";
  }

  try {
    const { stat } = await import("fs/promises");
    const fileStat = await stat(filePath);
    if (fileStat.size > HASH_SIZE_LIMIT_BYTES) {
      return "";
    }
  } catch {
    return "";
  }

  try {
    const { createReadStream } = await import("fs");
    return new Promise<string>((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk: string | Buffer) => {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        hash.update(buf);
      });
      stream.on("end", () => {
        resolve(hash.digest("hex"));
      });
      stream.on("error", (err: Error) => {
        reject(err);
      });
    });
  } catch {
    return "";
  }
}

// ============================================================
// File Classification
// ============================================================

/**
 * Classify a file as TEXT or BINARY based on its extension.
 * Falls back to BINARY if the extension is not recognized.
 */
export function classifyFile(filePath: string): FileCategory {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) {
    return FileCategory.TEXT;
  }
  if (BINARY_EXTENSIONS.has(ext)) {
    return FileCategory.BINARY;
  }
  // Unknown extension — default to TEXT for maximum compatibility
  return FileCategory.TEXT;
}

// ============================================================
// Path Normalization
// ============================================================

/**
 * Normalize a file path to use forward slashes consistently.
 * Replaces all backslashes with forward slashes and collapses
 * redundant separators.
 */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

// ============================================================
// Time Formatting
// ============================================================

/**
 * Format a Unix timestamp (ms) into a human-readable ISO-like string.
 * Example: "2026-06-30 14:30:00"
 */
export function formatTime(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// ============================================================
// Device ID Generation
// ============================================================

/**
 * Generate a unique device identifier.
 * Uses crypto.randomUUID() for a globally unique ID.
 */
export function generateDeviceId(): string {
  return crypto.randomUUID();
}

// ============================================================
// CRDT Document ID Generation
// ============================================================

/**
 * Generate a deterministic CRDT document ID from a file path.
 * Uses the SHA-256 hash of the normalized relative path,
 * truncated to the first 16 hex characters for readability.
 */
export function generateDocId(filePath: string): string {
  const normalized = normalizePath(filePath);
  const hash = crypto.createHash("sha256").update(normalized).digest("hex");
  return `crdt-${hash.substring(0, 16)}`;
}

// ============================================================
// Sleep Utility (for async retry logic)
// ============================================================

/**
 * Promise-based sleep for the specified duration.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
