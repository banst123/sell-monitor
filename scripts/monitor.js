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

// 환경변수 검증
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TOKEN || !CHAT_ID) {
  console.error('[FATAL] TELEGRAM_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수가 설정되지 않았습니다.');
  process.exit(1);
}

// 모니터링 대상 게시판 목록
const BOARDS = [
  { name: '산악완성차 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET1', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET1' },
  { name: '산악프레임 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET2', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET2' },
  { name: '산악 샥포크 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET3', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET3' },
  { name: '산악부속 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET4', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET4' },
  { name: '전기자전거 부품장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET24', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET24' },
  { name: '전기자전거 완성차장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET21', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET21' },
  { name: '미니벨로 완성차장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET31', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET31' },
  { name: '미니벨로 부품장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET34', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET34' }
];

// 프로젝트 최상위 루트 경로 지정 (scripts/.. -> 루트)
const SEEN_FILE = path.resolve(__dirname, '..', 'seen_posts.json');
const CONFIG_FILE = path.resolve(__dirname, '..', 'filter_config.json');

function loadSeenIds() {
  try {
    if (!fs.existsSync(SEEN_FILE)) {
      console.log(`[SYSTEM] 저장 파일이 없어 신규 생성합니다. (${SEEN_FILE})`);
      return { set: new Set(), isFirstRun: true };
    }
    const raw = fs.readFileSync(SEEN_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return { set: new Set(), isFirstRun: true };
    
    console.log(`[SYSTEM] 기존 탐색 기록 ${arr.length}개 로드 완료 (${SEEN_FILE})`);
    return { set: new Set(arr), isFirstRun: false };
  } catch (e) {
    console.error('[ERROR] seen_posts.json 읽기 오류:', e.message);
    return { set: new Set(), isFirstRun: true };
  }
}

function saveSeenIds(set) {
  try {
    let arr = Array.from(set);
    if (arr.length > 2000) {
      arr = arr.slice(-1000);
    }
    fs.writeFileSync(SEEN_FILE, JSON.stringify(arr, null, 2), 'utf8');
    console.log(`[SYSTEM] seen_posts.json 저장 완료 (총 ${arr.length}개 기록됨 -> ${SEEN_FILE})`);
  } catch (e) {
    console.error('[ERROR] seen_posts.json 저장 오류:', e.message);
  }
}

function loadFilterConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { KEYWORDS: [], WRITERS: [] };
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { KEYWORDS: [], WRITERS: [] };
  }
}

function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(iconv.decode(Buffer.concat(chunks), 'euc-kr')));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('네트워크 요청 시간 초과 (Timeout)'));
    });

    req.on('error', (err) => reject(err));
  });
}

function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

function escapeHtml(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseList(html, board) {
  const $ = cheerio.load(html);
  const results = [];

  const seqMap = new Map();
  $('a[href*="content.asp"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('WatchList.asp')) return;
    const seqMatch = href.match(/(?:seq|no|dolseq)=(\d+)/i);
    if (seqMatch) {
      const cleanText = $(el).text().replace(/\s+/g, ' ').trim();
      if (cleanText.length > 1) {
        seqMap.set(cleanText, seqMatch[1]);
      }
    }
  });

  const pageText = $('body').text();
  const lines = pageText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const dateRegex = /(\d{4}-\d{2}-\d{2})|((오전|오후)\s*\d+:\d+)|(^\d{2}:\d{2}$)/;

  for (let i = 2; i < lines.length; i++) {
    const currentDateLine = lines[i];

    if (dateRegex.test(currentDateLine)) {
      let writer = lines[i - 1];

      if (/중고|장터|산악|완성차|부속|부품|댓글|공지|조회|추천|현재위치|로그인/i.test(writer) || writer.length > 16) {
        continue;
      }

      let title = '';
      let seq = '';

      for (let j = 1; j <= 4; j++) {
        if (i - j < 0) break;
        const potentialTitle = lines[i - j - 1];
        if (!potentialTitle) continue;

        let foundSeq = seqMap.get(potentialTitle);
        if (!foundSeq) {
          for (let [tKey, sVal] of seqMap.entries()) {
            if (tKey.includes(potentialTitle) || potentialTitle.includes(tKey)) {
              if (potentialTitle.length > 3) {
                foundSeq = sVal;
                break;
              }
            }
          }
        }

        if (foundSeq && !/중고|장터|산악|완성차|부속|부품|댓글|공지|조회|추천|현재위치|로그인/i.test(potentialTitle)) {
          title = potentialTitle;
          seq = foundSeq;
          break;
        }
      }

      if (title && seq) {
        const id = `${board.name}_${seq}`;
        if (results.some(p => p.id === id)) continue;

        results.push({
          id,
          seq,
          board: board.name,
          title,
          writer,
          baseMobileUrl: board.mobileUrl,
          baseDesktopUrl: board.url,
        });
      }
    }
  }

  console.log(`    └ [파싱 완료] ${board.name} -> 총 ${results.length}개 매물 정제 완료`);
  return results;
}

