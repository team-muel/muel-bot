export type MuelRenderablePart =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'youtube-community-post-card';
      authorName: string;
      body: string;
      sourceUrl: string;
      publishedAt?: string;
      imageUrls?: string[];
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
