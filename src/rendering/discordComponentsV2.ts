import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  FileBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  type MessageCreateOptions,
} from 'discord.js';
import { MUEL_BRAND_COLOR, MUEL_SUCCESS_COLOR, MUEL_WARN_COLOR } from '../uiColors.js';
import { DISCORD_LIMITS, DISCORD_SAFE, truncateDiscordText } from './discordLimits.js';
import {
  extractYouTubeVideoId,
  formatPublishedAtForFooter,
  renderDiscordMessage,
} from './discordRenderer.js';
import type {
  CardActionButton,
  CardSelectMenu,
  MuelRenderablePart,
  RenderTone,
} from './types.js';

const V2_TOTAL_COMPONENT_LIMIT = 40;
const V2_TEXT_LIMIT = 3_900;
const V2_SECTION_LIMIT = 12;

export type DiscordComponentsV2Options = {
  files?: AttachmentBuilder[];
};

const toneColor = (tone?: RenderTone): number | null => {
  if (tone === 'muel') return MUEL_BRAND_COLOR;
  if (tone === 'warning') return MUEL_WARN_COLOR;
  if (tone === 'success') return MUEL_SUCCESS_COLOR;
  return null;
};

const setContainerTone = (container: ContainerBuilder, tone?: RenderTone): ContainerBuilder => {
  const color = toneColor(tone);
  return color == null ? container : container.setAccentColor(color);
};

const heading = (text: string | undefined, level = 2): TextDisplayBuilder | null => {
  const value = text?.trim();
  if (!value) return null;
  return new TextDisplayBuilder().setContent(
    `${'#'.repeat(level)} ${truncateDiscordText(value, 240)}`,
  );
};

const textDisplay = (text: string | undefined, max = V2_TEXT_LIMIT): TextDisplayBuilder | null => {
  const value = text?.trim();
  if (!value) return null;
  return new TextDisplayBuilder().setContent(truncateDiscordText(value, max));
};

const metadataDisplay = (parts: Array<string | undefined>): TextDisplayBuilder | null => {
  const value = parts.map((part) => part?.trim()).filter(Boolean).join(' · ');
  return value ? new TextDisplayBuilder().setContent(`-# ${truncateDiscordText(value, 500)}`) : null;
};

const addText = (
  container: ContainerBuilder,
  component: TextDisplayBuilder | null,
): void => {
  if (component) container.addTextDisplayComponents(component);
};

const addSeparator = (container: ContainerBuilder): void => {
  container.addSeparatorComponents(
    new SeparatorBuilder()
      .setDivider(true)
      .setSpacing(SeparatorSpacingSize.Small),
  );
};

const buttonStyle = (style: CardActionButton['style']): ButtonStyle => {
  if (style === 'primary') return ButtonStyle.Primary;
  if (style === 'success') return ButtonStyle.Success;
  if (style === 'danger') return ButtonStyle.Danger;
  return ButtonStyle.Secondary;
};

const buildButtonRow = (
  linkButton: { label: string; url: string } | undefined,
  actionButtons: CardActionButton[] | undefined,
): ActionRowBuilder<ButtonBuilder> | null => {
  const row = new ActionRowBuilder<ButtonBuilder>();
  const url = linkButton?.url?.trim();
  if (url && /^https?:\/\//i.test(url) && url.length <= DISCORD_LIMITS.url) {
    row.addComponents(
      new ButtonBuilder()
        .setLabel((linkButton?.label || '열기').slice(0, DISCORD_LIMITS.buttonLabel))
        .setStyle(ButtonStyle.Link)
        .setURL(url),
    );
  }

  const remaining = DISCORD_LIMITS.buttonsPerRow - row.components.length;
  for (const action of (actionButtons ?? []).slice(0, Math.max(0, remaining))) {
    const button = new ButtonBuilder()
      .setLabel(action.label.slice(0, DISCORD_LIMITS.buttonLabel))
      .setStyle(buttonStyle(action.style))
      .setCustomId(action.customId.slice(0, DISCORD_LIMITS.customId));
    if (action.emoji) button.setEmoji(action.emoji);
    row.addComponents(button);
  }

  return row.components.length > 0 ? row : null;
};

