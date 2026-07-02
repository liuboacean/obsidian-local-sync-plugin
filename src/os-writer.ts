// ============================================================
// OS-Compatibile File Writer
// ============================================================
// Provides platform-aware file I/O operations with path validation.
// - macOS: Uses Obsidian API (app.vault.modify) to avoid EDEADLK
// - Linux: Direct fs.promises.writeFile + chmod
// - Windows: Direct fs.promises.writeFile + file lock retry

import * as fs from "fs";
import * as path from "path";
import { validatePath } from "./path-validator";
import { EventEmitter } from "events";

// ============================================================
// Types
// ============================================================

export type Platform = "macos" | "linux" | "windows";

// ============================================================
// Platform Detection
// ============================================================

/**
 * Get the current operating system platform.
 */
export function getPlatform(): Platform {
  const platform = process.platform;
  if (platform === "darwin") {
    return "macos";
  }
  if (platform === "win32") {
    return "windows";
  }
  return "linux";
}

// ============================================================
// OS Writer Class
// ============================================================

export class OsWriter extends EventEmitter {
  private vaultPath: string = "";

  // Obsidian vault API reference (set by main.ts after initialization)
  private vaultModifyFn: ((path: string, content: string) => Promise<void>) | null = null;
  private vaultDeleteFn: ((path: string) => Promise<void>) | null = null;
  private vaultRenameFn: ((oldPath: string, newPath: string) => Promise<void>) | null = null;
  private vaultReadFn: ((path: string) => Promise<string>) | null = null;

  /** Callback to mark a path as recently pushed (avoids sync loops). */
  private markAsPushedFn: ((path: string) => void) | null = null;

  constructor() {
    super();
    this.setMaxListeners(20);
  }

  // ============================================================
  // Configuration
  // ============================================================

  /**
   * Set the vault root path.
   */
  setVaultPath(vaultPath: string): void {
    this.vaultPath = vaultPath;
  }

  /**
   * Set the Obsidian vault API functions for macOS integration.
   */
  setVaultApis(apis: {
    modify: (path: string, content: string) => Promise<void>;
    delete: (path: string) => Promise<void>;
    rename: (oldPath: string, newPath: string) => Promise<void>;
    read: (path: string) => Promise<string>;
  }): void {
    this.vaultModifyFn = apis.modify;
    this.vaultDeleteFn = apis.delete;
    this.vaultRenameFn = apis.rename;
    this.vaultReadFn = apis.read;
  }

  /**
   * Set the callback to mark a path as recently pushed.
   */
  setMarkAsPushedFn(fn: (path: string) => void): void {
    this.markAsPushedFn = fn;
  }

  // ============================================================
  // Write File
  // ============================================================

  /**
   * Write a file to the vault with platform-aware strategy.
   *
   * - macOS: Uses Obsidian vault API (app.vault.modify) to avoid EDEADLK.
   * - Linux: Direct fs write + chmod.
   * - Windows: Direct fs write with file-lock retry.
   *
   * @param vaultPath - The absolute vault root path.
   * @param relativePath - The relative path within the vault.
   * @param content - The file content (string for text, Uint8Array for binary).
   */
  async writeFile(
    vaultPath: string,
    relativePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    // Validate path
    const validation = validatePath(vaultPath, relativePath);
    if (!validation.valid || !validation.safePath) {
      throw new Error(`OsWriter: invalid path "${relativePath}": ${validation.error}`);
    }

    const safePath = validation.safePath;
    const platform = getPlatform();

    try {
      // Ensure parent directory exists
      const dir = path.dirname(safePath);
      await fs.promises.mkdir(dir, { recursive: true });

      if (platform === "macos" && this.vaultModifyFn) {
        // macOS: Use Obsidian API to avoid EDEADLK
        const contentStr =
          typeof content === "string" ? content : Buffer.from(content).toString("utf-8");
        await this.vaultModifyFn(relativePath, contentStr);
      } else if (platform === "linux") {
        // Linux: Direct write + chmod
        await fs.promises.writeFile(safePath, content);
        await fs.promises.chmod(safePath, 0o644);
      } else {
        // Windows: Direct write with file-lock retry
        await this.writeFileWithRetry(safePath, content, 3);
      }

      // Mark as pushed to prevent sync loops
      if (this.markAsPushedFn) {
        this.markAsPushedFn(relativePath);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`OsWriter: failed to write "${relativePath}": ${errorMessage}`);
    }
  }

