import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SEEN_FILE = path.resolve(__dirname, '..', 'seen_posts.json');
const FILTER_FILE = path.resolve(__dirname, '..', 'filter_config.json');
const LOGS_DIR = path.resolve(__dirname, '..', 'logs');
const HAR_FILE = path.resolve(LOGS_DIR, 'network_full.har');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// 모바일 전용 목록 페이지 경로(/SITE/M/list.asp) 명시
const BOARDS = [
  { name: '산악완성차 중고장터', url: 'https://bikesell.co.kr/SITE/M/list.asp?doltop=MARKET&dolsection=MARKET1', section: 'MARKET1' },
  { name: '산악프레임 중고장터', url: 'https://bikesell.co.kr/SITE/M/list.asp?doltop=MARKET&dolsection=MARKET2', section: 'MARKET2' },
  { name: '산악 샥포크 중고장터', url: 'https://bikesell.co.kr/SITE/M/list.asp?doltop=MARKET&dolsection=MARKET3', section: 'MARKET3' },
  { name: '산악부속 중고장터', url: 'https://bikesell.co.kr/SITE/M/list.asp?doltop=MARKET&dolsection=MARKET4', section: 'MARKET4' },
  { name: '전기자전거 완성차장터', url: 'https://bikesell.co.kr/SITE/M/list.asp?doltop=MARKET&dolsection=MARKET21', section: 'MARKET21' },
  { name: '전기자전거 부품장터', url: 'https://bikesell.co.kr/SITE/M/list.asp?doltop=MARKET&dolsection=MARKET24', section: 'MARKET24' },
  { name: '미니벨로 완성차장터', url: 'https://bikesell.co.kr/SITE/M/list.asp?doltop=MARKET&dolsection=MARKET31', section: 'MARKET31' },
  { name: '미니벨로 부품장터', url: 'https://bikesell.co.kr/SITE/M/list.asp?doltop=MARKET&dolsection=MARKET34', section: 'MARKET34' }
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
  console.log(`[SYSTEM] 신규 탐색 기록 저장 완료 (총 ${data.length}개 항목)`);
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
  return new Promise((resolve) => {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
      console.log('[TELEGRAM SKIPPED] 토큰 또는 Chat ID 미설정');
      console.log(text);
      return resolve();
    }

    const payload = JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: 'Markdown',
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

    const req = https.request(options, () => resolve());
    req.on('error', (e) => {
      console.error('[TELEGRAM ERROR]', e.message);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}

async function run() {
  console.log('====================================================');
  console.log('[START] 바이크셀 8개 통합 장터 구동 엔진 (완료글/중복 제어 적용)');
  console.log('====================================================');

  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  const seenPosts = loadSeenPosts();
  const filterConfig = loadFilterConfig();

  let browser;
  let context;

  try {
    browser = await chromium.launch({ headless: true });
    
    // 지시하신 HAR 전수 로깅 설정 적용
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      recordHar: {
        path: HAR_FILE,
        content: 'embed',
        mode: 'full'
      }
    });

    const page = await context.newPage();
    const boardMatches = {};

    for (const board of BOARDS) {
      console.log(`\n[진입] ${board.name} 데이터 수집 중...`);

      try {
        await page.goto(board.url, { waitUntil: 'domcontentloaded', timeout: 15000 });

        // DOM 파싱: 취소선(<STRIKE>) 필터링 및 매물 추출
        const posts = await page.evaluate(() => {
          const results = [];
          const listItems = Array.from(document.querySelectorAll('#bikesellboard ul li, div#bikesellboard li'));

          listItems.forEach(li => {
            // 상세링크(content.asp) 탐색
            const aTag = li.querySelector('a[href*="content.asp"]');
            if (!aTag) return;

            // 판매완료건(<STRIKE>) 감지 시 제외
            if (aTag.querySelector('strike, STRIKE')) return;

            const href = aTag.getAttribute('href') || '';
            const match = href.match(/dolseq=(\d+)/i);
            if (!match) return;

            const id = match[1];
            const title = aTag.innerText.replace(/\s+/g, ' ').trim();

            if (!title) return;

            // 작성자 영역 추출
            const writerEl = li.querySelector('a[href*="memo_write.asp"], .writer');
            const writer = writerEl ? writerEl.innerText.trim() : '';

            results.push({ id, title, writer });
          });

          return results;
        });

        console.log(` └ [파싱 완료] ${board.name} -> 총 ${posts.length}개 유효 매물 정제 완료`);

        posts.forEach(post => {
          // 이미 확인한 게시물 스킵
          if (seenPosts.has(post.id)) return;

          // 탐색 내역 등록
          seenPosts.add(post.id);

          const matchedKeyword = filterConfig.KEYWORDS.find(kw =>
            post.title.toLowerCase().includes(kw.toLowerCase())
          );
          const matchedWriter = filterConfig.WRITERS.find(wr =>
            wr && post.writer.toLowerCase().includes(wr.toLowerCase())
          );

          if (matchedKeyword || matchedWriter) {
            if (!boardMatches[board.name]) {
              boardMatches[board.name] = [];
            }

            let reason = '';
            let isSpecial = false;

            if (matchedWriter) {
              reason = `지정게시자 [${matchedWriter}]`;
              isSpecial = true;
            } else if (matchedKeyword) {
              reason = `키워드 [${matchedKeyword}]`;
            }

            const mobileUrl = `https://bikesell.co.kr/SITE/M/content.asp?doltop=MARKET&dolsection=${board.section}&dolseq=${post.id}`;
            const pcUrl = `https://bikesell.co.kr/site/board/content.asp?doltop=MARKET&dolsection=${board.section}&dolseq=${post.id}`;

            boardMatches[board.name].push({
              id: post.id,
              title: post.title,
              writer: post.writer,
              reason: reason,
              isSpecial: isSpecial,
              mobileUrl: mobileUrl,
              pcUrl: pcUrl
            });
          }
        });

      } catch (err) {
        console.error(` └ [실패] 연결 오류:`, err.message);
      }
    }

    // 갱신된 탐색 내역 파일 저장
    saveSeenPosts(seenPosts);

    const boardNames = Object.keys(boardMatches);
    if (boardNames.length > 0) {
      for (const boardName of boardNames) {
        const items = boardMatches[boardName];
        
        const hasSpecialInBoard = items.some(item => item.isSpecial);
        const headerPrefix = hasSpecialInBoard ? '🚨🚨 ' : '';

        let message = `${headerPrefix}[${boardName}] ✨ 필터 매칭 결과 (총 ${items.length}건)\n━━━━━━━━━━━━━━━━━━\n`;
        
        items.forEach((item, index) => {
          const specialBadge = item.isSpecial ? ' 🚨[특이게시자]' : '';
          message += `${index + 1}. ${item.title}${specialBadge}\n`;
          if (item.writer) message += `👤 작성자: ${item.writer}\n`;
          message += `🛠️ 참고: ${item.reason}\n`;
          message += `🔗 링크: [📱모바일](${item.mobileUrl}) / [💻PC](${item.pcUrl})\n\n`;
        });

        message += `━━━━━━━━━━━━━━━━━━`;

        await sendTelegramMessage(message);
      }
    } else {
      console.log('\n[INFO] 변동 사항 및 새 글이 없습니다.');
    }

  } catch (globalErr) {
    console.error('[CRITICAL] 예외 발생:', globalErr.message);
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    console.log(`[SYSTEM] HAR 트래픽 로깅 완료 (${HAR_FILE})`);
    console.log('[SYSTEM] 프로세스를 종료합니다.');
    process.exit(0);
  }
}

run();