const buildSelectRow = (
  menu: CardSelectMenu | undefined,
): ActionRowBuilder<StringSelectMenuBuilder> | null => {
  if (!menu || menu.options.length === 0) return null;
  const options = menu.options.slice(0, DISCORD_LIMITS.selectOptions);
  const select = new StringSelectMenuBuilder()
    .setCustomId(menu.customId.slice(0, DISCORD_LIMITS.customId))
    .setPlaceholder(menu.placeholder.slice(0, DISCORD_LIMITS.selectPlaceholder))
    .setMinValues(menu.minValues ?? 1)
    .setMaxValues(Math.min(menu.maxValues ?? 1, options.length))
    .addOptions(options.map((option) => ({
      label: option.label.slice(0, DISCORD_LIMITS.selectOptionLabel),
      value: option.value.slice(0, DISCORD_LIMITS.selectOptionValue),
      description: option.description?.slice(0, DISCORD_LIMITS.selectOptionDescription),
      emoji: option.emoji,
    })));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
};

const addControls = (
  container: ContainerBuilder,
  args: {
    linkButton?: { label: string; url: string };
    actionButtons?: CardActionButton[];
    selectMenu?: CardSelectMenu;
  },
): void => {
  const buttons = buildButtonRow(args.linkButton, args.actionButtons);
  if (buttons) container.addActionRowComponents(buttons);
  const select = buildSelectRow(args.selectMenu);
  if (select) container.addActionRowComponents(select);
};

const addImageGallery = (
  container: ContainerBuilder,
  urls: Array<string | undefined>,
  description: string,
): void => {
  const valid = urls
    .filter((url): url is string => typeof url === 'string' && /^https?:\/\//i.test(url))
    .slice(0, 10);
  if (valid.length === 0) return;
  const gallery = new MediaGalleryBuilder();
  gallery.addItems(valid.map((url) =>
    new MediaGalleryItemBuilder()
      .setURL(url)
      .setDescription(truncateDiscordText(description || '첨부 이미지', 1_024)),
  ));
  container.addMediaGalleryComponents(gallery);
};

const addNamedSections = (
  container: ContainerBuilder,
  sections: Array<{ header: string; content: string }> | undefined,
): void => {
  for (const section of (sections ?? []).slice(0, V2_SECTION_LIMIT)) {
    addSeparator(container);
    addText(
      container,
      textDisplay(`### ${truncateDiscordText(section.header, 240)}\n${section.content}`),
    );
  }
};

const renderCard = (part: Exclude<MuelRenderablePart, { type: 'text' }>): ContainerBuilder => {
  const container = new ContainerBuilder();

  if (part.type === 'info-card') {
    setContainerTone(container, part.tone ?? 'muel');
    addText(container, heading(part.title));
    addText(container, textDisplay(part.body, DISCORD_SAFE.infoDescription));
    addNamedSections(
      container,
      part.fields?.map((field) => ({ header: field.name, content: field.value })),
    );
    addText(container, metadataDisplay([part.footer]));
    addControls(container, part);
    return container;
  }

  if (part.type === 'youtube-community-post-card') {
    setContainerTone(container, part.tone);
    addText(container, heading(part.title || part.subtitle || `${part.authorName} 커뮤니티`));
    addText(container, metadataDisplay([
      'YouTube 커뮤니티',
      part.authorName,
      formatPublishedAtForFooter(part.publishedAt),
    ]));
    addSeparator(container);
    addText(container, textDisplay(part.body, DISCORD_SAFE.communityBodyNoImage));
    addImageGallery(
      container,
      part.imageUrls ?? [],
      `${part.authorName} YouTube 커뮤니티 이미지`,
    );
    if (part.highlights?.length) {
      addText(
        container,
        textDisplay(`### 주요 내용\n${part.highlights.map((item) => `- ${item}`).join('\n')}`),
      );
    }
    addControls(container, {
      linkButton: { label: '원문 보기', url: part.sourceUrl },
      actionButtons: part.actionButtons,
    });
    return container;
  }

  if (part.type === 'announcement-card') {
    setContainerTone(container, 'muel');
    addText(container, heading(part.title));
    addText(container, metadataDisplay(['공지', part.author, part.publishedAt]));
    addSeparator(container);
    addText(container, textDisplay(part.body, DISCORD_SAFE.infoDescription));
    addImageGallery(container, [part.imageUrl], `${part.title} 이미지`);
    addNamedSections(container, part.sections);
    addControls(container, {
      linkButton: part.sourceUrl ? { label: '원문 보기', url: part.sourceUrl } : undefined,
      actionButtons: part.actionButtons,
    });
    return container;
  }

  if (part.type === 'release-note-card') {
    setContainerTone(container, 'success');
    addText(container, heading(`${part.product}${part.version ? ` v${part.version}` : ''} 업데이트`));
    addSeparator(container);
    addText(container, textDisplay(part.highlights.map((item) => `- ${item}`).join('\n')));
    addText(container, metadataDisplay(['Release Note']));
    addControls(container, {
      linkButton: part.sourceUrl ? { label: '변경사항 보기', url: part.sourceUrl } : undefined,
      actionButtons: part.actionButtons,
    });
    return container;
  }

  if (part.type === 'video-card') {
    const videoId = extractYouTubeVideoId(part.url, part.videoId);
    const section = new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(
          `## ${truncateDiscordText(part.title, 240)}\n-# ${[
            'YouTube',
            part.isShorts ? '쇼츠' : '영상',
            part.author,
            formatPublishedAtForFooter(part.publishedAt),
          ].filter(Boolean).join(' · ')}`,
        ),
      );
    if (videoId) {
      section.setThumbnailAccessory(
        new ThumbnailBuilder()
          .setURL(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`)
          .setDescription(`${part.title} 썸네일`),
      );
    } else {
      section.setButtonAccessory(
        new ButtonBuilder()
          .setLabel('영상 보기')
          .setStyle(ButtonStyle.Link)
          .setURL(part.url),
      );
    }
    container.addSectionComponents(section);
    addControls(container, {
      linkButton: videoId ? { label: '영상 보기', url: part.url } : undefined,
      actionButtons: part.actionButtons,
    });
    return container;
  }

  setContainerTone(container, part.tone);
  if (part.thumbnail && /^https?:\/\//i.test(part.thumbnail) && part.title) {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `## ${truncateDiscordText(part.title, 240)}${part.subtitle ? `\n**${truncateDiscordText(part.subtitle, 200)}**` : ''}`,
          ),
        )
        .setThumbnailAccessory(
          new ThumbnailBuilder()
            .setURL(part.thumbnail)
            .setDescription(`${part.title} 썸네일`),
        ),
    );
  } else {
    addText(container, heading(part.title));
    addText(container, textDisplay(part.subtitle ? `**${part.subtitle}**` : undefined, 300));
  }
  addImageGallery(container, [part.bannerImage], `${part.title || 'Muel'} 배너`);
  addText(container, textDisplay(part.body, DISCORD_SAFE.richDescription));
  addNamedSections(container, part.sections);
  addText(container, metadataDisplay([part.footer]));
  addControls(container, part);
  return container;
};

