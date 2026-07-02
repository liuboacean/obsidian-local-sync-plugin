// ============================================================
// ConnectionManager TLS — Unit Tests
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest";
import { CertManager } from "../../src/cert-manager";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

const TEST_CERT_DIR = path.join(os.tmpdir(), "obsidian-sync-test-tls");

describe("ConnectionManager TLS", () => {
  let certMgr: CertManager;

  beforeEach(() => {
    try { fs.rmSync(TEST_CERT_DIR, { recursive: true }); } catch { /* ignore */ }
    certMgr = new CertManager(TEST_CERT_DIR);
  });

  // Test 1: CertManager generates valid TLS options for https.createServer
  it("should generate TLS options compatible with https.createServer", async () => {
    const opts = await certMgr.getTlsOptions();
    expect(opts.keyPem).toBeTruthy();
    expect(opts.certPem).toBeTruthy();

    // Verify we can create an https server with these options
    const https = await import("https");
    expect(() => {
      const server = https.createServer({ key: opts.keyPem, cert: opts.certPem });
      server.close();
    }).not.toThrow();
  });

  // Test 2: computeFingerprint returns deterministic format
  it("should produce consistent fingerprints", async () => {
    const fp1 = await certMgr.getFingerprint();
    const fp2 = await certMgr.getFingerprint();
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[A-F0-9]{2}(:[A-F0-9]{2}){31}$/);
  });

  // Test 3: TLS fingerprint format is correct length
  it("should have correct fingerprint length", async () => {
    const result = await certMgr.getOrCreateCert();
    // SHA-256 = 32 bytes = 64 hex chars, with colons = 95 chars
    expect(result.fingerprint.length).toBe(95);
  });

  // Test 4: Verify cert.pem and key.pem are written to disk
  it("should persist certificate files to disk", async () => {
    await certMgr.getOrCreateCert();
    expect(fs.existsSync(path.join(TEST_CERT_DIR, "cert.pem"))).toBe(true);
    expect(fs.existsSync(path.join(TEST_CERT_DIR, "key.pem"))).toBe(true);

    const certContent = fs.readFileSync(path.join(TEST_CERT_DIR, "cert.pem"), "utf-8");
    expect(certContent).toContain("-----BEGIN CERTIFICATE-----");
  });

  // Test 5: Multiple certs on different dirs have different fingerprints
  it("should generate different fingerprints for different directories", async () => {
    const dir2 = path.join(os.tmpdir(), "obsidian-sync-test-tls-2");
    try { fs.rmSync(dir2, { recursive: true }); } catch { /* ignore */ }

    const certMgr2 = new CertManager(dir2);
    const fp1 = await certMgr.getFingerprint();
    const fp2 = await certMgr2.getFingerprint();
    expect(fp1).not.toBe(fp2);

    certMgr2.destroy();
    try { fs.rmSync(dir2, { recursive: true }); } catch { /* ignore */ }
  });
});
