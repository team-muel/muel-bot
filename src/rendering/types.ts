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
export type RenderTone = 'muel' | 'neutral' | 'warning' | 'success' | 'game';

export type MuelRenderablePart =
  | {
      type: 'text';
      text: string;
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
    }
  | {
      type: 'announcement-card';
      title: string;
      body: string;
      sourceUrl?: string;
      imageUrl?: string;
      author?: string;
      publishedAt?: string;
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
