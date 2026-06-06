import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, type MessageCreateOptions, type APIEmbedField } from 'discord.js';
import type { MuelRenderablePart, RenderTone, CardSection, CardActionButton, CardSelectMenu } from './types.js';

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
  const discordTimestamp = text.trim().match(/^<t:(\d+):[tTdDfFR]>$/);
  if (discordTimestamp?.[1]) {
    return Number(discordTimestamp[1]);
  }
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

function formatUnixAsKoreanRelative(unixTime: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = Math.max(0, now - unixTime);

  if (diff < 60) return '방금 전';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}일 전`;
  if (diff < 2592000) return `${Math.floor(diff / 604800)}주 전`;
  if (diff < 31536000) return `${Math.floor(diff / 2592000)}개월 전`;
  return `${Math.floor(diff / 31536000)}년 전`;
}

function formatPublishedAtForFooter(text: string | undefined): string {
  const raw = text?.trim();
  if (!raw) return '';

  const relativeUnix = parseRelativeTimeToUnix(raw);
  if (relativeUnix) return formatUnixAsKoreanRelative(relativeUnix);

  const parsedMs = Date.parse(raw);
  if (!Number.isNaN(parsedMs)) {
    return formatUnixAsKoreanRelative(Math.floor(parsedMs / 1000));
  }

  return raw.replace(/<t:\d+:[tTdDfFR]>/g, '').trim().slice(0, 80);
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

function sectionsToFields(sections: CardSection[] | undefined): APIEmbedField[] {
  if (!sections || sections.length === 0) return [];
  const MAX_FIELDS = 25;
  const overflow = sections.length > MAX_FIELDS;
  const shown = sections.slice(0, overflow ? MAX_FIELDS - 1 : MAX_FIELDS);
  const fields: APIEmbedField[] = shown.map((section) => ({
    name: truncateTitle(`▼ ${section.header}`, 256),
    value: truncate(section.content, 1024),
    inline: section.inline ?? false,
  }));
  if (overflow) {
    fields.push({ name: '…', value: `(${sections.length - (MAX_FIELDS - 1)}개 섹션이 더 있어)`, inline: false });
  }
  return fields;
}

function extractYouTubeVideoId(url: string | undefined, fallbackId?: string): string | null {
  if (fallbackId) return fallbackId;
  if (!url) return null;
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return match?.[1] ?? null;
}

function actionButtonStyleToDiscord(style: CardActionButton['style']): ButtonStyle {
  switch (style) {
    case 'primary': return ButtonStyle.Primary;
    case 'success': return ButtonStyle.Success;
    case 'danger': return ButtonStyle.Danger;
    case 'secondary':
    default: return ButtonStyle.Secondary;
  }
}

/**
 * Build a row of interactive (custom_id) buttons from CardActionButton list.
 * Discord allows up to 5 buttons per row; returns null if none provided.
 */
function buildActionButtonRow(buttons: CardActionButton[] | undefined): ActionRowBuilder<ButtonBuilder> | null {
  if (!buttons || buttons.length === 0) return null;
  const row = new ActionRowBuilder<ButtonBuilder>();
  for (const btn of buttons.slice(0, 5)) {
    const button = new ButtonBuilder()
      .setLabel(btn.label.slice(0, 80))
      .setStyle(actionButtonStyleToDiscord(btn.style))
      .setCustomId(btn.customId.slice(0, 100));
    if (btn.emoji) button.setEmoji(btn.emoji);
    row.addComponents(button);
  }
  return row;
}

function buildLinkButtonRow(linkButton: { label: string; url: string } | undefined): ActionRowBuilder<ButtonBuilder> | null {
  const url = linkButton?.url?.trim();
  if (!url || !/^https?:\/\//i.test(url) || url.length > 512) return null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel((linkButton?.label || '열기').slice(0, 80))
      .setStyle(ButtonStyle.Link)
      .setURL(url),
  );
}

function buildSelectMenuRow(menu: CardSelectMenu | undefined): ActionRowBuilder<StringSelectMenuBuilder> | null {
  if (!menu || menu.options.length === 0) return null;
  const maxOptions = menu.options.slice(0, 25);
  const select = new StringSelectMenuBuilder()
    .setCustomId(menu.customId.slice(0, 100))
    .setPlaceholder(menu.placeholder.slice(0, 150))
    .setMinValues(menu.minValues ?? 1)
    .setMaxValues(Math.min(menu.maxValues ?? 1, maxOptions.length))
    .addOptions(maxOptions.map((option) => {
      const built = {
        label: option.label.slice(0, 100),
        value: option.value.slice(0, 100),
        description: option.description?.slice(0, 100),
        emoji: option.emoji,
      };
      return built;
    }));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function appendComponentRow(options: MessageCreateOptions, row: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder> | null) {
  if (!row) return;
  if ((options.components?.length ?? 0) >= 5) return;
  options.components = [...(options.components || []), row];
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

      appendComponentRow(options, buildLinkButtonRow(part.linkButton));
      appendComponentRow(options, buildActionButtonRow(part.actionButtons));
      appendComponentRow(options, buildSelectMenuRow(part.selectMenu));
    } else if (part.type === 'youtube-community-post-card') {
      const imageUrl = part.imageUrls?.find((url) => typeof url === 'string' && /^https?:\/\//i.test(url));

      const descriptionLines: string[] = [];
      if (part.subtitle) descriptionLines.push(`**${truncateTitle(part.subtitle, 200)}**`);
      if (part.body) descriptionLines.push(truncate(part.body, imageUrl ? 1400 : 2400));
      const description = descriptionLines.join('\n\n');

      const timeStr = formatPublishedAtForFooter(part.publishedAt);

      const embed = applyTone(
        new EmbedBuilder()
          .setDescription(description || null)
          .setFooter({ text: ['YouTube 커뮤니티', part.authorName, timeStr].filter(Boolean).join(' · ').slice(0, 2048) }),
        part.tone,
      );

      if (part.title) embed.setTitle(truncateTitle(part.title, 256));
      if (part.sourceUrl) embed.setURL(part.sourceUrl);
      if (imageUrl) embed.setImage(imageUrl);

      if (part.highlights?.length) {
        embed.addFields({
          name: '▼ 주요 내용',
          value: truncate(part.highlights.map((h) => `- ${h}`).join('\n'), 1024),
          inline: false,
        });
      }

      // Link button: 원문 보기 (existing behavior)
      const linkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel('원문 보기')
          .setStyle(ButtonStyle.Link)
          .setURL(part.sourceUrl || 'https://youtube.com'),
      );

      embeds.push(embed);
      appendComponentRow(options, linkRow);

      // Action buttons (custom_id, e.g., enrichment trigger) go on a separate row
      // so they don't conflict with the link button. Discord allows up to 5 rows.
      const actionRow = buildActionButtonRow(part.actionButtons);
      appendComponentRow(options, actionRow);
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

      const actionRow = buildActionButtonRow(part.actionButtons);
      appendComponentRow(options, actionRow);
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

      const actionRow = buildActionButtonRow(part.actionButtons);
      appendComponentRow(options, actionRow);
    } else if (part.type === 'video-card') {
      const videoId = extractYouTubeVideoId(part.url, part.videoId);
      const kind = part.isShorts ? '쇼츠' : '영상';
      const timeStr = formatPublishedAtForFooter(part.publishedAt);

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

      const linkRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setLabel('영상 보기')
          .setStyle(ButtonStyle.Link)
          .setURL(part.url),
      );

      embeds.push(embed);
      appendComponentRow(options, linkRow);

      const actionRow = buildActionButtonRow(part.actionButtons);
      appendComponentRow(options, actionRow);
    } else if (part.type === 'rich-card') {
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
        appendComponentRow(options, buildLinkButtonRow(part.linkButton));
      }

      appendComponentRow(options, buildActionButtonRow(part.actionButtons));
      appendComponentRow(options, buildSelectMenuRow(part.selectMenu));
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
