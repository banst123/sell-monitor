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

// 데스크톱 목록 페이지 경로 및 모바일 상세링크 세션 코드 매핑
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
  console.log('[START] 바이크셀 8개 통합 장터 구동 엔진 (텍스트 파서)');
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

      // 1. 페이지 전체 텍스트 및 dolseq 링크 매핑 데이터 수집
      const pageData = await page.evaluate(() => {
        const fullText = document.body.innerText;
        
        // 링크 태그에서 dolseq 추출하여 매핑 테이블 작성
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

        return { fullText, linkMap };
      });

      // 2. 제시해주신 텍스트 패턴 정규식 파싱
      // ▒제목[댓글수]\n조회수작성자\n날짜 형태 추출
      const regex = /▒([^\n\[]+)\[\s*\d+\s*\]\s*\n\s*\d+([a-zA-Z0-9_-]+)\s*\n\s*(\d{4}-\d{2}-\d{2})/g;
      const posts = [];
      let match;

      while ((match = regex.exec(pageData.fullText)) !== null) {
        const title = match[1].trim();
        const writer = match[2].trim();
        const date = match[3].trim();
        
        // 매핑된 링크에서 게시글 ID(dolseq) 식별, 없으면 제목 고유값으로 대체
        const id = pageData.linkMap[title] || `${board.section}_${title}`;

        posts.push({ id, title, writer, date });
      }

      console.log(`└ [파싱 완료] ${board.name} -> 총 ${posts.length}개 매물 정제 완료`);

      // 3. 필터링 및 전송 데이터 가공
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

          // 모바일 접속 가능 링크 구성
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
      console.error(`└ [실패] 연결 오류:`, err.message);
    }
  }

  await browser.close();

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
