// ============================================================
// CertManager — TLS Certificate Lifecycle Manager
//
// Zero external dependencies. Uses only Node.js built-in
// modules: node:crypto, node:tls, node:fs, node:path, node:os.
// ============================================================

import * as crypto from "node:crypto";
import * as tls from "node:tls";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// ============================================================
// Exported Interfaces
// ============================================================

export interface CertResult {
  certPem: string;
  keyPem: string;
  fingerprint: string;
}

export interface TlsOptions {
  secureContext: tls.SecureContext;
  isReady: boolean;
  fingerprint: string;
  keyPem: string;
  certPem: string;
}

// ============================================================
// ASN.1 DER Encoding Helpers
// ============================================================

/**
 * Encode a DER length field.
 * Short form (< 128 bytes): single byte.
 * Long form: first byte = 0x80 | number_of_length_bytes, followed by length bytes.
 */
function encodeLength(length: number): Buffer {
  if (length < 0x80) {
    const buf = Buffer.alloc(1);
    buf[0] = length;
    return buf;
  }
  const bytes: number[] = [];
  let len = length;
  while (len > 0) {
    bytes.unshift(len & 0xff);
    len >>>= 8;
  }
  const buf = Buffer.alloc(1 + bytes.length);
  buf[0] = 0x80 | bytes.length;
  for (let i = 0; i < bytes.length; i++) {
    buf[1 + i] = bytes[i];
  }
  return buf;
}

/** Encode a DER tag-length-value triple. */
function encodeTlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

/** Encode a DER INTEGER from a hex string (positive, big-endian). */
function encodeIntegerFromHex(hex: string): Buffer {
  const bytes = Buffer.from(hex, "hex");
  // Ensure positive: prepend 0x00 if high bit is set
  if (bytes.length > 0 && (bytes[0] & 0x80) !== 0) {
    return encodeTlv(0x02, Buffer.concat([Buffer.from([0x00]), bytes]));
  }
  return encodeTlv(0x02, bytes);
}

/** Encode a small positive integer as DER INTEGER. */
function encodeSmallInt(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  }
  if (bytes.length === 0) {
    return encodeTlv(0x02, Buffer.from([0x00]));
  }
  if (bytes[0] & 0x80) {
    bytes.unshift(0x00);
  }
  return encodeTlv(0x02, Buffer.from(bytes));
}

/** Encode a DER SEQUENCE from a list of child DER-encoded buffers. */
function encodeSequence(children: Buffer[]): Buffer {
  return encodeTlv(0x30, Buffer.concat(children));
}

/** Encode a DER SET from a list of child DER-encoded buffers. */
function encodeSet(children: Buffer[]): Buffer {
  return encodeTlv(0x31, Buffer.concat(children));
}

/** Encode an OID string (e.g. "1.2.840.10045.4.3.2") into DER bytes. */
function encodeOid(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const bytes: number[] = [];

  // First two components encoded as 40*part[0] + part[1]
  bytes.push(40 * parts[0] + parts[1]);

  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    if (val < 0x80) {
      bytes.push(val);
    } else {
      const oidBytes: number[] = [];
      while (val > 0) {
        oidBytes.unshift(val & 0x7f);
        val >>>= 7;
      }
      for (let j = 0; j < oidBytes.length - 1; j++) {
        oidBytes[j] |= 0x80;
      }
      bytes.push(...oidBytes);
    }
  }
  return encodeTlv(0x06, Buffer.from(bytes));
}

/** Encode a UTCTime (YYMMDDHHMMSSZ format). */
function encodeUtcTime(date: Date): Buffer {
  const y = date.getUTCFullYear().toString().padStart(4, "0").slice(-2);
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  const h = date.getUTCHours().toString().padStart(2, "0");
  const min = date.getUTCMinutes().toString().padStart(2, "0");
  const s = date.getUTCSeconds().toString().padStart(2, "0");
  const timeStr = `${y}${m}${d}${h}${min}${s}Z`;
  return Buffer.concat([Buffer.from([0x17]), encodeLength(timeStr.length), Buffer.from(timeStr)]);
}

/** Encode a BIT STRING with unused bits = 0. */
function encodeBitString(derBytes: Buffer): Buffer {
  return encodeTlv(0x03, Buffer.concat([Buffer.from([0x00]), derBytes]));
}