(async () => {
  console.log('====================================================');
  console.log('[START] 바이크셀 8개 통합 장터 구동 엔진 (서버 스트림 최적화본)');
  console.log('====================================================');

  const { set: newSeen, isFirstRun } = loadSeenIds();
  const newPosts = [];
  const FILTER_CONFIG = loadFilterConfig();

  try {
    for (const board of BOARDS) {
      console.log(`[진입] ${board.name} 데이터 수집 중...`);
      let html;
      try { 
        html = await httpGet(board.url); 
      } catch (e) { 
        console.error(`    └ [실패] 연결 오류: ${e.message}`);
        continue; 
      }

      const posts = parseList(html, board);

      for (const post of posts) {
        if (!newSeen.has(post.id)) {
          console.log(`      [★신규발견] ID: ${post.id} | 제목: ${post.title} | 작성자: ${post.writer}`);
          newPosts.push(post);
          newSeen.add(post.id); 
        }
      }
    }

    if (newPosts.length === 0) {
      console.log('\n[INFO] 변동 사항 및 새 글이 없습니다. 프로세스를 종료합니다.');
      return;
    }

    // 변경사항 파일에 기록
    saveSeenIds(newSeen);

    // 최초 구동 시에는 기존 목록 전체 알림을 방지하고 데이터 수집만 진행
    if (isFirstRun) {
      console.log('\n[INFO] 최초 구동이므로 기존 게시글들을 seen_posts.json에 초기화 수집했습니다.');
      console.log('[INFO] 다음 스캔부터 새로 등록되는 매물만 텔레그램으로 발송됩니다.');
      return;
    }

    const groupedData = {};
    BOARDS.forEach(b => { groupedData[b.name] = []; });

    const uniquePosts = Array.from(new Map(newPosts.map((p) => [p.id, p])).values());

    for (const post of uniquePosts) {
      const titleLower = post.title.toLowerCase();
      const writerLower = post.writer.toLowerCase();

      const keywords = Array.isArray(FILTER_CONFIG.KEYWORDS) ? FILTER_CONFIG.KEYWORDS : [];
      const writers = Array.isArray(FILTER_CONFIG.WRITERS) ? FILTER_CONFIG.WRITERS : [];

      const hasFilters = keywords.length > 0 || writers.length > 0;

      if (!hasFilters) {
        post.matchType = 'PERIODIC';
        post.matchReason = '정기 스캔';
        if (groupedData[post.board]) groupedData[post.board].push(post);
        continue;
      }

      let matchedWriter = writers.find((wr) => writerLower.includes(wr.toLowerCase()));
      let matchedKeyword = keywords.find((kw) => titleLower.includes(kw.toLowerCase()));

      if (matchedWriter) {
        post.matchType = 'WRITER_MATCH';
        post.matchReason = `지정게시자 [${matchedWriter}]`;
        if (groupedData[post.board]) groupedData[post.board].push(post);
      } else if (matchedKeyword) {
        post.matchType = 'KEYWORD_MATCH';
        post.matchReason = `키워드 [${matchedKeyword}]`;
        if (groupedData[post.board]) groupedData[post.board].push(post);
      }
    }

    console.log('\n[알림단계] 텔레그램 메시지 발송 개시...');
    for (const boardName of Object.keys(groupedData)) {
      const postsInBoard = groupedData[boardName];
      if (postsInBoard.length === 0) continue;

      const hasWriterMatch = postsInBoard.some(p => p.matchType === 'WRITER_MATCH');
      const mainIcon = hasWriterMatch ? '🚨🚨' : '📦';
      const globalReason = postsInBoard[0].matchType === 'PERIODIC' ? '🕒 정기검색 결과' : '✨ 필터 매칭 결과';
      
      const localMessageLines = [
        `${mainIcon} <b>[${escapeHtml(boardName)}]</b> ${globalReason} (총 ${postsInBoard.length}건)`,
        `━━━━━━━━━━━━━━━━━━`
      ];

      for (let i = 0; i < postsInBoard.length; i++) {
        const currentPost = postsInBoard[i];
        
        const displayTitle = escapeHtml(currentPost.title);
        const displayWriter = escapeHtml(currentPost.writer); 
        const displayReason = escapeHtml(currentPost.matchReason);
        
        const seq = currentPost.seq;
        let mobileUrl = 'https://bikesell.co.kr';
        let desktopUrl = 'https://bikesell.co.kr';
        
        if (seq) {
          mobileUrl = currentPost.baseMobileUrl.replace('list.asp', 'content.asp') + `&dolseq=${seq}`;
          desktopUrl = currentPost.baseDesktopUrl.replace('list.asp', 'content.asp') + `&dolseq=${seq}`;
        }

        const writerAlert = currentPost.matchType === 'WRITER_MATCH' ? ' 🚨[특이게시자]' : '';
        const simpleIdx = `${i + 1}.`;

        localMessageLines.push(
          `<b>${simpleIdx} ${displayTitle}</b>${writerAlert}`,
          `👤 작성자: <code>${displayWriter}</code>`,
          `🛠️ 참고: <i>${displayReason}</i>`,
          `🔗 링크: <a href="${mobileUrl}">[📱모바일]</a> / <a href="${desktopUrl}">[💻PC]</a>\n`
        );
      }

      localMessageLines.push(`━━━━━━━━━━━━━━━━━━`);
      const finalCombinedText = localMessageLines.join('\n');

      try {
        await sendTelegramMessage(finalCombinedText);
        console.log(`    [OK] 텔레그램 발송 완료 -> ${boardName}`);
      } catch (e) {
        console.error(`    [ERROR] 발송 실패:`, e.message);
      }
    }
    console.log('\n[FINISH] 모니터링 주기가 안정적으로 종료되었습니다.');

  } catch (e) {
    console.error('[FATAL] 에러 발생:', e);
    process.exit(1);
  }
})();import * as dotenv from 'dotenv';
dotenv.config();

