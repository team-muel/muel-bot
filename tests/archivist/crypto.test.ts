import assert from 'node:assert/strict';
import {
  decodeArchiveKey,
  decryptIdentity,
  deriveAuthorIdentity,
  encryptIdentity,
  fromPostgresBytea,
  toPostgresBytea,
} from '../../src/archivist/crypto.js';

const key = decodeArchiveKey('0123456789abcdef0123456789abcdef');
const identity = {
  userId: '123456789012345678',
  displayName: '생강',
  avatar: 'https://cdn.discordapp.com/avatar.png',
};

const first = deriveAuthorIdentity('stable-salt', 'guild-1', 'user-1');
const second = deriveAuthorIdentity('stable-salt', 'guild-1', 'user-1');
const differentGuild = deriveAuthorIdentity('stable-salt', 'guild-2', 'user-1');
assert.deepEqual(first, second);
assert.notEqual(first.authorKey, differentGuild.authorKey);
assert.match(first.pseudonym, /^former-[0-9a-f]{4}$/);

const encrypted = encryptIdentity(identity, key);
assert.notDeepEqual(encrypted, Buffer.from(JSON.stringify(identity)));
assert.deepEqual(decryptIdentity(encrypted, key), identity);
assert.deepEqual(fromPostgresBytea(toPostgresBytea(encrypted)), encrypted);

const tampered = Buffer.from(encrypted);
tampered[tampered.length - 1] ^= 1;
assert.throws(() => decryptIdentity(tampered, key));
assert.throws(() => decodeArchiveKey('too-short'));

console.log('archivist crypto tests passed');
