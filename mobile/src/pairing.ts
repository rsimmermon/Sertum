/** Kept in step with GATEWAY_API in the daemon. A mismatch is refused, never guessed at. */
export const GATEWAY_API_VERSION = 1;

/** Decoded from the QR code or its pasted text. */
export interface PairingOffer {
  id: string;
  name: string;
  pin: string;
  port: number;
  hosts: string[];
  code: string;
}

const PREFIX = 'sertum-pair:';

/** What the phone signs. The daemon's `signedText` is the other half of this. */
export function signedText(purpose: 'auth' | 'pair', nonce: string, pin: string): string {
  return `sertum-gateway-${GATEWAY_API_VERSION}|${purpose}|${nonce}|${pin}`;
}

/** Null for anything that is not a Sertum pairing code, as a camera may well see. */
export function parseOffer(text: string): PairingOffer | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX)) return null;
  try {
    const base64 = trimmed.slice(PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const read = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (read.v !== GATEWAY_API_VERSION || typeof read.id !== 'string' || typeof read.pin !== 'string' ||
      typeof read.code !== 'string' || typeof read.port !== 'number' || !Array.isArray(read.hosts)) {
      return null;
    }
    return {
      id: read.id,
      name: typeof read.name === 'string' ? read.name : 'PC',
      pin: read.pin,
      port: read.port,
      hosts: read.hosts.filter((h): h is string => typeof h === 'string'),
      code: read.code,
    };
  } catch {
    return null;
  }
}