  /**
   * Write a file with retry logic (for Windows file-lock scenarios).
   */
  private async writeFileWithRetry(
    filePath: string,
    content: string | Uint8Array,
    maxRetries: number,
    retryDelayMs: number = 100,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await fs.promises.writeFile(filePath, content);
        return;
      } catch (err: unknown) {
        if (attempt < maxRetries) {
          await new Promise((resolve) => window.setTimeout(resolve, retryDelayMs));
        } else {
          throw err;
        }
      }
    }
  }

  // ============================================================
  // Delete File
  // ============================================================

  /**
   * Delete a file from the vault.
   */
  async deleteFile(vaultPath: string, relativePath: string): Promise<void> {
    const validation = validatePath(vaultPath, relativePath);
    if (!validation.valid) {
      throw new Error(`OsWriter: invalid delete path "${relativePath}": ${validation.error}`);
    }

    const safePath = validation.safePath!;
    const platform = getPlatform();

    try {
      if (platform === "macos" && this.vaultDeleteFn) {
        await this.vaultDeleteFn(relativePath);
      } else {
        await fs.promises.unlink(safePath);
      }

      if (this.markAsPushedFn) {
        this.markAsPushedFn(relativePath);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`OsWriter: failed to delete "${relativePath}": ${errorMessage}`);
    }
  }

  // ============================================================
  // Rename File
  // ============================================================

  /**
   * Rename a file within the vault.
   */
  async renameFile(
    vaultPath: string,
    oldRelativePath: string,
    newRelativePath: string,
  ): Promise<void> {
    const oldValidation = validatePath(vaultPath, oldRelativePath);
    const newValidation = validatePath(vaultPath, newRelativePath);

    if (!oldValidation.valid) {
      throw new Error(`OsWriter: invalid old path "${oldRelativePath}": ${oldValidation.error}`);
    }
    if (!newValidation.valid) {
      throw new Error(`OsWriter: invalid new path "${newRelativePath}": ${newValidation.error}`);
    }

    const oldSafePath = oldValidation.safePath!;
    const newSafePath = newValidation.safePath!;
    const platform = getPlatform();

    try {
      // Ensure parent directory of new path exists
      const newDir = path.dirname(newSafePath);
      await fs.promises.mkdir(newDir, { recursive: true });

      if (platform === "macos" && this.vaultRenameFn) {
        await this.vaultRenameFn(oldRelativePath, newRelativePath);
      } else {
        await fs.promises.rename(oldSafePath, newSafePath);
      }

      if (this.markAsPushedFn) {
        this.markAsPushedFn(oldRelativePath);
        this.markAsPushedFn(newRelativePath);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(
        `OsWriter: failed to rename "${oldRelativePath}" → "${newRelativePath}": ${errorMessage}`,
      );
    }
  }

  // ============================================================
  // Read File
  // ============================================================

  /**
   * Read a file from the vault.
   *
   * @param vaultPath - The absolute vault root path.
   * @param relativePath - The relative path within the vault.
   * @returns A Buffer with the file contents.
   */
  async readFile(vaultPath: string, relativePath: string): Promise<Buffer> {
    const validation = validatePath(vaultPath, relativePath);
    if (!validation.valid || !validation.safePath) {
      throw new Error(`OsWriter: invalid read path "${relativePath}": ${validation.error}`);
    }

    const safePath = validation.safePath;
    const platform = getPlatform();

    try {
      if (platform === "macos" && this.vaultReadFn) {
        const content = await this.vaultReadFn(relativePath);
        return Buffer.from(content, "utf-8");
      } else {
        return await fs.promises.readFile(safePath);
      }
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      throw new Error(`OsWriter: failed to read "${relativePath}": ${errorMessage}`);
    }
  }
}