/** Encode a UTF8String value. */
function encodeUtf8String(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return encodeTlv(0x0c, bytes);
}

/** Build an AlgorithmIdentifier SEQUENCE { OID, params? }. */
function encodeAlgorithmIdentifier(oid: string, params?: Buffer): Buffer {
  const children: Buffer[] = [encodeOid(oid)];
  if (params) {
    children.push(params);
  }
  return encodeSequence(children);
}

/** Build a Name from a single CN attribute (CN=value). */
function encodeCnName(cnValue: string): Buffer {
  // RelativeDistinguishedName ::= SET OF AttributeTypeAndValue
  // AttributeTypeAndValue ::= SEQUENCE { type OID, value ANY }
  // CN OID = 2.5.4.3
  const attrTypeAndValue = encodeSequence([encodeOid("2.5.4.3"), encodeUtf8String(cnValue)]);
  return encodeSequence([encodeSet([attrTypeAndValue])]);
}

/**
 * Encode SubjectPublicKeyInfo for ECDSA P-256.
 *
 * SubjectPublicKeyInfo ::= SEQUENCE {
 *   algorithm   AlgorithmIdentifier,
 *   subjectPublicKey BIT STRING
 * }
 *
 * The subjectPublicKey is the ANSI X9.62 uncompressed point encoding
 * (0x04 || x || y), where x and y are 32-byte big-endian integers.
 */
function encodeSubjectPublicKeyInfo(pubKeyDer: Buffer): Buffer {
  // AlgorithmIdentifier: id-ecPublicKey (1.2.840.10045.2.1) with curve P-256 (1.2.840.10045.3.1.7)
  const algoId = encodeAlgorithmIdentifier("1.2.840.10045.2.1", encodeOid("1.2.840.10045.3.1.7"));
  const subjectPublicKey = encodeBitString(pubKeyDer);
  return encodeSequence([algoId, subjectPublicKey]);
}

// ============================================================
// CertManager
// ============================================================

export class CertManager {
  private certDir: string;
  private certPath: string;
  private keyPath: string;
  private cachedFingerprint: string | null = null;
  private cachedSecureContext: tls.SecureContext | null = null;
  private cachedKeyPem: string | null = null;
  private cachedCertPem: string | null = null;

