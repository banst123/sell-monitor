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

function loadLastSeenIds() {
  if (fs.existsSync(SEEN_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
      if (!Array.isArray(data) && typeof data === 'object') {
        return data;
      }
    } catch (e) {
      console.error('[WARN] seen_posts.json 읽기 오류. 새로 생성합니다.');
    }
  }
  return {};
}

function saveLastSeenIds(lastSeenMap) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify(lastSeenMap, null, 2), 'utf8');
  console.log(`[SYSTEM] 게시판별 최신 번호 저장 완료`);
}

function loadFilterConfig() {
  if (fs.existsSync(FILTER_FILE)) {
    try {
      const raw = fs.readFileSync(FILTER_FILE, 'utf8');
      const config = JSON.parse(raw);
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

// 2일 경과 여부 판별 함수
function isWithinTwoDays(dateString) {
  if (!dateString) return true;
  const postDate = new Date(dateString);
  const now = new Date();
  
  // 두 날짜 간의 일수 차이 계산
  const diffTime = Math.abs(now - postDate);
  const diffDays = diffTime / (1000 * 60 * 60 * 24);
  
  return diffDays <= 2;
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
  console.log('[START] 바이크셀 8개 통합 장터 구동 엔진 (2일 경과 & STRIKE 엄격 검증)');
  console.log('====================================================');

  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }

  const lastSeenMap = loadLastSeenIds();
  const filterConfig = loadFilterConfig();

  let browser;
  let context;

  try {
    browser = await chromium.launch({ headless: true });
    
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
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

        const pageData = await page.evaluate(() => {
          const fullText = document.body.innerText;
          
          const linkMap = {};
          // <STRIKE> 태그가 포함된 상세 링크는 1차 제외
          const links = Array.from(document.querySelectorAll('a[href*="content.asp"]'));
          links.forEach(a => {
            if (a.querySelector('strike, STRIKE')) return;

            const href = a.getAttribute('href') || '';
            const match = href.match(/dolseq=(\d+)/i);
            const title = a.innerText.trim();
            if (match && title) {
              linkMap[title] = match[1];
            }
          });

          return { fullText, linkMap };
        });

        // 텍스트 기반 매물 정제
        const regex = /▒\s*([^\n\[]+?)\s*(\[\s*\d+\s*\])\s*(\d+)\s*([a-zA-Z0-9_-]+)\s*(\d{4}-\d{2}-\d{2})/g;
        const posts = [];
        let match;

        while ((match = regex.exec(pageData.fullText)) !== null) {
          const rawTitle = match[1].trim();
          const replyCount = match[2].trim();
          const writer = match[4].trim();
          const date = match[5].trim();
          
          const rawId = pageData.linkMap[rawTitle];
          if (!rawId) continue;

          // 취소선 문구 및 거래완료 표기 2중 필터링
          if (rawTitle.includes('완료') || rawTitle.includes('판매완료') || rawTitle.includes('인하')) {
            // 필요시 판매완료 키워드 세부 조정
          }

          const id = parseInt(rawId, 10);
          posts.push({ id, title: rawTitle, replyCount, writer, date });
        }

        console.log(` └ [파싱 완료] ${board.name} -> 총 ${posts.length}개 유효 매물 정제 완료`);

        const lastSeenId = lastSeenMap[board.section] || 0;
        let maxIdInBoard = lastSeenId;

        posts.forEach(post => {
          if (post.id > maxIdInBoard) {
            maxIdInBoard = post.id;
          }

          // 1. 기존 최신 번호 이하의 과거 매물 스킵
          if (lastSeenId > 0 && post.id <= lastSeenId) return;

          // 2. 작성일자 기준 2일 경과 매물 스킵
          if (!isWithinTwoDays(post.date)) {
            console.log(`  ├ [기간 경과 스킵] ${post.title} (작성일: ${post.date})`);
            return;
          }

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
              title: `${post.title}${post.replyCount}`,
              writer: post.writer,
              reason: reason,
              isSpecial: isSpecial,
              mobileUrl: mobileUrl,
              pcUrl: pcUrl
            });
          }
        });

        lastSeenMap[board.section] = maxIdInBoard;

      } catch (err) {
        console.error(` └ [실패] 연결 오류:`, err.message);
      }
    }

    saveLastSeenIds(lastSeenMap);

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