import https from 'https';
import fs from 'fs';
import path from 'path';
import * as cheerio from 'cheerio';
import iconv from 'iconv-lite';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 환경변수 검증
const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TOKEN || !CHAT_ID) {
  console.error('[FATAL] TELEGRAM_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수가 설정되지 않았습니다.');
  process.exit(1);
}

// 모니터링 대상 게시판 목록
const BOARDS = [
  { name: '산악완성차 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET1', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET1' },
  { name: '산악프레임 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET2', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET2' },
  { name: '산악 샥포크 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET3', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET3' },
  { name: '산악부속 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET4', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET4' },
  { name: '전기자전거 부품장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET24', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET24' },
  { name: '전기자전거 완성차장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET21', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET21' },
  { name: '미니벨로 완성차장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET31', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET31' },
  { name: '미니벨로 부품장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET34', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET34' }
];

// 프로젝트 최상위 루트 경로 지정 (scripts/.. -> 루트)
const SEEN_FILE = path.resolve(__dirname, '..', 'seen_posts.json');
const CONFIG_FILE = path.resolve(__dirname, '..', 'filter_config.json');

function loadSeenIds() {
  try {
    if (!fs.existsSync(SEEN_FILE)) {
      console.log(`[SYSTEM] 저장 파일이 없어 신규 생성합니다. (${SEEN_FILE})`);
      return { set: new Set(), isFirstRun: true };
    }
    const raw = fs.readFileSync(SEEN_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return { set: new Set(), isFirstRun: true };
    
    console.log(`[SYSTEM] 기존 탐색 기록 ${arr.length}개 로드 완료 (${SEEN_FILE})`);
    return { set: new Set(arr), isFirstRun: false };
  } catch (e) {
    console.error('[ERROR] seen_posts.json 읽기 오류:', e.message);
    return { set: new Set(), isFirstRun: true };
  }
}

function saveSeenIds(set) {
  try {
    let arr = Array.from(set);
    if (arr.length > 2000) {
      arr = arr.slice(-1000);
    }
    fs.writeFileSync(SEEN_FILE, JSON.stringify(arr, null, 2), 'utf8');
    console.log(`[SYSTEM] seen_posts.json 저장 완료 (총 ${arr.length}개 기록됨 -> ${SEEN_FILE})`);
  } catch (e) {
    console.error('[ERROR] seen_posts.json 저장 오류:', e.message);
  }
}

function loadFilterConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { KEYWORDS: [], WRITERS: [] };
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return { KEYWORDS: [], WRITERS: [] };
  }
}

function httpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(iconv.decode(Buffer.concat(chunks), 'euc-kr')));
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('네트워크 요청 시간 초과 (Timeout)'));
    });

    req.on('error', (err) => reject(err));
  });
}

