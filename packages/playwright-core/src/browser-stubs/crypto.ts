const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

export function randomBytes(size: number) {
  const arr = new Uint8Array(size);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues)
    crypto.getRandomValues(arr);
  return {
    toString: (encoding?: string) => encoding === 'hex' ? hex(arr) : '',
  };
}

export default { randomBytes };
