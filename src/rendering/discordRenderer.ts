import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, type MessageCreateOptions } from 'discord.js';
import type { MuelRenderablePart, RenderTone } from './types.js';

function toneColor(tone?: RenderTone): number | null {
  if (tone === 'muel') return 0xa2e61d;
  if (tone === 'warning') return 0xff3b30;
  if (tone === 'success') return 0x34c759;
  if (tone === 'game') return 0x8e7cff;
  return null;
}

function parseRelativeTimeToUnix(text: string): number | null {
  if (!text) return null;
  const now = Math.floor(Date.now() / 1000);
  const match = text.match(/(\d+)\s*(초|분|시간|일|주|개월|년|second|minute|hour|day|week|month|year)/i);
  if (!match) return null;
  const val = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (unit.includes('초') || unit.includes('second')) return now - val;
  if (unit.includes('분') || unit.includes('minute')) return now - val * 60;
  if (unit.includes('시간') || unit.includes('hour')) return now - val * 3600;
  if (unit.includes('일') || unit.includes('day')) return now - val * 86400;
  if (unit.includes('주') || unit.includes('week')) return now - val * 604800;
  if (unit.includes('개월') || unit.includes('month')) return now - val * 2592000;
  if (unit.includes('년') || unit.includes('year')) return now - val * 31536000;
  return null;
}

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

function applyTone(embed: EmbedBuilder, tone?: RenderTone): EmbedBuilder {
  const color = toneColor(tone);
  return color == null ? embed : embed.setColor(color);
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
    } else if (part.type === 'info-card') {
      const embed = applyTone(
        new EmbedBuilder()
          .setTitle(truncateTitle(part.title, 256))
          .setDescription(part.body ? truncate(part.body, 3900) : null),
        part.tone ?? 'muel',
      );

      if (part.fields?.length) {
        embed.addFields(part.fields.slice(0, 25).map((field) => ({
          name: truncateTitle(field.name, 256),
          value: truncate(field.value, 1024),
          inline: field.inline ?? false,
        })));
      }
      if (part.footer) embed.setFooter({ text: part.footer.slice(0, 2048) });
      if (part.sourceUrl) embed.setURL(part.sourceUrl);
      embeds.push(embed);
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
      ].filter((value): value is string => Boolean(value));

      const unixTime = parseRelativeTimeToUnix(part.publishedAt || '');
      const timeStr = unixTime ? `<t:${unixTime}:R>` : part.publishedAt;

      const embed = applyTone(
        new EmbedBuilder()
          .setDescription(descriptionParts.join('\n') || null)
          .setFooter({ text: ['YouTube 커뮤니티', part.authorName, timeStr].filter(Boolean).join(' | ').slice(0, 2048) }),
        part.tone,
      );

      if (part.title) embed.setTitle(truncateTitle(part.title, 256));
      if (imageUrl) embed.setImage(imageUrl);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel('원문')
          .setStyle(ButtonStyle.Link)
          .setURL(part.sourceUrl || 'https://youtube.com'),
      );

      embeds.push(embed);
      options.components = [...(options.components || []), row];
    } else if (part.type === 'announcement-card') {
      const embed = applyTone(
        new EmbedBuilder()
          .setDescription(part.body ? truncate(part.body, 3900) : null)
          .setFooter({ text: ['공지', part.author, part.publishedAt].filter(Boolean).join(' | ').slice(0, 2048) }),
        'muel',
      );

      if (part.title) embed.setTitle(truncateTitle(part.title, 256));
      if (part.sourceUrl) embed.setURL(part.sourceUrl);
      if (part.imageUrl) embed.setImage(part.imageUrl);

      embeds.push(embed);
    } else if (part.type === 'release-note-card') {
      const embed = applyTone(
        new EmbedBuilder()
          .setTitle(truncateTitle(`${part.product} ${part.version ? `v${part.version}` : ''} 업데이트`, 256))
          .setDescription(truncate(part.highlights.map((highlight) => `- ${highlight}`).join('\n'), 3900))
          .setFooter({ text: 'Release Note' }),
        'success',
      );

      if (part.sourceUrl) embed.setURL(part.sourceUrl);
      embeds.push(embed);
    } else if (part.type === 'video-card') {
      textContents.push(`**${part.author}** - YouTube ${part.isShorts ? '쇼츠' : '영상'} 업로드\n${part.title}\n${part.url}`);
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
