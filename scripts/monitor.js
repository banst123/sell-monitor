import * as dotenv from 'dotenv';
dotenv.config();

import https from 'https';
import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TOKEN || !CHAT_ID) {
  console.error('[FATAL] TELEGRAM_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수가 없습니다.');
  process.exit(1);
}

// 동일 서버 연속 요청 시 핸드셰이크 지연을 없애기 위한 HTTP 에이전트 설정 (속도 향상 핵심)
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 5 });

const BOARDS = [
  { name: '산악완성차 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET1', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET1' },
  { name: '산악프레임 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET2', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET2' },
  { name: '산악 샥포크 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET3', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET3' },
  { name: '산악부속 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET4', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET4' },
  { name: '전기자전거 부품장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET24', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET24' },
];

const SEEN_FILE = path.join(__dirname, '..', 'seen_posts.json');
const CONFIG_FILE = path.join(__dirname, '..', 'filter_config.json');

function loadSeenIds() {
  try {
    if (!fs.existsSync(SEEN_FILE)) return new Set();
    const raw = fs.readFileSync(SEEN_FILE, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr) : new Set();
  } catch (e) { return new Set(); }
}

function saveSeenIds(set) {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify(Array.from(set)), 'utf8'); } catch (e) {}
}

function loadFilterConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { KEYWORDS: [], WRITERS: [] };
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) { return { KEYWORDS: [], WRITERS: [] }; }
}

// 네트워크 레이어 최적화: Keep-Alive 킵 및 불필요 리소스 헤더 거르기
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent: keepAliveAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/html', // 텍스트 HTML 형식만 타겟팅 유도
        'Connection': 'keep-alive'
      },
    }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(iconv.decode(Buffer.concat(chunks), 'euc-kr')));
    });
    req.on('error', reject);
  });
}

