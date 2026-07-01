// ============================================================
// Path Validator Tests
// ============================================================

import { describe, it, expect } from "vitest";
import {
  isPathTraversal,
  isWithinVault,
  sanitizePath,
  validatePath,
} from "../../src/path-validator";

// ============================================================
// isPathTraversal
// ============================================================

describe("isPathTraversal", () => {
  it("should detect parent directory references (..)", () => {
    expect(isPathTraversal("../etc/passwd")).toBe(true);
    expect(isPathTraversal("folder/../../etc")).toBe(true);
    expect(isPathTraversal("a/../b/../c")).toBe(true);
  });

  it("should detect absolute paths", () => {
    expect(isPathTraversal("/etc/passwd")).toBe(true);
    expect(isPathTraversal("/")).toBe(true);
  });

  it("should detect Windows drive letters", () => {
    expect(isPathTraversal("C:\\Windows\\System32")).toBe(true);
    expect(isPathTraversal("D:/docs/secret.txt")).toBe(true);
  });

  it("should detect home directory references", () => {
    expect(isPathTraversal("~/secret")).toBe(true);
  });

  it("should detect null byte injection", () => {
    expect(isPathTraversal("file.txt\0.sh")).toBe(true);
  });

  it("should accept safe paths", () => {
    expect(isPathTraversal("notes/my-file.md")).toBe(false);
    expect(isPathTraversal("folder/subfolder/file.txt")).toBe(false);
    expect(isPathTraversal("a-b_c/d.e")).toBe(false);
  });

  it("should reject empty or invalid input", () => {
    expect(isPathTraversal("")).toBe(true);
    expect(isPathTraversal("   ")).toBe(false); // spaces aren't traversal
  });
});

// ============================================================
// isWithinVault
// ============================================================

describe("isWithinVault", () => {
  it("should allow paths within the vault", () => {
    expect(isWithinVault("/home/user/vault", "notes/test.md")).toBe(true);
    expect(isWithinVault("/home/user/vault", "folder/file.txt")).toBe(true);
  });

  it("should reject paths outside the vault", () => {
    expect(isWithinVault("/home/user/vault", "../secret.txt")).toBe(false);
    expect(isWithinVault("/home/user/vault", "../../etc/passwd")).toBe(false);
  });

  it("should reject absolute paths", () => {
    expect(isWithinVault("/home/user/vault", "/etc/passwd")).toBe(false);
  });

  it("should handle deep nesting correctly", () => {
    expect(isWithinVault("/vault", "a/b/c/d/e/f/g.md")).toBe(true);
  });

  it("should handle empty vault path gracefully", () => {
    // path.resolve("", "test.md") resolves to "test.md" relative to CWD,
    // and path.relative("", "test.md") = "test.md" (doesn't start with ".."),
    // so it returns true (it's "within" the empty path).
    // This is expected behavior — the caller should always provide a valid vault path.
    expect(isWithinVault("", "test.md")).toBe(true);
  });
});

// ============================================================
// sanitizePath
// ============================================================

describe("sanitizePath", () => {
  it("should normalize backslashes to forward slashes", () => {
    expect(sanitizePath("folder\\file.md")).toBe("folder/file.md");
    expect(sanitizePath("a\\b\\c")).toBe("a/b/c");
  });

  it("should collapse consecutive slashes", () => {
    expect(sanitizePath("folder///file.md")).toBe("folder/file.md");
    expect(sanitizePath("a//b///c")).toBe("a/b/c");
  });

  it("should remove leading slashes", () => {
    expect(sanitizePath("/etc/passwd")).toBe("etc/passwd");
    expect(sanitizePath("//double/leading")).toBe("double/leading");
  });

  it("should remove trailing slashes", () => {
    expect(sanitizePath("folder/file/")).toBe("folder/file");
    expect(sanitizePath("folder//")).toBe("folder");
  });

  it("should remove null bytes", () => {
    expect(sanitizePath("file.txt\0.sh")).toBe("file.txt.sh");
  });

  it("should return empty string for null/undefined input", () => {
    expect(sanitizePath("")).toBe("");
    expect(sanitizePath(null as any)).toBe("");
  });
});

// ============================================================
// validatePath (Comprehensive)
// ============================================================

describe("validatePath", () => {
  it("should validate a safe path", () => {
    const result = validatePath("/vault", "notes/test.md");
    expect(result.valid).toBe(true);
    expect(result.safePath).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it("should reject path traversal", () => {
    const result = validatePath("/vault", "../etc/passwd");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("traversal");
  });

  it("should reject paths outside vault", () => {
    const result = validatePath("/vault/subdir", "../../secret.md");
    expect(result.valid).toBe(false);
  });

  it("should reject null receivedPath", () => {
    const result = validatePath("/vault", "");
    expect(result.valid).toBe(false);
  });

  it("should reject null vaultPath", () => {
    const result = validatePath("", "test.md");
    expect(result.valid).toBe(false);
  });

  it("should handle empty sanitized path", () => {
    const result = validatePath("/vault", "///");
    expect(result.valid).toBe(false);
  });
});
