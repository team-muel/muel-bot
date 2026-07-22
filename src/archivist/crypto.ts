import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

const IDENTITY_VERSION = 1;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export type ArchivedIdentity = {
  userId: string;
  displayName: string;
  avatar: string | null;
};

export const decodeArchiveKey = (encoded: string): Buffer => {
  const trimmed = encoded.trim();
  let key: Buffer;

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else {
    const base64 = Buffer.from(trimmed, 'base64');
    key = base64.length === 32 ? base64 : Buffer.from(trimmed, 'utf8');
  }

  if (key.length !== 32) {
    throw new Error('ARCHIVE_ENC_KEY must decode to exactly 32 bytes (hex, base64, or 32-byte UTF-8).');
  }
  return key;
};

export const deriveAuthorIdentity = (salt: string, guildId: string, userId: string) => {
  const digest = createHmac('sha256', salt).update(`${guildId}:${userId}`, 'utf8').digest();
  return {
    authorKey: digest.toString('base64'),
    pseudonym: `former-${digest.toString('hex').slice(0, 4)}`,
  };
};

export const encryptIdentity = (identity: ArchivedIdentity, key: Buffer): Buffer => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(identity), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([IDENTITY_VERSION]), iv, tag, ciphertext]);
};

export const decryptIdentity = (payload: Buffer, key: Buffer): ArchivedIdentity => {
  if (payload.length <= 1 + IV_BYTES + AUTH_TAG_BYTES || payload[0] !== IDENTITY_VERSION) {
    throw new Error('Unsupported or truncated archive identity payload.');
  }
  const ivStart = 1;
  const tagStart = ivStart + IV_BYTES;
  const ciphertextStart = tagStart + AUTH_TAG_BYTES;
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(ivStart, tagStart));
  decipher.setAuthTag(payload.subarray(tagStart, ciphertextStart));
  const plaintext = Buffer.concat([
    decipher.update(payload.subarray(ciphertextStart)),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8')) as ArchivedIdentity;
};

export const toPostgresBytea = (value: Buffer): string => `\\x${value.toString('hex')}`;

export const fromPostgresBytea = (value: unknown): Buffer => {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== 'string') throw new Error('identity_enc is not a bytea string.');
  if (value.startsWith('\\x')) return Buffer.from(value.slice(2), 'hex');
  return Buffer.from(value, 'base64');
};
