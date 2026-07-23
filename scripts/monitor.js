import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEEN_FILE = path.resolve(__dirname, '..', 'seen_posts.json');
const FILTER_FILE = path.resolve(__dirname, '..', 'filter_config.json');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BOARDS = [
  { name: '산악완성차 중고장터', url: 'http://www.bikesell.co.kr/m/m_board.asp?board=sub01' },
  { name: '산악프레임 중고장터', url: 'http://www.bikesell.co.kr/m/m_board.asp?board=sub02' },
  { name: '산악 샥포크 중고장터', url: 'http://www.bikesell.co.kr/m/m_board.asp?board=sub03' },
  { name: '산악부속 중고장터', url: 'http://www.bikesell.co.kr/m/m_board.asp?board=sub04' },
  { name: '전기자전거 부품장터', url: 'http://www.bikesell.co.kr/m/m_board.asp?board=pas02' },
  { name: '전기자전거 완성차장터', url: 'http://www.bikesell.co.kr/m/m_board.asp?board=pas01' },
  { name: '미니벨로 완성차장터', url: 'http://www.bikesell.co.kr/m/m_board.asp?board=sub08' },
  { name: '미니벨로 부품장터', url: 'http://www.bikesell.co.kr/m/m_board.asp?board=sub09' }
];

function loadLastSeenIds() {
  if (fs.existsSync(SEEN_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
      if (Array.isArray(data)) return {};
      return data;
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveLastSeenIds(lastSeenIds) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(lastSeenIds, null, 2), 'utf8');
}

function loadFilterConfig() {
  if (fs.existsSync(FILTER_FILE)) {
    try {
      const raw = fs.readFileSync(FILTER_FILE, 'utf8');
      const config = JSON.parse(raw);
      console.log(`[SYSTEM] 필터 로드 완료 (키워드: ${config.KEYWORDS?.length || 0}개, 작성자: ${config.WRITERS?.length || 0}명)`);
      return {
        KEYWORDS: config.KEYWORDS || [],
        WRITERS: config.WRITERS || []
      };
    } catch (e) {
      console.error('[ERROR] filter_config.json 읽기 오류:', e.message);
    }
  }
  return { KEYWORDS: [], WRITERS: [] };
}

function sendTelegramMessage(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[TELEGRAM SKIPPED] 토큰 또는 Chat ID 미설정');
    console.log(text);
    return;
  }

  const payload = JSON.stringify({
    chat_id: TELEGRAM_CHAT_ID,
    text: text,
    disable_web_page_preview: true
  });

  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${TELEGRAM_TOKEN}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  const req = https.request(options, () => {});
  req.on('error', (e) => console.error('[TELEGRAM ERROR]', e.message));
  req.write(payload);
  req.end();
}

async function run() {
  console.log('====================================================');
  console.log('[START] 바이크셀 8개 통합 장터 구동 엔진 (게시글 ID 기준)');
  console.log('====================================================');

  const lastSeenIds = loadLastSeenIds();
  const filterConfig = loadFilterConfig();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  let totalMatchedPosts = [];

  for (const board of BOARDS) {
    console.log(`\n[진입] ${board.name} 데이터 수집 중...`);
    const lastId = lastSeenIds[board.name] || 0;

    try {
      // networkidle 대기로 완전한 DOM 구성 확보
      await page.goto(board.url, { waitUntil: 'networkidle', timeout: 30000 });

      // 범용 파싱 알고리즘
      const posts = await page.evaluate(() => {
        const results = [];
        const seenCodes = new Set();

        // 모든 a 태그 및 onclick 속성 요소 탐색
        const elements = Array.from(document.querySelectorAll('a, [onclick]'));

        elements.forEach(el => {
          const href = el.getAttribute('href') || '';
          const onclick = el.getAttribute('onclick') || '';
          const combinedTarget = href + ' ' + onclick;

          // code=숫자 패턴 정규식 추출
          const match = combinedTarget.match(/code=(\d+)/i);
          if (!match) return;

          const id = parseInt(match[1], 10);
          if (seenCodes.has(id)) return;

          const title = el.innerText.replace(/\s+/g, ' ').trim();
          if (!title || title.length < 2) return;

          seenCodes.add(id);

          // 부모 컨테이너 탐색을 통한 작성자 정제
          const parent = el.closest('tr, li, div, td');
          let writer = '';
          if (parent) {
            const writerNode = parent.querySelector('.writer, .author, font, td:nth-child(3)');
            if (writerNode) {
              writer = writerNode.innerText.trim();
            }
          }

          results.push({ id, title, writer });
        });

        return results;
      });

      if (posts.length === 0) {
        console.log(`└ [수집 실패] ${board.name} -> DOM 파싱된 게시글 없음`);
        continue;
      }

      const maxFetchedId = Math.max(...posts.map(p => p.id));
      console.log(`└ [파싱 완료] ${board.name} -> 수집 ${posts.length}개 / 최신글 ID: ${maxFetchedId} (이전 탐색 ID: ${lastId})`);

      // 신규 게시글 선별
      const newPosts = posts.filter(p => p.id > lastId);

      if (newPosts.length > 0) {
        console.log(`  └ 🆕 신규 게시글 ${newPosts.length}건 감지! 필터 대조를 진행합니다.`);

        newPosts.forEach(post => {
          const matchedKeyword = filterConfig.KEYWORDS.find(kw => 
            post.title.toLowerCase().includes(kw.toLowerCase())
          );
          const matchedWriter = filterConfig.WRITERS.find(wr => 
            wr && post.writer.toLowerCase().includes(wr.toLowerCase())
          );

          if (matchedKeyword || matchedWriter) {
            const matchReason = [
              matchedKeyword ? `키워드 [${matchedKeyword}]` : '',
              matchedWriter ? `작성자 [${matchedWriter}]` : ''
            ].filter(Boolean).join(' / ');

            totalMatchedPosts.push({
              boardName: board.name,
              id: post.id,
              title: post.title,
              writer: post.writer,
              reason: matchReason,
              url: `http://www.bikesell.co.kr/m/m_board_view.asp?code=${post.id}`
            });
          }
        });

        lastSeenIds[board.name] = maxFetchedId;
      } else {
        console.log(`  └ [변동 없음] 신규 게시글이 없습니다.`);
        if (!lastSeenIds[board.name]) {
          lastSeenIds[board.name] = maxFetchedId;
        }
      }

    } catch (err) {
      console.error(`└ [실패] ${board.name} 연결 오류:`, err.message);
    }
  }

  await browser.close();

  saveLastSeenIds(lastSeenIds);

  if (totalMatchedPosts.length > 0) {
    console.log(`\n[알림 발송] 총 ${totalMatchedPosts.length}건의 매칭 매물을 전송합니다.`);

    let message = `✨ [바이크셀 필터 매칭 알림] 총 ${totalMatchedPosts.length}건\n━━━━━━━━━━━━━━━━━━\n\n`;
    totalMatchedPosts.forEach((item, index) => {
      message += `${index + 1}. [${item.boardName}] ${item.title}\n`;
      if (item.writer) message += `👤 작성자: ${item.writer}\n`;
      message += `🛠️ 매칭 조건: ${item.reason}\n`;
      message += `🔗 링크: ${item.url}\n\n`;
    });
    message += `━━━━━━━━━━━━━━━━━━`;

    sendTelegramMessage(message);
  } else {
    console.log('\n[INFO] 매칭된 신규 매물이 없습니다. 프로세스를 종료합니다.');
  }
}

run();
