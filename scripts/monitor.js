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

// 기존 탐색 기록 로드 (Set으로 중복 관리)
function loadSeenPosts() {
  if (fs.existsSync(SEEN_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
      if (Array.isArray(data)) {
        console.log(`[SYSTEM] 기존 탐색 기록 ${data.length}개 로드 완료 (${SEEN_FILE})`);
        return new Set(data);
      }
    } catch (e) {
      console.error('[WARN] seen_posts.json 읽기 오류. 새로 생성합니다.');
    }
  }
  return new Set();
}

// 탐색 기록 저장
function saveSeenPosts(seenSet) {
  const data = Array.from(seenSet);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// 필터 설정 로드
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

// 텔레그램 알림 전송
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
  console.log('[START] 바이크셀 8개 통합 장터 구동 엔진');
  console.log('====================================================');

  const seenPosts = loadSeenPosts();
  const filterConfig = loadFilterConfig();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });
  const page = await context.newPage();

  let matchedPosts = [];

  for (const board of BOARDS) {
    console.log(`\n[진입] ${board.name} 데이터 수집 중...`);

    try {
      await page.goto(board.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      const posts = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tr, ul li, .board_list tr'));
        const results = [];

        rows.forEach(row => {
          const linkEl = row.querySelector('a[href*="code="], a[href*="board="]');
          if (!linkEl) return;

          const href = linkEl.getAttribute('href') || '';
          const match = href.match(/code=(\d+)/);
          if (!match) return;

          const id = match[1];
          const title = linkEl.innerText.trim();

          const writerEl = row.querySelector('.writer, .author, td:nth-child(3)');
          const writer = writerEl ? writerEl.innerText.trim() : '';

          if (id && title) {
            results.push({ id, title, writer, href });
          }
        });

        return results;
      });

      console.log(`└ [파싱 완료] ${board.name} -> 총 ${posts.length}개 매물 정제 완료`);

      posts.forEach(post => {
        // 이미 확인한 게시물이면 스킵
        if (seenPosts.has(post.id)) return;

        // 새 매물이면 탐색 기록에 추가
        seenPosts.add(post.id);

        // 키워드 및 작성자 필터링
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

          matchedPosts.push({
            boardName: board.name,
            id: post.id,
            title: post.title,
            writer: post.writer,
            reason: matchReason,
            url: `http://www.bikesell.co.kr/m/m_board_view.asp?code=${post.id}`
          });
        }
      });

    } catch (err) {
      console.error(`└ [실패] 연결 오류:`, err.message);
    }
  }

  await browser.close();

  // 탐색된 전체 기록 파일 저장
  saveSeenPosts(seenPosts);

  if (matchedPosts.length > 0) {
    console.log(`\n[알림 발송] 총 ${matchedPosts.length}건의 매칭 매물을 전송합니다.`);

    let message = `✨ [바이크셀 필터 매칭 알림] 총 ${matchedPosts.length}건\n━━━━━━━━━━━━━━━━━━\n\n`;
    matchedPosts.forEach((item, index) => {
      message += `${index + 1}. [${item.boardName}] ${item.title}\n`;
      if (item.writer) message += `👤 작성자: ${item.writer}\n`;
      message += `🛠️ 매칭 조건: ${item.reason}\n`;
      message += `🔗 링크: ${item.url}\n\n`;
    });
    message += `━━━━━━━━━━━━━━━━━━`;

    sendTelegramMessage(message);
  } else {
    console.log('\n[INFO] 변동 사항 및 새 글이 없습니다. 프로세스를 종료합니다.');
  }
}

run();
