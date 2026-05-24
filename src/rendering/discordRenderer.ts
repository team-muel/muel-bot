import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, type MessageCreateOptions, type APIEmbedField } from 'discord.js';
import type { MuelRenderablePart, RenderTone, CardSection } from './types.js';

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

/**
 * Convert CardSection list into APIEmbedField list with a "▼ " prefix.
 * Discord embeds support up to 25 fields; each name ≤ 256 chars, value ≤ 1024.
 */
function sectionsToFields(sections: CardSection[] | undefined): APIEmbedField[] {
  if (!sections || sections.length === 0) return [];
  return sections.slice(0, 25).map((section) => ({
    name: truncateTitle(`▼ ${section.header}`, 256),
    value: truncate(section.content, 1024),
    inline: section.inline ?? false,
  }));
}

function extractYouTubeVideoId(url: string | undefined, fallbackId?: string): string | null {
  if (fallbackId) return fallbackId;
  if (!url) return null;
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return match?.[1] ?? null;
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

      // Description: subtitle as bold first line (clear visual divider), then body.
      const descriptionLines: string[] = [];
      if (part.subtitle) descriptionLines.push(`**${truncateTitle(part.subtitle, 200)}**`);
      if (part.body) descriptionLines.push(truncate(part.body, imageUrl ? 1400 : 2400));
      const description = descriptionLines.join('\n\n');

      const unixTime = parseRelativeTimeToUnix(part.publishedAt || '');
      const timeStr = unixTime ? `<t:${unixTime}:R>` : part.publishedAt;

      const embed = applyTone(
        new EmbedBuilder()
          .setDescription(description || null)
          .setFooter({ text: ['YouTube 커뮤니티', part.authorName, timeStr].filter(Boolean).join(' · ').slice(0, 2048) }),
        part.tone,
      );

      if (part.title) embed.setTitle(truncateTitle(part.title, 256));
      if (part.sourceUrl) embed.setURL(part.sourceUrl);
      if (imageUrl) embed.setImage(imageUrl);

      // Highlights as a separate field with ▼ prefix — Perlica-style section break.
      if (part.highlights?.length) {
        embed.addFields({
          name: '▼ 주요 내용',
          value: truncate(part.highlights.map((h) => `- ${h}`).join('\n'), 1024),
          inline: false,
        });
      }

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel('원문 보기')
          .setStyle(ButtonStyle.Link)
          .setURL(part.sourceUrl || 'https://youtube.com'),
      );

      embeds.push(embed);
      options.components = [...(options.components || []), row];
    } else if (part.type === 'announcement-card') {
      const embed = applyTone(
        new EmbedBuilder()
          .setDescription(part.body ? truncate(part.body, 3900) : null)
          .setFooter({ text: ['공지', part.author, part.publishedAt].filter(Boolean).join(' · ').slice(0, 2048) }),
        'muel',
      );

      if (part.title) embed.setTitle(truncateTitle(part.title, 256));
      if (part.sourceUrl) embed.setURL(part.sourceUrl);
      if (part.imageUrl) embed.setImage(part.imageUrl);

      const sectionFields = sectionsToFields(part.sections);
      if (sectionFields.length > 0) embed.addFields(sectionFields);

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
      // Upgraded video card: use a proper embed instead of plain text + auto-unfurl.
      // Putting the URL on setURL (not in content) suppresses Discord's auto-unfurl,
      // giving us a single clean embed instead of a duplicated preview.
      const videoId = extractYouTubeVideoId(part.url, part.videoId);
      const kind = part.isShorts ? '쇼츠' : '영상';
      const unixTime = parseRelativeTimeToUnix(part.publishedAt || '');
      const timeStr = unixTime ? `<t:${unixTime}:R>` : part.publishedAt;

      const embed = applyTone(
        new EmbedBuilder()
          .setTitle(truncateTitle(part.title, 256))
          .setURL(part.url)
          .setFooter({ text: ['YouTube', kind, part.author, timeStr].filter(Boolean).join(' · ').slice(0, 2048) }),
        'neutral',
      );
      // Thumbnail per video kind:
      //  - Regular (16:9) → big setImage with hq720.jpg (1280x720, exists for
      //    nearly all videos; cleaner than hqdefault.jpg's 480x360 4:3).
      //  - Shorts (9:16) → small top-right setThumbnail. Letterboxing into the
      //    wide bottom slot showed visible black side bars; the small slot hides
      //    the aspect mismatch and gives body text more room.
      if (videoId) {
        if (part.isShorts) {
          embed.setThumbnail(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`);
        } else {
          embed.setImage(`https://i.ytimg.com/vi/${videoId}/hq720.jpg`);
        }
      }

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel('영상 보기')
          .setStyle(ButtonStyle.Link)
          .setURL(part.url),
      );

      embeds.push(embed);
      options.components = [...(options.components || []), row];
    } else if (part.type === 'rich-card') {
      // The banner image lives in its own image-only embed so the visual lands
      // at the TOP of the message (Discord places setImage() below the body
      // within a single embed). The second embed carries the structured content.
      if (part.bannerImage && /^https?:\/\//i.test(part.bannerImage)) {
        const bannerEmbed = applyTone(new EmbedBuilder().setImage(part.bannerImage), part.tone);
        embeds.push(bannerEmbed);
      }

      const descriptionLines: string[] = [];
      if (part.subtitle) descriptionLines.push(`**${truncateTitle(part.subtitle, 200)}**`);
      if (part.body) descriptionLines.push(truncate(part.body, 3000));
      const description = descriptionLines.join('\n\n');

      const embed = applyTone(new EmbedBuilder(), part.tone);
      if (part.title) embed.setTitle(truncateTitle(part.title, 256));
      if (description) embed.setDescription(description);
      if (part.thumbnail && /^https?:\/\//i.test(part.thumbnail)) embed.setThumbnail(part.thumbnail);
      if (part.sourceUrl) embed.setURL(part.sourceUrl);
      if (part.footer) embed.setFooter({ text: part.footer.slice(0, 2048) });

      const sectionFields = sectionsToFields(part.sections);
      if (sectionFields.length > 0) embed.addFields(sectionFields);

      embeds.push(embed);

      if (part.linkButton?.url) {
        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setLabel(part.linkButton.label.slice(0, 80) || '열기')
            .setStyle(ButtonStyle.Link)
            .setURL(part.linkButton.url),
        );
        options.components = [...(options.components || []), row];
      }
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
