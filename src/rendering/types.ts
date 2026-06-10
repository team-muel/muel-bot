/**
 * MuelRenderablePart represents the canonical, platform-independent UI state (like AI SDK UIMessage.parts).
 * This structure is the single source of truth. LLMs or Domain Logic (like YouTube Monitor) generate these intents,
 * and platform-specific renderers (Discord, Web React, Slack) transform them into their native UI components.
 *
 * TONE POLICY:
 * - 'muel': Uses Muel's signature brand color (#a2e61d). Only for Muel's own system/status/memory/game UI.
 * - 'neutral': Colorless/unset. Used for external feeds (YouTube, News) to act as a neutral container.
 * - 'warning': For errors or destructive actions.
 */
export type RenderTone = 'muel' | 'neutral' | 'warning' | 'success';

/**
 * A structured section inside a card — rendered as a Discord embed field with a
 * "▼ " prefix on the name to make the visual section break stand out.
 */
export type CardSection = {
  header: string;
  content: string;
  inline?: boolean;
};

/**
 * Interactive (custom_id) action buttons attached to a card. Distinct from
 * the existing per-card link buttons ("원문 보기", "영상 보기" etc.) — these
 * carry a custom_id that an InteractionCreate handler routes to.
 *
 * Convention: customId is `<feature>:<action>:<...args>`. Example:
 *   research:enrich:youtube_post:Ug...   → triggers AI-Q enrichment for that post.
 */
export type CardActionButton = {
  label: string;
  customId: string;
  style?: 'primary' | 'secondary' | 'success' | 'danger';
  emoji?: string;
};

export type CardSelectMenu = {
  customId: string;
  placeholder: string;
  minValues?: number;
  maxValues?: number;
  options: Array<{
    label: string;
    value: string;
    description?: string;
    emoji?: string;
  }>;
};

export type MuelRenderablePart =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'info-card';
      tone?: RenderTone;
      title: string;
      body?: string;
      fields?: Array<{
        name: string;
        value: string;
        inline?: boolean;
      }>;
      footer?: string;
      sourceUrl?: string;
      linkButton?: { label: string; url: string };
      actionButtons?: CardActionButton[];
      selectMenu?: CardSelectMenu;
    }
  | {
      type: 'youtube-community-post-card';
      id?: string;
      tone?: RenderTone;
      title?: string;
      subtitle?: string;
      authorName: string;
      body: string;
      highlights?: string[];
      sourceUrl: string;
      publishedAt?: string;
      imageUrls?: string[];
      metadata?: {
        editor: 'ai' | 'heuristic';
        editorModel?: string;
        editedAt?: string;
      };
      actionButtons?: CardActionButton[];
    }
  | {
      type: 'announcement-card';
      title: string;
      body: string;
      sourceUrl?: string;
      imageUrl?: string;
      author?: string;
      publishedAt?: string;
      sections?: CardSection[];
      actionButtons?: CardActionButton[];
    }
  | {
      type: 'release-note-card';
      product: string;
      version?: string;
      highlights: string[];
      sourceUrl?: string;
      actionButtons?: CardActionButton[];
    }
  | {
      type: 'video-card';
      title: string;
      author: string;
      url: string;
      isShorts?: boolean;
      videoId?: string;
      publishedAt?: string;
      actionButtons?: CardActionButton[];
    }
  | {
      type: 'rich-card';
      tone?: RenderTone;
      bannerImage?: string;
      thumbnail?: string;
      title?: string;
      subtitle?: string;
      body?: string;
      sections?: CardSection[];
      footer?: string;
      sourceUrl?: string;
      linkButton?: { label: string; url: string };
      actionButtons?: CardActionButton[];
      selectMenu?: CardSelectMenu;
    };
