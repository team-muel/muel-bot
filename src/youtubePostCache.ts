/**
 * In-memory cache of recent YouTube community post content.
 * Used to give Muel the ability to answer questions about recent posts
 * (e.g. "오늘 장 어땠어?") using actual post content.
 */

export type CachedPost = {
  id: string;
  title: string;
  content: string;
  author: string;
  link: string;
  published: string;
  cachedAt: number;
};

const MAX_POSTS = 20;
const posts: CachedPost[] = [];

export const cachePost = (post: CachedPost): void => {
  // Avoid duplicates
  const existing = posts.findIndex((p) => p.id === post.id);
  if (existing >= 0) {
    posts[existing] = post;
    return;
  }

  posts.push(post);
  if (posts.length > MAX_POSTS) {
    posts.shift();
  }
};

export const getRecentPosts = (limit = 5): CachedPost[] => {
  return posts.slice(-limit);
};

export const formatPostsForContext = (limit = 3): string => {
  const recent = getRecentPosts(limit);
  if (recent.length === 0) return '';

  const lines = ['--- Recent YouTube Posts ---'];
  for (const post of recent) {
    const contentPreview = post.content.slice(0, 500);
    lines.push(`[${post.author}] ${post.title}`);
    lines.push(contentPreview);
    lines.push('');
  }
  lines.push('--- End Posts ---');
  return lines.join('\n');
};