function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

function escapeHtml(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseList(html, board) {
  const $ = cheerio.load(html);
  const results = [];

  const seqMap = new Map();
  $('a[href*="content.asp"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('WatchList.asp')) return;
    const seqMatch = href.match(/(?:seq|no|dolseq)=(\d+)/i);
    if (seqMatch) {
      const cleanText = $(el).text().replace(/\s+/g, ' ').trim();
      if (cleanText.length > 1) {
        seqMap.set(cleanText, seqMatch[1]);
      }
    }
  });

  const pageText = $('body').text();
  const lines = pageText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const dateRegex = /(\d{4}-\d{2}-\d{2})|((오전|오후)\s*\d+:\d+)|(^\d{2}:\d{2}$)/;

  for (let i = 2; i < lines.length; i++) {
    const currentDateLine = lines[i];

    if (dateRegex.test(currentDateLine)) {
      let writer = lines[i - 1];

      if (/중고|장터|산악|완성차|부속|부품|댓글|공지|조회|추천|현재위치|로그인/i.test(writer) || writer.length > 16) {
        continue;
      }

      let title = '';
      let seq = '';

      for (let j = 1; j <= 4; j++) {
        if (i - j < 0) break;
        const potentialTitle = lines[i - j - 1];
        if (!potentialTitle) continue;

        let foundSeq = seqMap.get(potentialTitle);
        if (!foundSeq) {
          for (let [tKey, sVal] of seqMap.entries()) {
            if (tKey.includes(potentialTitle) || potentialTitle.includes(tKey)) {
              if (potentialTitle.length > 3) {
                foundSeq = sVal;
                break;
              }
            }
          }
        }

        if (foundSeq && !/중고|장터|산악|완성차|부속|부품|댓글|공지|조회|추천|현재위치|로그인/i.test(potentialTitle)) {
          title = potentialTitle;
          seq = foundSeq;
          break;
        }
      }

      if (title && seq) {
        const id = `${board.name}_${seq}`;
        if (results.some(p => p.id === id)) continue;

        results.push({
          id,
          seq,
          board: board.name,
          title,
          writer,
          baseMobileUrl: board.mobileUrl,
          baseDesktopUrl: board.url,
        });
      }
    }
  }

  console.log(`    └ [파싱 완료] ${board.name} -> 총 ${results.length}개 매물 정제 완료`);
  return results;
}

