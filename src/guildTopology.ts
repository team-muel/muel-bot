/**
 * Extracts server topology (channels, categories) from a Discord guild
 * and formats it as context for Muel's prompt.
 */
import { ChannelType, type Guild } from 'discord.js';

export const formatGuildTopology = (guild: Guild): string => {
  const channels = guild.channels.cache;
  if (channels.size === 0) return '';

  const categories = channels
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const textChannels = channels.filter(
    (c) =>
      c.type === ChannelType.GuildText ||
      c.type === ChannelType.GuildAnnouncement ||
      c.type === ChannelType.GuildForum,
  );

  const voiceChannels = channels.filter(
    (c) => c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice,
  );

  const lines = [
    `--- Server: ${guild.name} ---`,
    `멤버 ${guild.memberCount}명 | 텍스트 채널 ${textChannels.size}개 | 음성 채널 ${voiceChannels.size}개`,
  ];

  if (categories.size > 0) {
    lines.push('카테고리:');
    for (const [, cat] of categories) {
      const children = textChannels
        .filter((c) => c.parentId === cat.id)
        .map((c) => `#${c.name}`)
        .slice(0, 8);
      lines.push(`  ${cat.name}: ${children.join(', ') || '(비어있음)'}`);
    }
  }

  // Uncategorized channels
  const uncategorized = textChannels
    .filter((c) => !c.parentId)
    .map((c) => `#${c.name}`)
    .slice(0, 5);
  if (uncategorized.length > 0) {
    lines.push(`카테고리 없음: ${uncategorized.join(', ')}`);
  }

  lines.push('--- End Server ---');
  return lines.join('\n');
};
