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
// GitHub 캐시 제어를 위한 환경변수 추가
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO = process.env.GITHUB_REPOSITORY; // 예: "유저명/레포명"

if (!TOKEN || !CHAT_ID) {
  console.error('[FATAL] TELEGRAM_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수가 없습니다.');
  process.exit(1);
}

const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

const BOARDS = [
  { name: '산악완성차 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET1', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET1' },
  { name: '산악프레임 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET2', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET2' },
  { name: '산악 샥포크 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET3', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET3' },
  { name: '산악부속 중고장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET4', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET4' },
  { name: '전기자전거 부품장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET24', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET24' },
  { name: '미니벨로 완성차장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET31', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET31' },
  { name: '미니벨로 부품장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET34', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET34' },
  { name: '전기자전거 완성차장터', url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET21', mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET21' }
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

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent: keepAliveAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'text/html',
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

// 🎯 GitHub Actions 캐시를 체크하고 조건 충족 시 오래된 순으로 100개 삭제하는 함수
function githubApiRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const payload = data ? JSON.stringify(data) : '';
    const options = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'User-Agent': 'NodeJS-Script',
        'Authorization': `Bearer ${GH_TOKEN}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    if (data) {
      options.headers['Content-Type'] = 'application/json';
    }
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body ? JSON.parse(body) : null);
        } else {
          reject(new Error(`GH API ${res.statusCode}: ${body}`));
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(payload);
    req.end();
  });
}

async function autoCleanCaches() {
  if (!GH_TOKEN || !GH_REPO) {
    console.log('\n[캐시 매니저] GITHUB_TOKEN 환경변수가 제공되지 않아 자동 청소 점검을 건너뜁니다.');
    return;
  }
  
  console.log('\n====================================================');
  console.log('[캐시 매니저] 레포지토리 용량 및 캐시 최적화 점검 시작');
  console.log('====================================================');
  
  try {
    const resData = await githubApiRequest('GET', `/repos/${GH_REPO}/actions/caches?per_page=100`);
    const totalCaches = resData.total_count || 0;
    console.log(`· 현재 원격 서버에 적재된 캐시 총량: ${totalCaches}개 / 200개`);

    if (totalCaches >= 200) {
      console.log(`⚠️ [경보] 캐시 수량이 제한값(200개)에 도달했습니다! 자동 다이어트를 시작합니다.`);
      
      // 생성일(created_at) 기준 오래된 순으로 정렬
      const sortedCaches = resData.actions_caches.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      // 상위 100개 타겟팅 추출
      const deleteTargets = sortedCaches.slice(0, 100);
      
      console.log(`· 정리 대상: 가장 옛날에 생성된 캐시 100개 순차 삭제 개시...`);
      
      for (const cache of deleteTargets) {
        await githubApiRequest('DELETE', `/repos/${GH_REPO}/actions/caches/${cache.id}`);
      }
      
      console.log(`✨ [성공] 오래된 하위 캐시 100개 완전 삭제 완료. 쾌적한 환경을 유지합니다.`);
    } else {
      console.log(`· 상태 안전: 아직 보관 한계치(200개) 미만이므로 정리를 생략합니다.`);
    }
  } catch (err) {
    console.error('[캐시 매니저 오류] 최적화 작업 중 에러 발생:', err.message);
  }
}

function escapeHtml(text) {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseList(html, board) {
  const $ = cheerio.load(html, { _root: true, xmlMode: false });
  const results = [];
  
  $('tr').each((_, tr) => {
    const $tr = $(tr);
    const $links = $tr.find('a[href*="content.asp"]');
    if ($links.length === 0) return;

    let $titleLink = null;
    $links.each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      if (!href.includes('WatchList.asp')) {
        $titleLink = $a;
        return false;
      }
    });

    if (!$titleLink) return;

    const href = $titleLink.attr('href') || '';
    const seqMatch = href.match(/(?:seq|no|dolseq)=(\d+)/i);
    if (!seqMatch) return;
    
    const seq = seqMatch[1];
    const id = `${board.name}_${seq}`;

    let title = $titleLink.text().trim();
    if (!title) return;
    title = title.replace(/\[\s*\d+\s*\]$/, '').trim();

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
  console.log('[START] 바이크셀 8개 장터 통합 모니터링 프로세스 구동');
  console.log('====================================================');

  const seen = loadSeenIds();
  console.log(`[시스템] 현재 메모리에 로드된 기존 캐시 글 개수: ${seen.size}개`);
  
  const newSeen = new Set(seen);
  const newPosts = [];
  const FILTER_CONFIG = loadFilterConfig();

  for (const board of BOARDS) {
    console.log(`\n[진입] 장터 접속 중: ${board.name}`);
    try {
      const html = await httpGet(board.url);
      const posts = parseList(html, board);
      console.log(`   └ [파싱 완료] 총 ${posts.length}개의 매물 분석 완료.`);
      
      let newCountInBoard = 0;
      posts.forEach(post => {
        if (!newSeen.has(post.id)) {
          console.log(`      [★신규발견] ID: ${post.id} | 제목: ${post.title.substring(0, 25)}... | 작성자: ${post.writer}`);
          newPosts.push(post);
          newSeen.add(post.id);
          newCountInBoard++;
        }
      });
      
      if (newCountInBoard > 0) {
        console.log(`   ➔ 결과: ${board.name}에서 새 글 ${newCountInBoard}건 추가 수집됨`);
      } else {
        console.log(`   ➔ 결과: 업데이트된 새 글이 없습니다.`);
      }
    } catch (e) {
      console.error(`   [🚨오류 발생] ${board.name} 연결 실패:`, e.message);
    }
  }

  console.log('\n====================================================');
  console.log(`[알림단계] 검사 완료. 전송 대기 중인 새 글 총합: ${newPosts.length}건`);
  console.log('====================================================');

  if (newPosts.length === 0) {
    console.log('[INFO] 최종 전송할 새로운 글이 없습니다.');
    // 알림 보낼 글은 없어도 캐시 청소는 검사하고 종료합니다.
    await autoCleanCaches();
    return;
  }

  saveSeenIds(newSeen);

  const groupedData = {};
  BOARDS.forEach(b => { groupedData[b.name] = []; });

  const keywords = Array.isArray(FILTER_CONFIG.KEYWORDS) ? FILTER_CONFIG.KEYWORDS.map(k => k.toLowerCase().trim()) : [];
  const writers = Array.isArray(FILTER_CONFIG.WRITERS) ? FILTER_CONFIG.WRITERS.map(w => w.toLowerCase().trim()) : [];

  for (const post of newPosts) {
    const titleLower = post.title.toLowerCase();
    const writerLower = post.writer.toLowerCase().trim();

    const matchedWriter = writers.find(wr => writerLower.includes(wr));
    const matchedKeyword = keywords.find(kw => titleLower.includes(kw));

    if (matchedWriter) {
      post.matchType = 'WRITER_MATCH';
      post.matchReason = `✨지정게시자 [${matchedWriter}]`;
    } else if (matchedKeyword) {
      post.matchType = 'KEYWORD_MATCH';
      post.matchReason = `키워드 [${matchedKeyword}]`;
    } else {
      post.matchType = 'PERIODIC';
      post.matchReason = '정기 스캔';
    }

    if (groupedData[post.board]) groupedData[post.board].push(post);
  }

  for (const boardName of Object.keys(groupedData)) {
    const postsInBoard = groupedData[boardName];
    if (postsInBoard.length === 0) continue;

    const hasWriterMatch = postsInBoard.some(p => p.matchType === 'WRITER_MATCH');
    const hasKeywordMatch = postsInBoard.some(p => p.matchType === 'KEYWORD_MATCH');
    
    let mainHeaderIcon = '📦';
    let globalReason = '🕒 정기 결과';

    if (hasWriterMatch) {
      mainHeaderIcon = '🚨🚨🚨 [특이게시자 등판] 🚨🚨🚨\n⚡';
      globalReason = '🔥 특별 모니터링';
    } else if (hasKeywordMatch) {
      mainHeaderIcon = '✨';
      globalReason = '🎯 매칭 및 정기 결과';
    }
    
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
      } else if (currentPost.matchType === 'KEYWORD_MATCH') {
        localMessageLines.push(
          `✨ <b>${simpleIdx} ${displayTitle}</b>`,
          `👤 작성자: <code>${displayWriter}</code>`,
          `🎯 <i>키워드 적중: ${displayReason}</i>`,
          `🔗 링크: <a href="${mobileUrl}">[📱모바일]</a> / <a href="${desktopUrl}">[💻PC]</a>\n`
        );
      } else {
        localMessageLines.push(
          `📦 <b>${simpleIdx} ${displayTitle}</b>`,
          `👤 작성자: <code>${displayWriter}</code>`,
          `🔗 링크: <a href="${mobileUrl}">[📱모바일]</a> / <a href="${desktopUrl}">[💻PC]</a>\n`
        );
      }
    });

    localMessageLines.push(`━━━━━━━━━━━━━━━━━━`);
    try {
      await sendTelegramMessage(localMessageLines.join('\n'));
      console.log(`   [OK] 텔레그램 발송 완료 -> ${boardName}`);
    } catch (e) {
      console.error(`   [ERROR] 발송 오류:`, e.message);
    }
  }

  // 모든 프로세스가 끝나고 마지막에 캐시 청소 실행
  await autoCleanCaches();
  console.log('\n[FINISH] 모든 프로세스가 정상 종료되었습니다.');
})();
