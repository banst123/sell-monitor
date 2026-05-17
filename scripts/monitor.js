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

const BOARDS = [
  {
    name: '산악완성차 중고장터',
    url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET1',
    mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET1',
  },
  {
    name: '산악프레임 중고장터',
    url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET2',
    mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET2',
  },
  {
    name: '산악 샥포크 중고장터',
    url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET3',
    mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET3',
  },
  {
    name: '산악부속 중고장터',
    url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET4',
    mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET4',
  },
  {
    name: '전기자전거 부품장터',
    url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET24',
    mobileUrl: 'https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET24',
  },
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

function saveSeenIds(set) {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(Array.from(set), null, 2), 'utf8');
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
  console.log(`   └ [파싱] 총 ${$trs.length}개의 행(tr) 발견. 데이터 매칭 분석 시작...`);

  $trs.each((i, tr) => {
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
    const seqMatch = href.match(/seq=(\d+)/) || href.match(/no=(\d+)/);
    if (!seqMatch) return;
    const seq = seqMatch[1];

    let title = $titleLink.text().replace(/\s+/g, ' ').trim();
    title = title.replace(/\[\s*\d+\s*\]$/, '').trim();
    if (!title) return;

    // 🎯 행 전체 텍스트 추출 디버깅 로그 연동
    let fullRowText = $tr.text().replace(/로그인유지/g, '').replace(/\s+/g, ' ').trim();

    let writer = '일반판매자';
    const dateMatch = fullRowText.match(/([^\s]+)\s+\d{4}-\d{2}-\d{2}/);
    
    if (dateMatch && dateMatch[1]) {
      let rawWriter = dateMatch[1].trim();
      if (!/중고|장터|산악|완성차|부속|부품|댓글|공지|조회|추천|id|pass/i.test(rawWriter) && rawWriter.length <= 16) {
        writer = rawWriter;
      }
    }

    const id = `seq=${seq}`;
    if (results.some(p => p.id === id)) return;

    // 추출과정 한줄 요약 로그 출력 (원시 텍스트 및 분리 결과 파악용)
    console.log(`      -> [매칭성공] ID: ${id} | 제목: ${title.slice(0, 15)}... | 추출작성자: ${writer}`);

    results.push({
      id,
      board: board.name,
      title,
      writer, 
      baseMobileUrl: board.mobileUrl,
      baseDesktopUrl: board.url,
    });
  });

  console.log(`   └ [완료] ${board.name} 유효 게시글 추출 완료 (총 ${results.length}건)`);
  return results;
}

