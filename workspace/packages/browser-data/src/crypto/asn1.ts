/**
 * Minimal ASN.1 DER parser.
 *
 * Handles SEQUENCE, OCTET STRING, OID, INTEGER, and context-specific tags.
 * No encoding support — read-only.
 */

export interface Asn1Node {
  tag: number;
  data: Buffer;
  children?: Asn1Node[];
}

/**
 * Parse a single ASN.1 DER-encoded node from the start of `data`.
 * Returns the parsed node and the number of bytes consumed.
 */
function parseOne(data: Buffer, offset: number): { node: Asn1Node; consumed: number } {
  if (offset >= data.length) {
    throw new Error("ASN.1: unexpected end of data");
  }

  const tag = data[offset];
  let pos = offset + 1;

  // Read length
  if (pos >= data.length) {
    throw new Error("ASN.1: truncated length");
  }

  let length: number;
  const firstLenByte = data[pos];
  pos++;

  if (firstLenByte! < 0x80) {
    length = firstLenByte!;
  } else if (firstLenByte === 0x80) {
    throw new Error("ASN.1: indefinite length not supported");
  } else {
    const numLenBytes = firstLenByte! & 0x7f;
    if (numLenBytes > 4) {
      throw new Error("ASN.1: length too large");
    }
    if (pos + numLenBytes > data.length) {
      throw new Error("ASN.1: truncated multi-byte length");
    }
    length = 0;
    for (let i = 0; i < numLenBytes; i++) {
      length = (length << 8) | data[pos + i]!;
    }
    pos += numLenBytes;
  }

  if (pos + length > data.length) {
    throw new Error(`ASN.1: value exceeds buffer (need ${length} bytes at offset ${pos}, have ${data.length - pos})`);
  }

  const value = data.subarray(pos, pos + length);
  const consumed = pos + length - offset;

  // Constructed types: bit 5 set, or SEQUENCE (0x30), SET (0x31)
  const isConstructed = (tag! & 0x20) !== 0;

  if (isConstructed) {
    const children: Asn1Node[] = [];
    let childOffset = 0;
    while (childOffset < value.length) {
      const result = parseOne(value, childOffset);
      children.push(result.node);
      childOffset += result.consumed;
    }
    return {
      node: { tag: tag!, data: Buffer.from(value), children },
      consumed,
    };
  }

  return {
    node: { tag: tag!, data: Buffer.from(value) },
    consumed,
  };
}

/** Parse a single ASN.1 DER structure from `data`. */
export function parseAsn1(data: Buffer): Asn1Node {
  const { node } = parseOne(data, 0);
  return node;
}

/** Parse `data` as a series of consecutive ASN.1 nodes (e.g. the contents of a SEQUENCE). */
export function parseAsn1Sequence(data: Buffer): Asn1Node[] {
  const nodes: Asn1Node[] = [];
  let offset = 0;
  while (offset < data.length) {
    const { node, consumed } = parseOne(data, offset);
    nodes.push(node);
    offset += consumed;
  }
  return nodes;
}

/**
 * Decode an ASN.1 OBJECT IDENTIFIER value to dotted-decimal string.
 *
 * First byte encodes components 1 and 2 as (40 * c1 + c2).
 * Subsequent bytes use base-128 with high bit as continuation flag.
 */
export function oidToString(data: Buffer): string {
  if (data.length === 0) return "";

  const components: number[] = [];
  const first = data[0];
  components.push(Math.floor(first! / 40));
  components.push(first! % 40);

  let value = 0;
  for (let i = 1; i < data.length; i++) {
    const byte = data[i];
    value = (value << 7) | (byte! & 0x7f);
    if ((byte! & 0x80) === 0) {
      components.push(value);
      value = 0;
    }
  }

  return components.join(".");
}
