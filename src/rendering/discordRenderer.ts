import { EmbedBuilder, type MessageCreateOptions } from 'discord.js';
import type { MuelRenderablePart } from './types.js';

function truncate(text: string, max: number): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 18)).trimEnd()}\n\n[원문에서 계속 보기]`;
}

function truncateTitle(text: string, max = 256): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 3)).trimEnd()}...`;
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
      const imageUrl = part.imageUrls?.find((url) => typeof url === 'string' && /^https?:\/\//i.test(url));
      const maxDescLength = imageUrl ? 800 : 1200;
      const highlightText = part.highlights?.length
        ? `\n---\n**주요 내용**\n${part.highlights.map((highlight) => `- ${highlight}`).join('\n')}`
        : null;

      const descriptionParts = [
        part.subtitle ? `**${part.subtitle}**\n` : null,
        part.body ? truncate(part.body, maxDescLength) : null,
        highlightText,
        part.sourceUrl ? `\n---\n[원문 보기](${part.sourceUrl})` : null,
      ].filter((value): value is string => Boolean(value));

      const embed = new EmbedBuilder()
        .setDescription(descriptionParts.join('\n') || null)
        .setFooter({ text: ['YouTube 커뮤니티', part.authorName, part.publishedAt].filter(Boolean).join(' | ').slice(0, 2048) });

      if (part.tone === 'muel') embed.setColor(0xa2e61d);
      else if (part.tone === 'warning') embed.setColor(0xff3b30);
      else if (part.tone === 'success') embed.setColor(0x34c759);

      if (part.title) {
        embed.setTitle(truncateTitle(part.title, 256));
      }

      if (imageUrl) {
        embed.setImage(imageUrl);
      }

      embeds.push(embed);
    } else if (part.type === 'announcement-card') {
      const embed = new EmbedBuilder()
        .setColor(0x2f80ed)
        .setDescription(part.body ? truncate(part.body, 3900) : null)
        .setFooter({ text: ['공지', part.author, part.publishedAt].filter(Boolean).join(' | ').slice(0, 2048) });

      if (part.title) embed.setTitle(truncateTitle(part.title, 256));
      if (part.sourceUrl) embed.setURL(part.sourceUrl);
      if (part.imageUrl) embed.setImage(part.imageUrl);

      embeds.push(embed);
    } else if (part.type === 'release-note-card') {
      const embed = new EmbedBuilder()
        .setColor(0x00c853)
        .setTitle(truncateTitle(`${part.product} ${part.version ? `v${part.version}` : ''} 업데이트`, 256))
        .setDescription(truncate(part.highlights.map((highlight) => `- ${highlight}`).join('\n'), 3900))
        .setFooter({ text: 'Release Note' });

      if (part.sourceUrl) embed.setURL(part.sourceUrl);
      embeds.push(embed);
    } else if (part.type === 'video-card') {
      textContents.push(`**${part.author}** 새 YouTube ${part.isShorts ? '쇼츠' : '영상'} 업로드\n${part.title}\n${part.url}`);
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
