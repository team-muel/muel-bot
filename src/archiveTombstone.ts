import { ArchiveStore } from './archivist/store.js';

const messageId = process.argv[2]?.trim();
const reason = process.argv[3]?.trim() || 'erasure_request';

if (!messageId || !/^\d{17,20}$/.test(messageId)) {
  console.error('Usage: npm run archive:tombstone -- <discord_message_id> [reason]');
  process.exitCode = 2;
} else if (reason.length > 200) {
  console.error('Tombstone reason must be 200 characters or fewer.');
  process.exitCode = 2;
} else {
  const store = new ArchiveStore();
  await store.assertReady();
  await store.tombstoneMessage(messageId, reason);
  console.log('Archived message tombstoned.', { messageId, reason });
}
