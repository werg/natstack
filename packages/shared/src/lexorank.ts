const WIDTH = 12;
const STEP = 1_000_000n;

function encode(value: bigint): string {
  return value.toString().padStart(WIDTH, "0");
}

function decode(rank: string | undefined): bigint | null {
  if (!rank) return null;
  const numeric = rank.match(/^\d+/)?.[0];
  if (!numeric) return null;
  return BigInt(numeric);
}

export function first(): string {
  return encode(STEP);
}

export function last(): string {
  return encode(STEP * 1_000_000n);
}

export function between(prev?: string, next?: string): string {
  const a = decode(prev);
  const b = decode(next);
  if (a == null && b == null) return first();
  if (a == null && b != null) return encode(b > 1n ? b / 2n : 0n);
  if (a != null && b == null) return encode(a + STEP);
  if (a == null || b == null) return first();
  if (b - a > 1n) return encode(a + (b - a) / 2n);
  return `${encode(a)}.${Date.now().toString(36)}`;
}
