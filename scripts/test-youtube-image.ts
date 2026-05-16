import { scrapeLatestCommunityPostByInnerTube } from '../src/youtubeCommunityScraper.js';
import { fetchWithTimeout } from '../src/utils/network.js';

// Re-implement the extraction locally to dump the raw JSON tree
const INNERTUBE_BROWSE_URL = 'https://www.youtube.com/youtubei/v1/browse';
const INNERTUBE_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'X-YouTube-Client-Name': '1',
  'X-YouTube-Client-Version': '2.20260401.00.00',
};
const buildInnerTubeContext = () => ({
  client: { clientName: 'WEB', clientVersion: '2.20260401.00.00', hl: 'ko', gl: 'KR' },
});

async function test() {
  const channelId = 'UCXmF_v24-yU23B2zR3e-q7g'; // Example channel: BZCF or some other channel. Let's use Arknights Endfield if we know it, or just use MKBHD UCBJycsmduvYEL83R_U4JriQ
  // Let's try BZCF channel if we know its ID. But any channel with posts works.
  // Actually, we can just use BZCF id if we have it. Or use a known one. Let's use UCX6OQ3DkcsbYNE6H8uQQuVA (MrBeast)
  const id = 'UCX6OQ3DkcsbYNE6H8uQQuVA'; // MrBeast
  const res1 = await fetchWithTimeout(`${INNERTUBE_BROWSE_URL}?prettyPrint=false`, {
    method: 'POST', headers: INNERTUBE_HEADERS, body: JSON.stringify({ context: buildInnerTubeContext(), browseId: id })
  }, 10000);
  const data1 = await res1.json() as any;
  const tabs = data1.contents?.twoColumnBrowseResultsRenderer?.tabs;
  let params = null;
  for (const tab of tabs || []) {
    const url = tab.tabRenderer?.endpoint?.commandMetadata?.webCommandMetadata?.url;
    if (url && (url.includes('/posts') || url.includes('/community'))) {
      params = tab.tabRenderer.endpoint.browseEndpoint.params;
    }
  }
  
  if (!params) return console.log('No community tab');
  
  const res2 = await fetchWithTimeout(`${INNERTUBE_BROWSE_URL}?prettyPrint=false`, {
    method: 'POST', headers: INNERTUBE_HEADERS, body: JSON.stringify({ context: buildInnerTubeContext(), browseId: id, params })
  }, 10000);
  const data2 = await res2.json() as any;
  
  // Find backstagePostRenderer
  let found: any = null;
  const visit = (node: any) => {
    if (found || !node || typeof node !== 'object') return;
    if (node.backstagePostRenderer) { found = node.backstagePostRenderer; return; }
    Object.values(node).forEach(visit);
  };
  visit(data2);
  
  if (found) {
    console.log('Attachment Keys:', found.backstageAttachment ? Object.keys(found.backstageAttachment) : 'No attachment');
    if (found.backstageAttachment?.backstageImageRenderer) {
       console.log('Image:', JSON.stringify(found.backstageAttachment.backstageImageRenderer.image, null, 2));
    } else if (found.backstageAttachment?.postMultiImageRenderer) {
       console.log('MultiImage:', JSON.stringify(found.backstageAttachment.postMultiImageRenderer.images[0], null, 2));
    } else {
       console.log('Attachment:', JSON.stringify(found.backstageAttachment, null, 2));
    }
  } else {
    console.log('No post found');
  }
}
test();
