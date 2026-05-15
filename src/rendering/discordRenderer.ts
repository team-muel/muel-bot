import { EmbedBuilder, type MessageCreateOptions } from 'discord.js';
import type { MuelRenderablePart } from './types.js';

function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 20)}…\n\n[원문에서 계속 보기]`;
}

function truncateTitle(text: string, max = 256): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function renderDiscordMessage(parts: MuelRenderablePart[]): MessageCreateOptions {
  const embeds: EmbedBuilder[] = [];
  const options: MessageCreateOptions = {
    content: '',
    embeds,
    allowedMentions: {
      parse: [],
      repliedUser: false,
    },
  };

  const textContents: string[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      textContents.push(part.text);
    } else if (part.type === 'youtube-community-post-card') {
      const embed = new EmbedBuilder()
        .setColor(0x2b2d31) // Colorless (Discord dark background)
        .setAuthor({ name: truncateTitle(part.authorName, 256) })
        .setDescription(part.body ? truncate(part.body, 600) : null)
        .setURL(part.sourceUrl)
        .setFooter({ text: ['YouTube community', part.publishedAt].filter(Boolean).join(' | ').slice(0, 2048) });

      if (part.title) {
        embed.setTitle(truncateTitle(part.title, 256));
      }

      if (part.imageUrls && part.imageUrls.length > 0 && part.imageUrls[0]) {
        embed.setImage(part.imageUrls[0]);
      }

      embeds.push(embed);
    } else if (part.type === 'announcement-card') {
      const embed = new EmbedBuilder()
        .setColor(0x2f80ed)
        .setDescription(part.body ? truncate(part.body, 3900) : null)
        .setFooter({ text: ['공지사항', part.author, part.publishedAt].filter(Boolean).join(' | ').slice(0, 2048) });

      if (part.title) embed.setTitle(truncateTitle(part.title, 256));
      if (part.sourceUrl) embed.setURL(part.sourceUrl);
      if (part.imageUrl) embed.setImage(part.imageUrl);

      embeds.push(embed);
    } else if (part.type === 'release-note-card') {
      const embed = new EmbedBuilder()
        .setColor(0x00c853)
        .setTitle(truncateTitle(`🚀 ${part.product} ${part.version ? `v${part.version}` : ''} 업데이트`, 256))
        .setDescription(truncate(part.highlights.map(h => `• ${h}`).join('\n'), 3900))
        .setFooter({ text: 'Release Note' });

      if (part.sourceUrl) embed.setURL(part.sourceUrl);
      embeds.push(embed);
    } else if (part.type === 'video-card') {
      textContents.push(`📌 **${part.author}** 신규 ${part.isShorts ? '쇼츠' : '영상'} 업로드!\n${part.title}\n${part.url}`);
    }
  }

  if (textContents.length > 0) {
    options.content = textContents.join('\n\n');
  }

  if (!options.content && embeds.length === 0) {
    options.content = '내용 없음';
  }

  return options;
}