(async () => {
  console.log('====================================================');
  console.log('[START] 바이크셀 중고장터 실시간 모니터링 프로세스 구동');
  console.log('====================================================');

  const seen = loadSeenIds();
  console.log(`[INIT] 기존에 전송 완료된 게시글 캐시 로드완료: 총 ${seen.size}개`);

  const newSeen = new Set(seen);
  const newPosts = [];
  const FILTER_CONFIG = loadFilterConfig();
  console.log(`[INIT] 필터 설정 로드완료 - 키워드: [${FILTER_CONFIG.KEYWORDS || ''}], 작성자: [${FILTER_CONFIG.WRITERS || ''}]`);

  try {
    for (const board of BOARDS) {
      console.log(`\n[진입] 장터 접속 중: ${board.name}`);
      console.log(`   └ URL: ${board.url}`);
      
      let html;
      try { 
        html = await httpGet(board.url); 
        console.log(`   └ [성공] HTML 소스 수신 완료 (${Buffer.byteLength(html)} bytes)`);
      } catch (e) { 
        console.error(`   └ [실패] 해당 장터 데이터를 가져오지 못했습니다: ${e.message}`);
        continue; 
      }

      const posts = parseList(html, board);

      for (const post of posts) {
        if (!newSeen.has(post.id)) {
          console.log(`      [★신규발견] 새 게시글 등록 감지 -> ID: ${post.id}, 제목: ${post.title}`);
          newPosts.push(post);
          newSeen.add(post.id); 
        }
      }
    }

    console.log('\n====================================================');
    console.log(`[스캔결과 확인] 새롭게 수집된 전체 신규 게시글 수: 총 ${newPosts.length}건`);
    console.log('====================================================');

    const uniquePosts = Array.from(new Map(newPosts.map((p) => [p.id, p])).values());
    
    if (uniquePosts.length === 0) {
      console.log('[INFO] 새로 등록된 게시글이 없어 모니터링을 종료합니다.');
      return;
    }

    // 파일 저장
    saveSeenIds(newSeen);
    console.log(`[SYSTEM] 락 파일(seen_posts.json) 갱신 완료.`);

    const groupedData = {};
    BOARDS.forEach(b => { groupedData[b.name] = []; });

    for (const post of uniquePosts) {
      const titleLower = post.title.toLowerCase();
      const writerLower = post.writer.toLowerCase();

      const keywords = Array.isArray(FILTER_CONFIG.KEYWORDS) ? FILTER_CONFIG.KEYWORDS : [];
      const writers = Array.isArray(FILTER_CONFIG.WRITERS) ? FILTER_CONFIG.WRITERS : [];

      const hasFilters = keywords.length > 0 || writers.length > 0;

      if (!hasFilters) {
        post.matchType = 'PERIODIC';
        post.matchReason = '검색 조건 없음 (정기 스캔)';
        if (groupedData[post.board]) groupedData[post.board].push(post);
        continue;
      }

      let matchedWriter = writers.find((wr) => writerLower.includes(wr.toLowerCase()));
      let matchedKeyword = keywords.find((kw) => titleLower.includes(kw.toLowerCase()));

      if (matchedWriter) {
        post.matchType = 'WRITER_MATCH';
        post.matchReason = `지정게시자 필터 감지 [${matchedWriter}]`;
        if (groupedData[post.board]) groupedData[post.board].push(post);
        console.log(`   -> [필터적중] 작성자 일치함: ${post.writer} (${post.title.slice(0,15)}...)`);
      } else if (matchedKeyword) {
        post.matchType = 'KEYWORD_MATCH';
        post.matchReason = `키워드 필터 감지 [${matchedKeyword}]`;
        if (groupedData[post.board]) groupedData[post.board].push(post);
        console.log(`   -> [필터적중] 키워드 포함됨: [${matchedKeyword}] 인지함 (${post.title.slice(0,15)}...)`);
      }
    }

    console.log('\n[알림단계] 텔레그램 메시지 빌드 및 발송 제어 개시...');
    for (const boardName of Object.keys(groupedData)) {
      const postsInBoard = groupedData[boardName];
      if (postsInBoard.length === 0) continue;

      const sortedPosts = postsInBoard.reverse();
      const hasWriterMatch = sortedPosts.some(p => p.matchType === 'WRITER_MATCH');
      const mainIcon = hasWriterMatch ? '🚨🚨' : '📦';
      const globalReason = sortedPosts[0].matchType === 'PERIODIC' ? '🕒 정기검색 결과' : '✨ 필터 매칭 결과';
      
      const localMessageLines = [
        `${mainIcon} <b>[${escapeHtml(boardName)}]</b> ${globalReason} (총 ${sortedPosts.length}건)`,
        `━━━━━━━━━━━━━━━━━━`
      ];

      for (let i = 0; i < sortedPosts.length; i++) {
        const currentPost = sortedPosts[i];
        
        const displayTitle = escapeHtml(currentPost.title);
        const displayWriter = escapeHtml(currentPost.writer); 
        const displayReason = escapeHtml(currentPost.matchReason);
        
        const seqMatch = currentPost.id.match(/seq=(\d+)/);
        const seq = seqMatch ? seqMatch[1] : '';

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
        console.log(`   [OK] 텔레그램 발송 완료 -> ${boardName} (${sortedPosts.length}건)`);
      } catch (e) {
        console.error(`   [ERROR] 텔레그램 발송 누락 -> ${boardName} 에러:`, e.message);
      }
    }
    console.log('\n[FINISH] 모니터링 주기 안전하게 완전히 종료되었습니다.');

  } catch (e) {
    console.error('[FATAL] 모니터링 스크립트 실행 중 치명적 에러 발생:', e);
    process.exit(1);
  }
})();