function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/sendMessage`,
      method: 'POST',
      agent: keepAliveAgent,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function escapeHtml(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 파싱 엔진 최적화 (텍스트만 콕 집어서 고속 스캔)
function parseList(html, board) {
  // 가벼운 DOM 트리 유지를 위해 최적화 모드로 로드
  const $ = cheerio.load(html, { _root: true, xmlMode: false });
  const results = [];
  
  $('tr').each((_, tr) => {
    const $tr = $(tr);
    const $links = $tr.find('a[href*="content.asp"]');
    if ($links.length === 0) return; // 링크 없으면 즉시 다음 행으로 패스 (연산 절약)

    let $titleLink = null;
    $links.each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      if (!href.includes('WatchList.asp')) {
        $titleLink = $a;
        return false; // 타이틀 찾으면 내부 루프 즉시 종료
      }
    });

    if (!$titleLink) return;

    const href = $titleLink.attr('href') || '';
    const seqMatch = href.match(/(?:seq|no|dolseq)=(\d+)/i);
    if (!seqMatch) return;
    
    const seq = seqMatch[1];
    const id = `${board.name}_${seq}`;

    // 제목 텍스트만 추출 (정규식 공백 정리는 최소화)
    let title = $titleLink.text().trim();
    if (!title) return;
    title = title.replace(/\[\s*\d+\s*\]$/, '').trim(); // 댓글수 제거

    // 고속 텍스트 매칭용
    const fullRowText = $tr.text();
    let writer = '일반판매자';
    const dateMatch = fullRowText.match(/([^\s]+)\s+\d{4}-\d{2}-\d{2}/);
    
    if (dateMatch && dateMatch[1]) {
      const rawWriter = dateMatch[1].trim().replace(/^\d+/, '');
      if (rawWriter.length <= 16 && !/중고|장터|산악|완성차|부속|부품|댓글/i.test(rawWriter)) {
        writer = rawWriter;
      }
    }

    results.push({ id, seq, board: board.name, title, writer, baseMobileUrl: board.mobileUrl, baseDesktopUrl: board.url });
  });

  return results;
}

(async () => {
  console.log('====================================================');
  console.log('[START] 초고속 텍스트 파싱 모니터링 프로세스 구동');
  console.log('====================================================');

  const seen = loadSeenIds();
  const newSeen = new Set(seen);
  const newPosts = [];
  const FILTER_CONFIG = loadFilterConfig();

  // 비동기 병렬 매핑 대신 순차 처리를 유지하되 네트워크 지연 최소화
  for (const board of BOARDS) {
    try {
      const html = await httpGet(board.url);
      const posts = parseList(html, board);
      for (const post of posts) {
        if (!newSeen.has(post.id)) {
          newPosts.push(post);
          newSeen.add(post.id);
        }
      }
    } catch (e) {
      console.error(`[오류 스킵] ${board.name} 연결 실패`);
    }
  }

  if (newPosts.length === 0) {
    console.log('[INFO] 알림 대기 중인 새 글이 없습니다.');
    return;
  }

  saveSeenIds(newSeen);

  const groupedData = {};
  BOARDS.forEach(b => { groupedData[b.name] = []; });

  const keywords = Array.isArray(FILTER_CONFIG.KEYWORDS) ? FILTER_CONFIG.KEYWORDS.map(k => k.toLowerCase().trim()) : [];
  const writers = Array.isArray(FILTER_CONFIG.WRITERS) ? FILTER_CONFIG.WRITERS.map(w => w.toLowerCase().trim()) : [];
  const hasFilters = keywords.length > 0 || writers.length > 0;

  for (const post of newPosts) {
    if (!hasFilters) {
      post.matchType = 'PERIODIC';
      post.matchReason = '정기 스캔';
      if (groupedData[post.board]) groupedData[post.board].push(post);
      continue;
    }

    const titleLower = post.title.toLowerCase();
    const writerLower = post.writer.toLowerCase();

    // 고속 인덱스 비교
    const matchedWriter = writers.find(wr => writerLower.includes(wr));
    if (matchedWriter) {
      post.matchType = 'WRITER_MATCH';
      post.matchReason = `✨지정게시자 [${matchedWriter}]`;
      if (groupedData[post.board]) groupedData[post.board].push(post);
      continue;
    }

    const matchedKeyword = keywords.find(kw => titleLower.includes(kw));
    if (matchedKeyword) {
      post.matchType = 'KEYWORD_MATCH';
      post.matchReason = `키워드 [${matchedKeyword}]`;
      if (groupedData[post.board]) groupedData[post.board].push(post);
    }
  }

  for (const boardName of Object.keys(groupedData)) {
    const postsInBoard = groupedData[boardName];
    if (postsInBoard.length === 0) continue;

    const hasWriterMatch = postsInBoard.some(p => p.matchType === 'WRITER_MATCH');
    const mainHeaderIcon = hasWriterMatch ? '🚨🚨🚨 [특이게시자 등판] 🚨🚨🚨\n⚡' : '📦';
    const globalReason = postsInBoard[0].matchType === 'PERIODIC' ? '🕒 정기 결과' : '✨ 필터 결과';
    
    const localMessageLines = [
      `${mainHeaderIcon} <b>[${escapeHtml(boardName)}]</b> ${globalReason} (총 ${postsInBoard.length}건)`,
      `━━━━━━━━━━━━━━━━━━`
    ];

    postsInBoard.forEach((currentPost, i) => {
      const displayTitle = escapeHtml(currentPost.title);
      const displayWriter = escapeHtml(currentPost.writer);
      const displayReason = escapeHtml(currentPost.matchReason);
      const seq = currentPost.seq;
      
      const mobileUrl = currentPost.baseMobileUrl.replace('list.asp', 'content.asp') + `&dolseq=${seq}`;
      const desktopUrl = currentPost.baseDesktopUrl.replace('list.asp', 'content.asp') + `&dolseq=${seq}`;
      const simpleIdx = `${i + 1}.`;

      if (currentPost.matchType === 'WRITER_MATCH') {
        localMessageLines.push(
          `🔥 <b>${simpleIdx} ${displayTitle}</b>`,
          `👤 <b>지정 판매자 발견: <code>${displayWriter}</code></b>`,
          `🎯 <i>필터 근거: ${displayReason}</i>`,
          `🔗 링크: <a href="${mobileUrl}">[📱모바일]</a> / <a href="${desktopUrl}">[💻PC]</a>\n`
        );
      } else {
        localMessageLines.push(
          `📦 <b>${simpleIdx} ${displayTitle}</b>`,
          `👤 작성자: <code>${displayWriter}</code>`,
          `🛠️ 필터: <i>${displayReason}</i>`,
          `🔗 링크: <a href="${mobileUrl}">[📱모바일]</a> / <a href="${desktopUrl}">[💻PC]</a>\n`
        );
      }
    });

    localMessageLines.push(`━━━━━━━━━━━━━━━━━━`);
    try {
      await sendTelegramMessage(localMessageLines.join('\n'));
      console.log(`   [OK] 텔레그램 발송 완료 -> ${boardName}`);
    } catch (e) {
      console.error(`   [ERROR] 발송 오류:`, e.message);
    }
  }

  console.log('\n[FINISH] 모니터링 완료.');
})();