const countComponents = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countComponents(item), 0);
  if (!value || typeof value !== 'object') return 0;
  const record = value as Record<string, unknown>;
  let count = typeof record.type === 'number' ? 1 : 0;
  count += countComponents(record.components);
  count += countComponents(record.accessory);
  count += countComponents(record.component);
  return count;
};

/**
 * Render a fresh Discord message using Components V2.
 *
 * This function deliberately has no legacy fallback after an API send. It
 * validates and serializes the complete payload before returning, so callers
 * can safely fall back before any message exists without risking duplicates.
 */
export const renderDiscordComponentsV2 = (
  parts: MuelRenderablePart[],
  options: DiscordComponentsV2Options = {},
): MessageCreateOptions => {
  const components: Array<ContainerBuilder | TextDisplayBuilder> = [];
  for (const part of parts) {
    if (part.type === 'text') {
      const display = textDisplay(part.text);
      if (display) components.push(display);
    } else {
      components.push(renderCard(part));
    }
  }

  const files = options.files ?? [];
  if (files.length > 0) {
    const container = [...components].reverse().find(
      (component): component is ContainerBuilder => component instanceof ContainerBuilder,
    ) ?? new ContainerBuilder();
    if (!components.includes(container)) components.push(container);
    for (const file of files) {
      if (!file.name) throw new Error('Components V2 files require an explicit attachment name');
      container.addFileComponents(
        new FileBuilder()
          .setURL(`attachment://${file.name}`)
          .setSpoiler(file.spoiler),
      );
    }
  }

  if (components.length === 0) {
    components.push(new TextDisplayBuilder().setContent('내용 없음'));
  }

  // toJSON validates every builder before a send is attempted.
  const serialized = components.map((component) => component.toJSON());
  const total = countComponents(serialized);
  if (total > V2_TOTAL_COMPONENT_LIMIT) {
    throw new Error(`Components V2 payload exceeds ${V2_TOTAL_COMPONENT_LIMIT} components (${total})`);
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components,
    files,
    allowedMentions: {
      parse: [],
      repliedUser: false,
    },
  };
};

export const renderDiscordComponentsV2WithFallback = (
  parts: MuelRenderablePart[],
  options: DiscordComponentsV2Options = {},
): MessageCreateOptions => {
  try {
    return renderDiscordComponentsV2(parts, options);
  } catch (error) {
    console.warn('[discord] Components V2 render failed; using legacy renderer', error);
    const legacy = renderDiscordMessage(parts);
    if (options.files?.length) legacy.files = options.files;
    return legacy;
  }
};