(async () => {
  console.log('====================================================');
  console.log('[START] 바이크셀 8개 통합 장터 구동 엔진 (서버 스트림 최적화본)');
  console.log('====================================================');

  const { set: newSeen, isFirstRun } = loadSeenIds();
  const newPosts = [];
  const FILTER_CONFIG = loadFilterConfig();

  try {
    for (const board of BOARDS) {
      console.log(`[진입] ${board.name} 데이터 수집 중...`);
      let html;
      try { 
        html = await httpGet(board.url); 
      } catch (e) { 
        console.error(`    └ [실패] 연결 오류: ${e.message}`);
        continue; 
      }

      const posts = parseList(html, board);

      for (const post of posts) {
        if (!newSeen.has(post.id)) {
          console.log(`      [★신규발견] ID: ${post.id} | 제목: ${post.title} | 작성자: ${post.writer}`);
          newPosts.push(post);
          newSeen.add(post.id); 
        }
      }
    }

    if (newPosts.length === 0) {
      console.log('\n[INFO] 변동 사항 및 새 글이 없습니다. 프로세스를 종료합니다.');
      return;
    }

    // 변경사항 파일에 기록
    saveSeenIds(newSeen);

    // 최초 구동 시에는 기존 목록 전체 알림을 방지하고 데이터 수집만 진행
    if (isFirstRun) {
      console.log('\n[INFO] 최초 구동이므로 기존 게시글들을 seen_posts.json에 초기화 수집했습니다.');
      console.log('[INFO] 다음 스캔부터 새로 등록되는 매물만 텔레그램으로 발송됩니다.');
      return;
    }

    const groupedData = {};
    BOARDS.forEach(b => { groupedData[b.name] = []; });

    const uniquePosts = Array.from(new Map(newPosts.map((p) => [p.id, p])).values());

    for (const post of uniquePosts) {
      const titleLower = post.title.toLowerCase();
      const writerLower = post.writer.toLowerCase();

      const keywords = Array.isArray(FILTER_CONFIG.KEYWORDS) ? FILTER_CONFIG.KEYWORDS : [];
      const writers = Array.isArray(FILTER_CONFIG.WRITERS) ? FILTER_CONFIG.WRITERS : [];

      const hasFilters = keywords.length > 0 || writers.length > 0;

      if (!hasFilters) {
        post.matchType = 'PERIODIC';
        post.matchReason = '정기 스캔';
        if (groupedData[post.board]) groupedData[post.board].push(post);
        continue;
      }

      let matchedWriter = writers.find((wr) => writerLower.includes(wr.toLowerCase()));
      let matchedKeyword = keywords.find((kw) => titleLower.includes(kw.toLowerCase()));

      if (matchedWriter) {
        post.matchType = 'WRITER_MATCH';
        post.matchReason = `지정게시자 [${matchedWriter}]`;
        if (groupedData[post.board]) groupedData[post.board].push(post);
      } else if (matchedKeyword) {
        post.matchType = 'KEYWORD_MATCH';
        post.matchReason = `키워드 [${matchedKeyword}]`;
        if (groupedData[post.board]) groupedData[post.board].push(post);
      }
    }

    console.log('\n[알림단계] 텔레그램 메시지 발송 개시...');
    for (const boardName of Object.keys(groupedData)) {
      const postsInBoard = groupedData[boardName];
      if (postsInBoard.length === 0) continue;

      const hasWriterMatch = postsInBoard.some(p => p.matchType === 'WRITER_MATCH');
      const mainIcon = hasWriterMatch ? '🚨🚨' : '📦';
      const globalReason = postsInBoard[0].matchType === 'PERIODIC' ? '🕒 정기검색 결과' : '✨ 필터 매칭 결과';
      
      const localMessageLines = [
        `${mainIcon} <b>[${escapeHtml(boardName)}]</b> ${globalReason} (총 ${postsInBoard.length}건)`,
        `━━━━━━━━━━━━━━━━━━`
      ];

      for (let i = 0; i < postsInBoard.length; i++) {
        const currentPost = postsInBoard[i];
        
        const displayTitle = escapeHtml(currentPost.title);
        const displayWriter = escapeHtml(currentPost.writer); 
        const displayReason = escapeHtml(currentPost.matchReason);
        
        const seq = currentPost.seq;
        let mobileUrl = 'https://bikesell.co.kr';
        let desktopUrl = 'https://bikesell.co.kr';
        
        if (seq) {
          mobileUrl = currentPost.baseMobileUrl.replace('list.asp', 'content.asp') + `&dolseq=${seq}`;
          desktopUrl = currentPost.baseDesktopUrl.replace('list.asp', 'content.asp') + `&dolseq=${seq}`;
        }

        const writerAlert = currentPost.matchType === 'WRITER_MATCH' ? ' 🚨[특이게시자]' : '';
        const simpleIdx = `${i + 1}.`;

        localMessageLines.push(
          `<b>${simpleIdx} ${displayTitle}</b>${writerAlert}`,
          `👤 작성자: <code>${displayWriter}</code>`,
          `🛠️ 참고: <i>${displayReason}</i>`,
          `🔗 링크: <a href="${mobileUrl}">[📱모바일]</a> / <a href="${desktopUrl}">[💻PC]</a>\n`
        );
      }

      localMessageLines.push(`━━━━━━━━━━━━━━━━━━`);
      const finalCombinedText = localMessageLines.join('\n');

      try {
        await sendTelegramMessage(finalCombinedText);
        console.log(`    [OK] 텔레그램 발송 완료 -> ${boardName}`);
      } catch (e) {
        console.error(`    [ERROR] 발송 실패:`, e.message);
      }
    }
    console.log('\n[FINISH] 모니터링 주기가 안정적으로 종료되었습니다.');

  } catch (e) {
    console.error('[FATAL] 에러 발생:', e);
    process.exit(1);
  }
})();
