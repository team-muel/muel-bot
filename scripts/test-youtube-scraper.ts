import { scrapeLatestCommunityPostByInnerTube } from '../src/youtubeCommunityScraper.js';

async function test() {
  // Test with Muel's own channel or a known channel (e.g. YouTube Creators or a random channel with posts)
  // Let's use a popular channel ID, e.g. MrBeast UCX6OQ3DkcsbYNE6H8uQQuVA
  const channelId = 'UCX6OQ3DkcsbYNE6H8uQQuVA';
  console.log(`Testing scraper for channel: ${channelId}`);
  try {
    const post = await scrapeLatestCommunityPostByInnerTube(channelId, 10000);
    console.log('Result:', post);
  } catch (error) {
    console.error('Error:', error);
  }
}

test();
