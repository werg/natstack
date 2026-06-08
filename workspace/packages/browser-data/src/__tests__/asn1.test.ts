import { describe, it, expect } from "vitest";
import { parseAsn1, parseAsn1Sequence, oidToString } from "../crypto/asn1.js";

describe("ASN.1 DER parser", () => {
  describe("parseAsn1", () => {
    it("parses a simple OCTET STRING", () => {
      // Tag 0x04, length 3, data "abc"
      const buf = Buffer.from([0x04, 0x03, 0x61, 0x62, 0x63]);
      const node = parseAsn1(buf);
      expect(node.tag).toBe(0x04);
      expect(node.data.toString()).toBe("abc");
      expect(node.children).toBeUndefined();
    });

    it("parses an INTEGER", () => {
      // Tag 0x02, length 1, value 42
      const buf = Buffer.from([0x02, 0x01, 0x2a]);
      const node = parseAsn1(buf);
      expect(node.tag).toBe(0x02);
      expect(node.data[0]!).toBe(42);
    });

    it("parses a SEQUENCE with children", () => {
      // SEQUENCE containing two INTEGERs: 1 and 2
      const buf = Buffer.from([
        0x30, 0x06, // SEQUENCE, length 6
        0x02, 0x01, 0x01, // INTEGER 1
        0x02, 0x01, 0x02, // INTEGER 2
      ]);
      const node = parseAsn1(buf);
      expect(node.tag).toBe(0x30);
      expect(node.children).toHaveLength(2);
      expect(node.children![0]!.data[0]!).toBe(1);
      expect(node.children![1]!.data[0]!).toBe(2);
    });

    it("handles multi-byte length", () => {
      // OCTET STRING with 200 bytes of data
      const payload = Buffer.alloc(200, 0x42);
      const buf = Buffer.concat([
        Buffer.from([0x04, 0x81, 0xc8]), // tag, long-form length (1 byte: 200)
        payload,
      ]);
      const node = parseAsn1(buf);
      expect(node.tag).toBe(0x04);
      expect(node.data.length).toBe(200);
      expect(node.data[0]!).toBe(0x42);
    });

    it("handles two-byte multi-byte length", () => {
      // OCTET STRING with 300 bytes
      const payload = Buffer.alloc(300, 0xaa);
      const buf = Buffer.concat([
        Buffer.from([0x04, 0x82, 0x01, 0x2c]), // tag, long-form 2-byte length: 300
        payload,
      ]);
      const node = parseAsn1(buf);
      expect(node.data.length).toBe(300);
    });

    it("parses nested SEQUENCE structures", () => {
      // SEQUENCE { SEQUENCE { INTEGER 5 } }
      const inner = Buffer.from([
        0x30, 0x03, // inner SEQUENCE
        0x02, 0x01, 0x05, // INTEGER 5
      ]);
      const outer = Buffer.concat([
        Buffer.from([0x30, inner.length]),
        inner,
      ]);
      const node = parseAsn1(outer);
      expect(node.children).toHaveLength(1);
      expect(node.children![0]!.children).toHaveLength(1);
      expect(node.children![0]!.children![0]!.data[0]!).toBe(5);
    });

    it("parses context-specific tags as constructed", () => {
      // Context-specific [0] CONSTRUCTED containing an INTEGER
      const buf = Buffer.from([
        0xa0, 0x03, // context [0] constructed
        0x02, 0x01, 0x07, // INTEGER 7
      ]);
      const node = parseAsn1(buf);
      expect(node.tag).toBe(0xa0);
      expect(node.children).toHaveLength(1);
      expect(node.children![0]!.data[0]!).toBe(7);
    });

    it("throws on truncated data", () => {
      expect(() => parseAsn1(Buffer.from([0x04]))).toThrow("truncated");
    });

    it("throws on data exceeding buffer", () => {
      // Claims length 10 but only 3 bytes available
      expect(() => parseAsn1(Buffer.from([0x04, 0x0a, 0x01, 0x02, 0x03]))).toThrow("exceeds");
    });

    it("throws on empty input", () => {
      expect(() => parseAsn1(Buffer.alloc(0))).toThrow("unexpected end");
    });
  });

  describe("parseAsn1Sequence", () => {
    it("parses multiple consecutive nodes", () => {
      const buf = Buffer.from([
        0x02, 0x01, 0x0a, // INTEGER 10
        0x02, 0x01, 0x14, // INTEGER 20
        0x04, 0x02, 0x41, 0x42, // OCTET STRING "AB"
      ]);
      const nodes = parseAsn1Sequence(buf);
      expect(nodes).toHaveLength(3);
      expect(nodes[0]!.tag).toBe(0x02);
      expect(nodes[0]!.data[0]!).toBe(10);
      expect(nodes[1]!.data[0]!).toBe(20);
      expect(nodes[2]!.tag).toBe(0x04);
      expect(nodes[2]!.data.toString()).toBe("AB");
    });

    it("returns empty array for empty buffer", () => {
      expect(parseAsn1Sequence(Buffer.alloc(0))).toHaveLength(0);
    });
  });

  describe("oidToString", () => {
    it("decodes DES-EDE3-CBC OID (1.2.840.113549.3.7)", () => {
      // Known DER encoding for 1.2.840.113549.3.7
      const data = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x03, 0x07]);
      expect(oidToString(data)).toBe("1.2.840.113549.3.7");
    });

    it("decodes PBES2 OID (1.2.840.113549.1.5.13)", () => {
      const data = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0d]);
      expect(oidToString(data)).toBe("1.2.840.113549.1.5.13");
    });

    it("decodes PBKDF2 OID (1.2.840.113549.1.5.12)", () => {
      const data = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0c]);
      expect(oidToString(data)).toBe("1.2.840.113549.1.5.12");
    });

    it("decodes AES-256-CBC OID (2.16.840.1.101.3.4.1.42)", () => {
      const data = Buffer.from([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x2a]);
      expect(oidToString(data)).toBe("2.16.840.1.101.3.4.1.42");
    });

    it("decodes PBE-SHA1-3DES OID (1.2.840.113549.1.12.5.1.3)", () => {
      const data = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x0c, 0x05, 0x01, 0x03]);
      expect(oidToString(data)).toBe("1.2.840.113549.1.12.5.1.3");
    });

    it("decodes HMAC-SHA256 OID (1.2.840.113549.2.9)", () => {
      const data = Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x09]);
      expect(oidToString(data)).toBe("1.2.840.113549.2.9");
    });

    it("decodes simple OID (1.2.3)", () => {
      // First byte: 40*1 + 2 = 42 = 0x2a, then 3
      const data = Buffer.from([0x2a, 0x03]);
      expect(oidToString(data)).toBe("1.2.3");
    });

    it("returns empty string for empty buffer", () => {
      expect(oidToString(Buffer.alloc(0))).toBe("");
    });
  });

  describe("real-world ASN.1 structures", () => {
    it("parses a PBES2 password check structure", () => {
      // Simplified PBES2 structure as found in key4.db metaData:
      // SEQUENCE {
      //   SEQUENCE {
      //     OID (PBES2)
      //     SEQUENCE {
      //       SEQUENCE {
      //         OID (PBKDF2)
      //         SEQUENCE {
      //           OCTET STRING (salt, 32 bytes)
      //           INTEGER (iterations)
      //           INTEGER (key length)
      //           SEQUENCE { OID (HMAC-SHA256) }
      //         }
      //       }
      //       SEQUENCE {
      //         OID (AES-256-CBC)
      //         OCTET STRING (IV, 16 bytes)
      //       }
      //     }
      //   }
      //   OCTET STRING (encrypted data)
      // }

      // Build it from inside out
      const pbes2Oid = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0d]);
      const pbkdf2Oid = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x05, 0x0c]);
      const hmacOid = Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x02, 0x09]);
      const aesOid = Buffer.from([0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x01, 0x2a]);

      const salt = Buffer.alloc(32, 0xab);
      const saltTlv = Buffer.concat([Buffer.from([0x04, 0x20]), salt]);
      const iterations = Buffer.from([0x02, 0x02, 0x27, 0x10]); // 10000
      const keyLen = Buffer.from([0x02, 0x01, 0x20]); // 32
      const hmacSeq = wrapSequence(hmacOid);

      const pbkdf2ParamsSeq = wrapSequence(Buffer.concat([saltTlv, iterations, keyLen, hmacSeq]));
      const pbkdf2FullSeq = wrapSequence(Buffer.concat([pbkdf2Oid, pbkdf2ParamsSeq]));

      const iv = Buffer.alloc(16, 0xcd);
      const ivTlv = Buffer.concat([Buffer.from([0x04, 0x10]), iv]);
      const cipherSeq = wrapSequence(Buffer.concat([aesOid, ivTlv]));

      const pbes2ParamsSeq = wrapSequence(Buffer.concat([pbkdf2FullSeq, cipherSeq]));
      const algoSeq = wrapSequence(Buffer.concat([pbes2Oid, pbes2ParamsSeq]));

      const encData = Buffer.alloc(48, 0xee);
      const encDataTlv = Buffer.concat([Buffer.from([0x04, 0x30]), encData]);

      const fullBlob = wrapSequence(Buffer.concat([algoSeq, encDataTlv]));

      const root = parseAsn1(fullBlob);
      expect(root.tag).toBe(0x30);
      expect(root.children).toHaveLength(2);

      // Algorithm sequence
      const algo = root.children![0]!;
      expect(algo.children).toHaveLength(2);

      // Verify PBES2 OID
      const pbes2OidNode = algo.children![0]!;
      expect(pbes2OidNode.tag).toBe(0x06);
      expect(oidToString(pbes2OidNode.data)).toBe("1.2.840.113549.1.5.13");

      // Navigate to PBKDF2 salt
      const pbes2Params = algo.children![1]!;
      const pbkdf2 = pbes2Params.children![0]!;
      const pbkdf2OidNode = pbkdf2.children![0]!;
      expect(oidToString(pbkdf2OidNode.data)).toBe("1.2.840.113549.1.5.12");

      const pbkdf2InnerParams = pbkdf2.children![1]!;
      expect(pbkdf2InnerParams.children![0]!.data.length).toBe(32); // salt
      expect(pbkdf2InnerParams.children![0]!.data[0]!).toBe(0xab);

      // Encrypted data
      expect(root.children![1]!.data.length).toBe(48);
    });
  });
});

/** Helper: wrap data in a SEQUENCE TLV. */
function wrapSequence(content: Buffer): Buffer {
  if (content.length < 128) {
    return Buffer.concat([Buffer.from([0x30, content.length]), content]);
  }
  if (content.length < 256) {
    return Buffer.concat([Buffer.from([0x30, 0x81, content.length]), content]);
  }
  return Buffer.concat([
    Buffer.from([0x30, 0x82, (content.length >> 8) & 0xff, content.length & 0xff]),
    content,
  ]);
}
