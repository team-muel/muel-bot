import 'dotenv/config';
import { editCommunityPost } from '../src/youtubeMonitor.js';

type Fixture = {
  name: string;
  author: string;
  content: string;
  mustPreserve: string[];
};

const fixtures: Fixture[] = [
  {
    name: 'economy facts',
    author: 'Market Desk',
    content: `US market recap | 2026-05-15
The S&P 500 fell 1.2% and the Nasdaq Composite fell 1.8%.
The 10-year Treasury yield moved above 4.5%.
NVIDIA closed down 6%, while AMD and Microsoft fell 5.7% and 6.6%.
21:30 - US Philadelphia Fed Manufacturing Index: 19.6 (expected: 7.2)
Source: https://example.com/report`,
    mustPreserve: ['2026-05-15', '1.2%', '1.8%', '4.5%', 'NVIDIA', 'AMD', 'Microsoft', '19.6', '7.2', 'https://example.com/report'],
  },
  {
    name: 'game update notice',
    author: 'Delta-bot',
    content: `WIKI Update: Mobile Interface Now Live!
Endministrators can now access WIKI on mobile devices.
The Arknights: Endfield WIKI mobile interface is now live.
Open the SKPORT app, enter the Arknights: Endfield section, or visit https://wiki.example.com.`,
    mustPreserve: ['WIKI', 'Arknights: Endfield', 'SKPORT', 'https://wiki.example.com'],
  },
  {
    name: 'short casual post',
    author: 'Daily Streamer',
    content: `Hello everyone. Today's weather is cold, so take care and see you on the 8 PM live stream!`,
    mustPreserve: ['8 PM'],
  },
  {
    name: 'event notice',
    author: 'Event Manager',
    content: `100,000 subscriber Q&A event
Thank you for helping the channel reach 100,000 subscribers.
Deadline: May 20 midnight.
Prize: coffee coupons for 5 people.`,
    mustPreserve: ['100,000', 'May 20', '5'],
  },
];

const combinedOutput = (result: Awaited<ReturnType<typeof editCommunityPost>>): string => {
  if (!result) return '';
  return [
    result.data.title,
    result.data.subtitle ?? '',
    result.data.body,
    ...(result.data.highlights ?? []),
  ].join('\n');
};

async function runTests() {
  console.log('Testing AI community post editor fixtures...');

  let skipped = 0;
  for (const fixture of fixtures) {
    const result = await editCommunityPost(fixture.author, fixture.content);
    if (!result) {
      skipped += 1;
      console.log(`SKIP ${fixture.name}: no AI model configured or editor failed`);
      continue;
    }

    const output = combinedOutput(result);
    for (const token of fixture.mustPreserve) {
      if (!output.includes(token)) {
        throw new Error(`${fixture.name}: expected edited output to preserve "${token}"`);
      }
    }

    if (result.data.title.length > 80) {
      throw new Error(`${fixture.name}: title is too long (${result.data.title.length})`);
    }

    console.log(`PASS ${fixture.name}`);
  }

  if (skipped === fixtures.length) {
    console.log('All editor fixtures skipped because no AI editor was available.');
  }
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
