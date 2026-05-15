import { EmbedBuilder, type MessageCreateOptions } from 'discord.js';

export type MuelDiscordRenderablePart =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'announcement-card';
      title: string;
      subtitle?: string;
      body: string;
      imagePrompt?: string;
      imageUrl?: string;
      sourceUrl?: string;
      author?: string;
      publishedAt?: string;
      actions?: Array<{
        label: string;
        url?: string;
        actionId?: string;
      }>;
    }
  | {
      type: 'release-note-card';
      product: string;
      version?: string;
      highlights: string[];
      sourceUrl?: string;
    }
  | {
      type: 'video-card';
      title: string;
      author: string;
      url: string;
      isShorts?: boolean;
    };

export function renderDiscordMessage(parts: MuelDiscordRenderablePart[]): MessageCreateOptions {
  const options: MessageCreateOptions = {
    content: '',
    embeds: [],
  };

  const textContents: string[] = [];

  for (const part of parts) {
    if (part.type === 'text') {
      textContents.push(part.text);
    } else if (part.type === 'announcement-card') {
      const embed = new EmbedBuilder()
        .setColor(0x2f80ed)
        .setDescription(part.body ? part.body.slice(0, 4000) : null)
        .setFooter({ text: ['공지사항', part.author, part.publishedAt].filter(Boolean).join(' | ').slice(0, 2048) });

      if (part.title) embed.setTitle(part.title.slice(0, 256));
      if (part.sourceUrl) embed.setURL(part.sourceUrl);
      if (part.imageUrl) embed.setImage(part.imageUrl);
      // NOTE: long term, action buttons using Components v2 can be implemented here!
      // if (part.actions) ...

      options.embeds!.push(embed);
    } else if (part.type === 'release-note-card') {
      const embed = new EmbedBuilder()
        .setColor(0x00c853)
        .setTitle(`🚀 ${part.product} ${part.version ? `v${part.version}` : ''} 업데이트`)
        .setDescription(part.highlights.map(h => `• ${h}`).join('\n'))
        .setFooter({ text: 'Release Note' });

      if (part.sourceUrl) embed.setURL(part.sourceUrl);
      options.embeds!.push(embed);
    } else if (part.type === 'video-card') {
      // Just plain text for videos since Discord automatically unfurls YouTube links beautifully
      textContents.push(`📌 **${part.author}** 신규 ${part.isShorts ? '쇼츠' : '영상'} 업로드!\n${part.title}\n${part.url}`);
    }
  }

  if (textContents.length > 0) {
    options.content = textContents.join('\n\n');
  }

  // Fallback if empty
  if (!options.content && options.embeds!.length === 0) {
    options.content = '내용 없음';
  }

  return options;
}
