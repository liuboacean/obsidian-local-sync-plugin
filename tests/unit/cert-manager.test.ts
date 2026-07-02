// ============================================================
// CertManager — Unit Tests
// ============================================================

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CertManager, TlsOptions } from "../../src/cert-manager";

const TEST_CERT_DIR = path.join(os.tmpdir(), "obsidian-sync-test-certs");

describe("CertManager", () => {
  let certMgr: CertManager;

  beforeEach(() => {
    // Clean test dir before each test
    try { fs.rmSync(TEST_CERT_DIR, { recursive: true }); } catch { /* ignore */ }
    certMgr = new CertManager(TEST_CERT_DIR);
  });

  afterEach(() => {
    certMgr.destroy();
    try { fs.rmSync(TEST_CERT_DIR, { recursive: true }); } catch { /* ignore */ }
  });

  // Test 1: getOrCreateCert — generates cert on first call
  it("should generate a self-signed certificate on first call", async () => {
    const result = await certMgr.getOrCreateCert();
    expect(result.certPem).toBeTruthy();
    expect(result.keyPem).toBeTruthy();
    expect(result.fingerprint).toBeTruthy();
    expect(result.certPem).toContain("-----BEGIN CERTIFICATE-----");
    expect(result.keyPem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(result.fingerprint).toMatch(/^[A-F0-9]{2}(:[A-F0-9]{2}){31}$/); // SHA-256 hex
  });

  // Test 2: getOrCreateCert — loads existing cert from disk
  it("should load existing certificate from disk", async () => {
    const first = await certMgr.getOrCreateCert();
    // Create a new CertManager pointing to same dir
    const certMgr2 = new CertManager(TEST_CERT_DIR);
    const second = await certMgr2.getOrCreateCert();
    expect(second.fingerprint).toBe(first.fingerprint);
    certMgr2.destroy();
  });

  // Test 3: getFingerprint — returns consistent value
  it("should return consistent fingerprint", async () => {
    const fp1 = await certMgr.getFingerprint();
    const fp2 = await certMgr.getFingerprint();
    expect(fp1).toBe(fp2);
  });

  // Test 4: getTlsOptions — returns valid TLS options
  it("should return valid TLS options with key and cert PEM", async () => {
    const opts = await certMgr.getTlsOptions();
    expect(opts.isReady).toBe(true);
    expect(opts.fingerprint).toBeTruthy();
    expect(opts.keyPem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(opts.certPem).toContain("-----BEGIN CERTIFICATE-----");
    expect(opts.secureContext).toBeDefined();
  });

  // Test 5: resetCert — regenerates with new fingerprint
  it("should regenerate certificate on reset", async () => {
    const before = await certMgr.getOrCreateCert();
    const after = await certMgr.resetCert();
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  // Test 6: hasCert — returns false before generation, true after
  it("should detect certificate existence", async () => {
    expect(await certMgr.hasCert()).toBe(false);
    await certMgr.getOrCreateCert();
    expect(await certMgr.hasCert()).toBe(true);
  });

  // Test 7: getCertInfo — returns valid certificate metadata
  it("should return valid certificate metadata", async () => {
    await certMgr.getOrCreateCert();
    const info = await certMgr.getCertInfo();
    expect(info.fingerprint).toBeTruthy();
    expect(info.algorithm).toBe("ECDSA P-256");
    expect(info.issuedAt).toBeInstanceOf(Date);
    expect(info.expiresAt).toBeInstanceOf(Date);
    expect(info.serialNumber).toBeTruthy();
    expect(info.isExpired).toBe(false);
  });

  // Test 8: computeFingerprint — format XX:XX:XX...
  it("should format fingerprint correctly", async () => {
    const result = await certMgr.getOrCreateCert();
    // Fingerprint should be 32 bytes = 64 hex chars = 95 chars with colons
    expect(result.fingerprint.length).toBe(95); // XX:XX:...:XX
  });
});
