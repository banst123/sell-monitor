import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEEN_FILE = path.resolve(__dirname, '..', 'seen_posts.json');
const FILTER_FILE = path.resolve(__dirname, '..', 'filter_config.json');
const HAR_DIR = path.resolve(__dirname, '..', 'logs');
const HAR_FILE = path.resolve(HAR_DIR, 'network.har');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BOARDS = [
  { name: '산악완성차 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET1', section: 'MARKET1' },
  { name: '산악프레임 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET2', section: 'MARKET2' },
  { name: '산악 샥포크 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET3', section: 'MARKET3' },
  { name: '산악부속 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET4', section: 'MARKET4' },
  { name: '전기자전거 완성차장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET21', section: 'MARKET21' },
  { name: '전기자전거 부품장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET24', section: 'MARKET24' },
  { name: '미니벨로 완성차장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET31', section: 'MARKET31' },
  { name: '미니벨로 부품장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET34', section: 'MARKET34' }
];

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

function saveSeenPosts(seenSet) {
  const data = Array.from(seenSet);
  fs.writeFileSync(SEEN_FILE, JSON.stringify(data, null, 2), 'utf8');
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
  console.log('[START] 바이크셀 8개 통합 장터 구동 엔진 (HAR 로깅 모드)');
  console.log('====================================================');

  if (!fs.existsSync(HAR_DIR)) {
    fs.mkdirSync(HAR_DIR, { recursive: true });
  }

  const seenPosts = loadSeenPosts();
  const filterConfig = loadFilterConfig();

  const browser = await chromium.launch({ headless: true });
  
  // HAR 기록이 활성화된 브라우저 컨텍스트
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    recordHar: { path: HAR_FILE }
  });
  const page = await context.newPage();

  let matchedPosts = [];

  for (const board of BOARDS) {
    console.log(`\n[진입] ${board.name} 데이터 수집 중...`);
    console.log(` ├ [요청 URL] ${board.url}`);

    try {
      const response = await page.goto(board.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log(` ├ [응답 코드] ${response ? response.status() : 'NO_RESPONSE'}`);

      // DOM 및 텍스트 덤프 데이터 수집
      const pageData = await page.evaluate(() => {
        const fullText = document.body.innerText;
        
        const linkMap = {};
        const links = Array.from(document.querySelectorAll('a[href*="content.asp"]'));
        links.forEach(a => {
          const href = a.getAttribute('href') || '';
          const match = href.match(/dolseq=(\d+)/i);
          const title = a.innerText.trim();
          if (match && title) {
            linkMap[title] = match[1];
          }
        });

        // DOM 직접 탐색 파싱 (폴백용)
        const domPosts = [];
        const rows = Array.from(document.querySelectorAll('tr'));
        rows.forEach(tr => {
          const titleEl = tr.querySelector('div.mtitle a');
          if (!titleEl) return;
          const href = titleEl.getAttribute('href') || '';
          const match = href.match(/dolseq=(\d+)/i);
          if (!match) return;
          const id = match[1];
          const title = titleEl.innerText.replace(/\s+/g, ' ').trim();
          const writerEl = tr.querySelector('a[href*="memo_write.asp"]');
          const writer = writerEl ? writerEl.innerText.trim() : '';
          if (title) domPosts.push({ id, title, writer });
        });

        return { fullText, linkMap, domPosts };
      });

      console.log(` ├ [텍스트 길이] ${pageData.fullText.length} 자`);
      console.log(` ├ [링크 매핑] ${Object.keys(pageData.linkMap).length} 개 항목 감지`);

      // 1. 텍스트 정규식 파싱 시도
      const regex = /▒\s*([^\n\[]+?)\s*\[\s*\d+\s*\]\s*(\d+)\s*([a-zA-Z0-9_-]+)\s*(\d{4}-\d{2}-\d{2})/g;
      let posts = [];
      let match;

      while ((match = regex.exec(pageData.fullText)) !== null) {
        const title = match[1].trim();
        const writer = match[3].trim();
        const date = match[4].trim();
        const id = pageData.linkMap[title] || `${board.section}_${title}`;
        posts.push({ id, title, writer, date });
      }

      console.log(` ├ [1차 텍스트 파싱] ${posts.length}개 매물 정제`);

      // 2. 텍스트 파싱 실패 시 DOM 파서로 자동 폴백
      if (posts.length === 0 && pageData.domPosts.length > 0) {
        console.log(` ├ [2차 DOM 파서 작동] ${pageData.domPosts.length}개 매물 정제`);
        posts = pageData.domPosts;
      }

      console.log(` └ [최종 수집 완료] ${board.name} -> 총 ${posts.length}개 매물 정제 완료`);

      posts.forEach(post => {
        if (seenPosts.has(post.id)) return;

        seenPosts.add(post.id);

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

          const postUrl = post.id.includes('_')
            ? board.url 
            : `https://bikesell.co.kr/SITE/M/content.asp?doltop=MARKET&dolsection=${board.section}&dolseq=${post.id}`;

          matchedPosts.push({
            boardName: board.name,
            id: post.id,
            title: post.title,
            writer: post.writer,
            reason: matchReason,
            url: postUrl
          });
        }
      });

    } catch (err) {
      console.error(` └ [실패] 연결 및 파싱 오류:`, err.message);
    }
  }

  // 컨텍스트 종료 시 HAR 기록 완결 저장
  await context.close();
  await browser.close();

  console.log(`\n[SYSTEM] HAR 트래픽 로그 저장 완료: ${HAR_FILE}`);

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
