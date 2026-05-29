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

// 8개 통합 타겟 장터 목록
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

const SEEN_FILE = path.join(__dirname, '..', 'seen_posts.json');
const CONFIG_FILE = path.join(__dirname, '..', 'filter_config.json');

function loadSeenIds() {
  try {
    if (!fs.existsSync(SEEN_FILE)) return new Set();
    const raw = fs.readFileSync(SEEN_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr);
  } catch (e) {
    return new Set();
  }
}

// 🎯 [수정] 파일 저장 시 200개 검증 및 오래된 100개 압축 로직 추가
function saveSeenIds(set) {
  try {
    let arr = Array.from(set);
    
    if (arr.length >= 200) {
      console.log(`[CACHE_DIET] 캐시가 ${arr.length}개에 도달했습니다. 오래된 데이터 100개를 정리합니다.`);
      // 배열 뒷부분이 최신 수집본이므로, 앞쪽(과거)을 잘라내고 최신 100개만 남김
      arr = arr.slice(-100);
    }

    fs.writeFileSync(SEEN_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) {
    console.error('[ERROR] seen_posts.json 저장 오류:', e);
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

function httpGet(url) {
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
  
  const $trs = $('tr');
  console.log(`    └ [파싱] ${board.name} -> 총 ${$trs.length}개의 행 분석 중...`);

  $trs.each((_, tr) => {
    const $tr = $(tr);
    
    const $links = $tr.find('a[href*="content.asp"]');
    if ($links.length === 0) return;

    let $titleLink = null;
    $links.each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      const text = $a.text().trim();
      if (!href.includes('WatchList.asp') && text.length > 1) {
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

    let title = $titleLink.text().replace(/\s+/g, ' ').trim();
    title = title.replace(/\[\s*\d+\s*\]$/, '').trim();
    if (!title) return;

    let fullRowText = $tr.text().replace(/로그인유지/g, '').replace(/\s+/g, ' ').trim();

    let writer = '일반판매자';
    const dateMatch = fullRowText.match(/([^\s]+)\s+\d{4}-\d{2}-\d{2}/);
    
    if (dateMatch && dateMatch[1]) {
      let rawWriter = dateMatch[1].trim();
      
      if (/^\d+[a-zA-Z가-힣]/.test(rawWriter)) {
        rawWriter = rawWriter.replace(/^\d+/, ''); 
      }

      if (!/중고|장터|산악|완성차|부속|부품|댓글|공지|조회|추천|id|pass/i.test(rawWriter) && rawWriter.length <= 16) {
        writer = rawWriter;
      }
    }

    if (results.some(p => p.id === id)) return;

    results.push({
      id,
      seq,
      board: board.name,
      title,
      writer, 
      baseMobileUrl: board.mobileUrl,
      baseDesktopUrl: board.url,
    });
  });

  return results;
}

(async () => {
  console.log('====================================================');
  console.log('[START] 바이크셀 8개 통합 장터 구동 엔진 (자동 캐시 슬라이싱)');
  console.log('====================================================');

  const seen = loadSeenIds();
  const newSeen = new Set(seen);
  const newPosts = [];
  const FILTER_CONFIG = loadFilterConfig();

  try {
    for (const board of BOARDS) {
      console.log(`[진입] ${board.name} 데이터 수집 중...`);
      let html;
      try { 
        html = await httpGet(board.url); 
      } catch (e) { 
        console.error(`   └ [실패] 연결 오류: ${e.message}`);
        continue; 
      }

      const posts = parseList(html, board);

      for (const post of posts) {
        if (!newSeen.has(post.id)) {
          console.log(`      [★신규발견] ID: ${post.id} | 제목: ${post.title}`);
          newPosts.push(post);
          newSeen.add(post.id); 
        }
      }
    }

    if (newPosts.length === 0) {
      console.log('\n[INFO] 변동 사항 및 새 글이 없습니다. 프로세스를 종료합니다.');
      return;
    }

    saveSeenIds(newSeen);

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

    console.log('\n[알림단계] 텔레그램 메시지 정방향 순서 발송 개시...');
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
          `🛠️ 디버그: <i>${displayReason} (ID: ${currentPost.id})</i>`,
          `🔗 링크: <a href="${mobileUrl}">[📱모바일]</a> / <a href="${desktopUrl}">[💻PC]</a>\n`
        );
      }

      localMessageLines.push(`━━━━━━━━━━━━━━━━━━`);
      const finalCombinedText = localMessageLines.join('\n');

      try {
        await sendTelegramMessage(finalCombinedText);
        console.log(`   [OK] 텔레그램 발송 완료 -> ${boardName}`);
      } catch (e) {
        console.error(`   [ERROR] 발송 실패:`, e.message);
      }
    }
    console.log('\n[FINISH] 모니터링 주기가 안정적으로 종료되었습니다.');

  } catch (e) {
    console.error('[FATAL] 에러 발생:', e);
    process.exit(1);
  }
})();
