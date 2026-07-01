// ============================================================
// Path Security Validator
// ============================================================
// Provides strict validation to prevent path traversal attacks
// and ensure all file operations stay within the Obsidian vault.

import * as path from "path";

// ============================================================
// Path Traversal Detection
// ============================================================

/**
 * Check if a relative path attempts directory traversal.
 *
 * Detects:
 * - Path components containing ".." (parent directory references)
 * - Absolute paths starting with "/" or drive letters (e.g., "C:\")
 * - Paths starting with "~" (home directory references)
 *
 * @param relativePath - The relative path to check.
 * @returns true if the path contains traversal attempts.
 */
export function isPathTraversal(relativePath: string): boolean {
  if (!relativePath || typeof relativePath !== "string") {
    return true;
  }

  const normalized = relativePath.replace(/\\/g, "/");

  // Check for parent directory references
  const parts = normalized.split("/");
  for (const part of parts) {
    if (part === "..") {
      return true;
    }
  }

  // Check for absolute paths
  if (normalized.startsWith("/")) {
    return true;
  }

  // Check for Windows drive letters (e.g., C:)
  if (/^[a-zA-Z]:[/\\]/.test(relativePath)) {
    return true;
  }

  // Check for home directory reference
  if (normalized.startsWith("~")) {
    return true;
  }

  // Check for null bytes (null injection attack)
  if (normalized.includes("\0")) {
    return true;
  }

  return false;
}

// ============================================================
// Vault Path Validation
// ============================================================

/**
 * Strictly validate that a received file path resolves within the vault directory.
 *
 * Uses path.resolve() and path.relative() to verify that after resolving
 * the received path against the vault root, the result is still within
 * the vault directory.
 *
 * @param vaultPath - The absolute path to the Obsidian vault root.
 * @param receivedPath - The received relative file path to validate.
 * @returns true if the resolved path is within the vault.
 */
export function isWithinVault(vaultPath: string, receivedPath: string): boolean {
  try {
    const resolved = path.resolve(vaultPath, receivedPath);
    const relative = path.relative(vaultPath, resolved);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

// ============================================================
// Path Sanitization
// ============================================================

/**
 * Sanitize a received file path by:
 * - Converting backslashes to forward slashes
 * - Collapsing consecutive separators
 * - Removing leading slashes
 * - Removing null bytes
 *
 * @param receivedPath - The raw path received from the network.
 * @returns A cleaned, normalized path string.
 */
export function sanitizePath(receivedPath: string): string {
  if (!receivedPath || typeof receivedPath !== "string") {
    return "";
  }

  let cleaned = receivedPath;

  // Remove null bytes
  cleaned = cleaned.replace(/\0/g, "");

  // Normalize separators
  cleaned = cleaned.replace(/\\/g, "/");

  // Collapse consecutive slashes
  cleaned = cleaned.replace(/\/+/g, "/");

  // Remove leading slashes
  cleaned = cleaned.replace(/^\/*/, "");

  // Remove trailing slashes
  cleaned = cleaned.replace(/\/*$/, "");

  return cleaned;
}

// ============================================================
// Comprehensive Path Validation
// ============================================================

/**
 * Result of a comprehensive path validation.
 */
export interface ValidatePathResult {
  valid: boolean;
  safePath?: string;
  error?: string;
}

/**
 * Comprehensive path validation that combines traversal check,
 * vault containment check, and sanitization.
 *
 * @param vaultPath - The absolute path to the vault root.
 * @param receivedPath - The raw path received from the network.
 * @returns A ValidatePathResult with valid flag, safe path, and error message.
 */
export function validatePath(
  vaultPath: string,
  receivedPath: string,
): ValidatePathResult {
  // Input validation
  if (!vaultPath || typeof vaultPath !== "string") {
    return { valid: false, error: "vaultPath must be a non-empty string" };
  }
  if (!receivedPath || typeof receivedPath !== "string") {
    return { valid: false, error: "receivedPath must be a non-empty string" };
  }

  // Step 1: Check for path traversal
  if (isPathTraversal(receivedPath)) {
    return {
      valid: false,
      error: `Path traversal detected: "${receivedPath}"`,
    };
  }

  // Step 2: Sanitize the path
  const sanitized = sanitizePath(receivedPath);

  if (sanitized.length === 0) {
    return { valid: false, error: "Path is empty after sanitization" };
  }

  // Step 3: Verify vault containment
  if (!isWithinVault(vaultPath, sanitized)) {
    return {
      valid: false,
      error: `Resolved path is outside the vault: "${sanitized}"`,
    };
  }

  // Step 4: Build the safe absolute path
  const safePath = path.resolve(vaultPath, sanitized);

  return { valid: true, safePath };
}
