import { asSha256Hex, type Sha256Hex } from '@kinloom/core';

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

export function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export function base64UrlEncodeString(value: string): string {
  return base64UrlEncodeBytes(TEXT_ENCODER.encode(value));
}

export function base64UrlDecodeBytes(encoded: string): Uint8Array | null {
  try {
    const padded = encoded.replaceAll('-', '+').replaceAll('_', '/');
    const padLen = (4 - (padded.length % 4)) % 4;
    const binary = atob(padded + '='.repeat(padLen));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

export function base64UrlDecodeString(encoded: string): string | null {
  const bytes = base64UrlDecodeBytes(encoded);
  if (!bytes) {
    return null;
  }
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function randomBase64Url(byteLength = 24): string {
  return base64UrlEncodeBytes(randomBytes(byteLength));
}

export function generateEntityId(prefix: string): string {
  return `${prefix}_${toHex(randomBytes(8))}`;
}

export async function sha256Bytes(input: string | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  let buffer: ArrayBuffer;
  if (typeof input === 'string') {
    const encoded = TEXT_ENCODER.encode(input);
    buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
  } else if (input instanceof Uint8Array) {
    buffer = new Uint8Array(input).buffer;
  } else {
    buffer = input;
  }
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return new Uint8Array(digest);
}

export async function sha256Hex(input: string | ArrayBuffer | Uint8Array): Promise<Sha256Hex> {
  const digest = await sha256Bytes(input);
  return asSha256Hex(toHex(digest));
}

export async function pkceChallengeFromVerifier(codeVerifier: string): Promise<string> {
  const digest = await sha256Bytes(codeVerifier);
  return base64UrlEncodeBytes(digest);
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const secretBytes = TEXT_ENCODER.encode(secret);
  return crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function hmacSignBase64Url(secret: string, payload: string): Promise<string> {
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, TEXT_ENCODER.encode(payload));
  return base64UrlEncodeBytes(new Uint8Array(sig));
}

export async function hmacVerifyBase64Url(
  secret: string,
  payload: string,
  signatureBase64Url: string
): Promise<boolean> {
  const sigBytes = base64UrlDecodeBytes(signatureBase64Url);
  if (!sigBytes) {
    return false;
  }
  const key = await importHmacKey(secret);
  const sigBuffer = new Uint8Array(sigBytes).buffer;
  return crypto.subtle.verify('HMAC', key, sigBuffer, TEXT_ENCODER.encode(payload));
}

export async function readBodyToString(body: ReadableStream<Uint8Array> | string): Promise<string> {
  if (typeof body === 'string') {
    return body;
  }
  const bytes = await readStreamToBytes(body);
  return TEXT_DECODER.decode(bytes);
}

export async function readStreamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const copy = new Uint8Array(bytes);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(copy);
      controller.close();
    },
  });
}

export function matchesIfNoneMatch(ifNoneMatch: string | null | undefined, etag: string): boolean {
  if (!ifNoneMatch) {
    return false;
  }
  const normalizedTarget = etag.replace(/^W\//, '').trim();
  for (const rawPart of ifNoneMatch.split(',')) {
    const part = rawPart.trim();
    if (part === '*') {
      return true;
    }
    if (part.replace(/^W\//, '').trim() === normalizedTarget) {
      return true;
    }
  }
  return false;
}
