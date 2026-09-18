export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Sync non-cryptographic 64-bit hash for deterministic id generation. Not for security. */
export function fnv1aHex(value: string): string {
  let lo = 0x811c9dc5;
  let hi = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    lo = Math.imul(lo ^ (c & 0xff), 0x01000193) >>> 0;
    hi = Math.imul(hi ^ (c >>> 8), 0x01000193) >>> 0;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}