  constructor(certDir: string) {
    this.certDir = certDir;
    this.certPath = path.join(certDir, "cert.pem");
    this.keyPath = path.join(certDir, "key.pem");
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  /**
   * Ensure a valid certificate exists. Loads from disk if present,
   * or generates a new self-signed ECDSA P-256 certificate.
   */
  async getOrCreateCert(): Promise<CertResult> {
    await fs.mkdir(this.certDir, { recursive: true });

    try {
      const [certPem, keyPem] = await Promise.all([
        fs.readFile(this.certPath, "utf8"),
        fs.readFile(this.keyPath, "utf8"),
      ]);

      if (certPem && keyPem) {
        const fingerprint = this.computeFingerprint(certPem);
        this.cachedFingerprint = fingerprint;
        return { certPem, keyPem, fingerprint };
      }
    } catch {
      // File(s) missing or unreadable — generate new cert
    }

    // Generate new self-signed certificate
    const { cert, key } = await this.generateSelfSignedCert();
    await Promise.all([
      fs.writeFile(this.certPath, cert, "utf8"),
      fs.writeFile(this.keyPath, key, "utf8"),
    ]);

    const fingerprint = this.computeFingerprint(cert);
    this.cachedFingerprint = fingerprint;
    return { certPem: cert, keyPem: key, fingerprint };
  }

  /**
   * Return the SHA-256 fingerprint of the current certificate,
   * formatted as colon-separated uppercase hex (XX:XX:XX...).
   */
  async getFingerprint(): Promise<string> {
    if (this.cachedFingerprint) {
      return this.cachedFingerprint;
    }
    const result = await this.getOrCreateCert();
    return result.fingerprint;
  }

  /**
   * Parse and return detailed certificate information.
   * Uses crypto.X509Certificate (available since Node.js v15.6.0).
   */
  async getCertInfo(): Promise<{
    fingerprint: string;
    algorithm: string;
    issuedAt: Date;
    expiresAt: Date;
    serialNumber: string;
    isExpired: boolean;
  }> {
    const result = await this.getOrCreateCert();
    const fingerprint = this.computeFingerprint(result.certPem);
    const x509 = new crypto.X509Certificate(result.certPem);
    return {
      fingerprint,
      algorithm: "ECDSA P-256",
      issuedAt: new Date(x509.validFrom),
      expiresAt: new Date(x509.validTo),
      serialNumber: x509.serialNumber,
      isExpired: new Date(x509.validTo) < new Date(),
    };
  }

  /**
   * Create a TLS SecureContext from the certificate for use with
   * TLS servers and clients.
   */
  async getTlsOptions(): Promise<TlsOptions> {
    if (this.cachedSecureContext && this.cachedKeyPem && this.cachedCertPem) {
      return {
        secureContext: this.cachedSecureContext,
        isReady: true,
        fingerprint: this.cachedFingerprint || "",
        keyPem: this.cachedKeyPem,
        certPem: this.cachedCertPem,
      };
    }
    const result = await this.getOrCreateCert();
    const secureContext = tls.createSecureContext({
      key: result.keyPem,
      cert: result.certPem,
    });
    this.cachedSecureContext = secureContext;
    this.cachedKeyPem = result.keyPem;
    this.cachedCertPem = result.certPem;
    return {
      secureContext,
      isReady: true,
      fingerprint: result.fingerprint,
      keyPem: result.keyPem,
      certPem: result.certPem,
    };
  }

  /**
   * Delete existing certificate files and generate a fresh one.
   */
  async resetCert(): Promise<CertResult> {
    // Delete old files (ignore errors if they don't exist)
    try {
      await fs.unlink(this.certPath);
    } catch {
      /* ignore */
    }
    try {
      await fs.unlink(this.keyPath);
    } catch {
      /* ignore */
    }
    this.cachedFingerprint = null;
    this.cachedSecureContext = null;
    this.cachedKeyPem = null;
    this.cachedCertPem = null;
    return this.getOrCreateCert();
  }

  /**
   * Check whether certificate files exist on disk.
   */
  async hasCert(): Promise<boolean> {
    try {
      await fs.access(this.certPath);
      await fs.access(this.keyPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear in-memory caches. Does not touch files on disk.
   */
  destroy(): void {
    this.cachedFingerprint = null;
    this.cachedSecureContext = null;
    this.cachedKeyPem = null;
    this.cachedCertPem = null;
  }

  // ----------------------------------------------------------
  // Fingerprint
  // ----------------------------------------------------------

  /**
   * Compute the SHA-256 fingerprint of a PEM certificate.
   * Returns colon-separated uppercase hex (XX:XX:XX...).
   */
  computeFingerprint(certPem: string): string {
    const base64 = certPem
      .replace(/-----BEGIN CERTIFICATE-----/g, "")
      .replace(/-----END CERTIFICATE-----/g, "")
      .replace(/\n/g, "")
      .replace(/\r/g, "")
      .trim();
    const der = Buffer.from(base64, "base64");
    const hash = crypto.createHash("sha256").update(der).digest("hex");
    return hash.match(/.{2}/g)!.join(":").toUpperCase();
  }

  // ----------------------------------------------------------
  // Self-Signed Certificate Generation
  // ----------------------------------------------------------

  /**
   * Generate a self-signed ECDSA P-256 certificate.
   *
   * Builds the X.509v3 certificate structure manually using ASN.1 DER
   * encoding, then signs it with the generated private key.
   */
  private async generateSelfSignedCert(): Promise<{ cert: string; key: string }> {
    // Step 1: Generate ECDSA P-256 key pair
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    // Step 2: Extract the raw uncompressed public key point (0x04 || x || y, 65 bytes)
    const pubKeyObj = crypto.createPublicKey(publicKey);
    // The SPKI DER structure is: SEQUENCE { AlgorithmIdentifier, BIT STRING (uncompressed point) }
    // We need to extract just the BIT STRING value (the point) for TBSCertificate SubjectPublicKeyInfo.
    // Since `sec1` export is only valid for EC private keys, use JWK export to extract
    // the raw uncompressed point coordinates.
    // Actually, encodeSubjectPublicKeyInfo needs the raw uncompressed point bytes.
    // Get the raw point via JWK export (x, y base64url) and build 0x04 || x || y manually.
    const jwk = pubKeyObj.export({ format: "jwk" });
    const x = Buffer.from(jwk.x as string, "base64url");
    const y = Buffer.from(jwk.y as string, "base64url");
    const rawPoint = Buffer.concat([Buffer.from([0x04]), x, y]);

    // Step 3: Build certificate parameters
    const serial = crypto.randomBytes(16).toString("hex");
    const notBefore = new Date();
    const notAfter = new Date();
    notAfter.setFullYear(notAfter.getFullYear() + 10);

    // Step 4: Build TBSCertificate DER structure
    const tbsCert = this.buildTbsCertificate(rawPoint, serial, notBefore, notAfter);

    // Step 5: Sign the TBSCertificate
    const privKeyObj = crypto.createPrivateKey(privateKey);
    const sign = crypto.createSign("sha256");
    sign.update(tbsCert);
    const signature = sign.sign(privKeyObj);

    // Step 6: Build the full Certificate DER structure
    const certDer = this.buildCertificateDer(tbsCert, signature);

    // Step 7: Convert to PEM
    const certPem = this.derToPem(certDer, "CERTIFICATE");

    return { cert: certPem, key: privateKey };
  }

  /**
   * Build the TBSCertificate DER structure for a self-signed certificate.
   *
   * TBSCertificate ::= SEQUENCE {
   *   version         [0] EXPLICIT INTEGER { v3(2) },
   *   serialNumber    INTEGER,
   *   signature       AlgorithmIdentifier (ecdsa-with-SHA256),
   *   issuer          Name,
   *   validity        Validity { notBefore, notAfter },
   *   subject         Name,
   *   subjectPublicKeyInfo SubjectPublicKeyInfo
   * }
   */
  private buildTbsCertificate(
    rawPoint: Buffer,
    serialHex: string,
    notBefore: Date,
    notAfter: Date,
  ): Buffer {
    // version [0] EXPLICIT INTEGER (v3 = 2)
    const version = encodeTlv(0xa0, encodeSmallInt(2));

    // serialNumber INTEGER
    const serialNumber = encodeIntegerFromHex(serialHex);

    // signature AlgorithmIdentifier (ecdsa-with-SHA256 = 1.2.840.10045.4.3.2)
    const signature = encodeAlgorithmIdentifier("1.2.840.10045.4.3.2");

    // issuer Name (CN=ObsidianLocalSync)
    const issuer = encodeCnName("ObsidianLocalSync");

    // validity SEQUENCE { notBefore UTCTime, notAfter UTCTime }
    const validity = encodeSequence([encodeUtcTime(notBefore), encodeUtcTime(notAfter)]);

    // subject Name (same as issuer for self-signed)
    const subject = encodeCnName("ObsidianLocalSync");

    // subjectPublicKeyInfo
    const subjectPublicKeyInfo = encodeSubjectPublicKeyInfo(rawPoint);

    const children = [version, serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo];
    return encodeSequence(children);
  }

  /**
   * Build the full X.509 Certificate DER structure.
   *
   * Certificate ::= SEQUENCE {
   *   tbsCertificate       TBSCertificate,
   *   signatureAlgorithm   AlgorithmIdentifier,
   *   signatureValue       BIT STRING
   * }
   */
  private buildCertificateDer(tbsCert: Buffer, signature: Buffer): Buffer {
    // signatureAlgorithm (ecdsa-with-SHA256 = 1.2.840.10045.4.3.2)
    const signatureAlgorithm = encodeAlgorithmIdentifier("1.2.840.10045.4.3.2");

    // signatureValue BIT STRING (wrap the DER-encoded ECDSA signature)
    const signatureValue = encodeBitString(signature);

    return encodeSequence([tbsCert, signatureAlgorithm, signatureValue]);
  }

  /**
   * Convert a DER-encoded buffer to PEM format.
   */
  private derToPem(der: Buffer, label: string): string {
    const base64 = der.toString("base64");
    const lines: string[] = [];
    for (let i = 0; i < base64.length; i += 64) {
      lines.push(base64.slice(i, i + 64));
    }
    return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
  }
}
