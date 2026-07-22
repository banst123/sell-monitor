import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

// ==========================================
// ESM 환경 내 __dirname 및 경로 설정
// ==========================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEEN_FILE = path.resolve(__dirname, '..', 'seen_posts.json');
const FILTER_FILE = path.resolve(__dirname, '..', 'filter_config.json');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// 모니터링 대상 8개 장터 목록
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

// ==========================================
// Helper 함수
// ==========================================

// 1. 게시판별 최신 ID 기록 로드
function loadLastSeenIds() {
  if (fs.existsSync(SEEN_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
      if (Array.isArray(data)) {
        console.log('[SYSTEM] 기존 구 버전 배열 형태 데이터를 객체 포맷으로 전환합니다.');
        return {};
      }
      return data;
    } catch (e) {
      console.error('[WARN] seen_posts.json 파싱 실패. 초기화합니다.');
      return {};
    }
  }
  return {};
}

// 2. 최신 ID 기록 저장
function saveLastSeenIds(lastSeenIds) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(lastSeenIds, null, 2), 'utf8');
}

// 3. 필터 설정(키워드/작성자) 로드
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
  } else {
    console.log('[WARN] filter_config.json 파일이 존재하지 않습니다.');
  }
  return { KEYWORDS: [], WRITERS: [] };
}

// 4. 텔레그램 메시지 전송
function sendTelegramMessage(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('[TELEGRAM SKIPPED] 토큰 또는 Chat ID가 설정되지 않았습니다.');
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

  const req = https.request(options, (res) => {
    res.on('data', () => {});
  });
  req.on('error', (e) => console.error('[TELEGRAM ERROR]', e.message));
  req.write(payload);
  req.end();
}

// ==========================================
// 메인 구동 엔진
// ==========================================
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
      await page.goto(board.url, { waitUntil: 'domcontentloaded', timeout: 30000 });

      // 파싱: 게시글 목록 수집
      const posts = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tr, ul li, .board_list tr'));
        const results = [];

        rows.forEach(row => {
          const linkEl = row.querySelector('a[href*="code="], a[href*="board="]');
          if (!linkEl) return;

          const href = linkEl.getAttribute('href') || '';
          const match = href.match(/code=(\d+)/);
          if (!match) return;

          const id = parseInt(match[1], 10);
          const title = linkEl.innerText.trim();
          
          const writerEl = row.querySelector('.writer, .author, td:nth-child(3)');
          const writer = writerEl ? writerEl.innerText.trim() : '';

          if (id && title) {
            results.push({ id, title, writer, href });
          }
        });

        return results;
      });

      if (posts.length === 0) {
        console.log(`└ [수집 완료] ${board.name} -> 수집된 게시글 없음`);
        continue;
      }

      const maxFetchedId = Math.max(...posts.map(p => p.id));
      console.log(`└ [파싱 완료] ${board.name} -> 최신글 ID: ${maxFetchedId} (이전 탐색 ID: ${lastId})`);

      // 기존 탐색 ID보다 큰 신규 글만 필터링
      const newPosts = posts.filter(p => p.id > lastId);

      if (newPosts.length > 0) {
        console.log(`  └ 🆕 신규 게시글 ${newPosts.length}건 감지! 필터 대조를 진행합니다.`);

        newPosts.forEach(post => {
          const matchedKeyword = filterConfig.KEYWORDS.find(kw => 
            post.title.toLowerCase().includes(kw.toLowerCase())
          );
          const matchedWriter = filterConfig.WRITERS.find(wr => 
            post.writer.toLowerCase().includes(wr.toLowerCase())
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

  // 최신 ID 기록 저장을 위해 세이브
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
