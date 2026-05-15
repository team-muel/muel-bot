import 'dotenv/config';
import { editCommunityPost } from '../src/youtubeMonitor.js';

const fixtures = [
  {
    name: '1. 경제 시황 게시글 (Fact-heavy)',
    author: '경제 라이브',
    content: `[미국 증시 요약 | 2026년 05월 15일 (금)]
금일 미국 증시는 하락 마감했습니다.
글로벌 채권 시장의 매도세가 주식 시장 랠리에 제동을 걸었습니다. 10년물 국채금리가 4.5%를 돌파했습니다.
인텔이 6% 넘게 하락했고, AMD와 마이크론은 각각 5.7%, 6.6% 떨어졌습니다.
[경제 지표]
21:30 - 미국 - 5월 엠파이어스테이트 제조업지수 19.6 (예상: 7.2)
금일 장 전 시황 자료 ☞ https://example.com/report`
  },
  {
    name: '2. 게임 공지 게시글 (Update)',
    author: 'Delta-bot',
    content: `WIKI Update: Mobile Interface Now Live!
Endministrators can now easily access WIKI on mobile devices!
Dear Endministrators:
The Arknights: Endfield WIKI mobile interface is now live! You can now easily browse WIKI information on operators, weapons, facilities, and more from your mobile devices.
▼// How to Access the WIKI Mobile Interface
• Open the SKPORT app, enter the Arknights: Endfield section...
• You can also access via link: https://wiki.example.com
If you have any feedback, feel free to leave a message!`
  },
  {
    name: '3. 짧은 잡담 게시글 (No hallucination expected)',
    author: '일상 유튜버',
    content: `여러분 안녕하세요~ 오늘 날씨가 진짜 춥네요 ㅠㅠ 다들 감기 조심하시고 내일 라이브 방송에서 봬요!! (저녁 8시 예상)`
  },
  {
    name: '4. 이벤트 안내 게시글',
    author: '이벤트 매니저',
    content: `🎉 10만 구독자 달성 기념 Q&A 이벤트 🎉
안녕하세요! 채널이 드디어 10만 구독자를 달성했습니다.
감사한 마음을 담아 Q&A 영상을 찍으려고 합니다.
댓글로 저에게 궁금했던 점을 자유롭게 남겨주세요!
- 기한: 5월 20일 자정까지
- 당첨자 5분께는 커피 쿠폰을 드립니다!`
  }
];

async function runTests() {
  console.log('Testing AI Community Post Editor...\n');
  
  for (const fixture of fixtures) {
    console.log(`=========================================`);
    console.log(`[FIXTURE] ${fixture.name}`);
    console.log(`[RAW] length: ${fixture.content.length}`);
    
    const result = await editCommunityPost(fixture.author, fixture.content);
    if (!result) {
      console.log('❌ AI Editor failed to return a result.');
      continue;
    }
    
    const { data, modelId } = result;
    console.log(`[MODEL] ${modelId}`);
    console.log(`[TITLE] ${data.title} (${data.title.length} chars)`);
    if (data.subtitle) console.log(`[SUBTITLE] ${data.subtitle} (${data.subtitle.length} chars)`);
    console.log(`[BODY]\n${data.body}`);
    if (data.highlights && data.highlights.length > 0) {
      console.log(`[HIGHLIGHTS]`);
      data.highlights.forEach(h => console.log(`  • ${h}`));
    }
    console.log('\n');
  }
}

runTests().catch(console.error);
