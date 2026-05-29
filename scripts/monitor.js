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

function saveSeenIds(set) {
  try {
    let arr = Array.from(set);
    if (arr.length >= 200) {
      console.log(`[CACHE_DIET] 캐시가 ${arr.length}개에 도달했습니다. 오래된 데이터 100개를 정리합니다.`);
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

// 🎯 [완전 복구] 화면 복사본 기반 라인 스캔 파서
function parseList(html, board) {
  const $ = cheerio.load(html);
  const results = [];

  // 1단계: 글 고유 seq 번호를 미리 다 뽑아서 맵에 보관 (오동작 방지)
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

  // 2단계: 전체 텍스트 덤프 후 줄바꿈 단위 전처리
  const pageText = $('body').text();
  const lines = pageText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

  // 3단계: 패턴 추적 루프
  for (let i = 0; i < lines.length - 1; i++) {
    const currentLine = lines[i];
    const nextLine = lines[i + 1];

    // 날짜/시간 포맷 매칭 조건 (오늘 시간 및 일자 전체 대응)
    const dateRegex = /(\d{4}-\d{2}-\d{2})|((오전|오후)\s*\d+:\d+)|(^\d{2}:\d{2}$)/;

    // 만약 다음 줄(i+1)이 날짜 데이터라면, 현재 줄(i)에 [제목]과 [조회수+닉네임]이 뭉쳐서 들어있음
    if (dateRegex.test(nextLine)) {
      
      // 복사본 패턴 검정 정규식: 제목 끝부분 -> 조회수(숫자) + 닉네임(문자)
      // 예시: 첼로 xc80 17인치[ 0 ] 224tearu  또는  에스웍 프레임[ 2 ] 291syccowboy
      const match = currentLine.match(/(.*?)(?:\[\s*\d+\s*\])?\s+(\d+)([a-zA-Z가-힣0-9_]+)$/);

      if (match) {
        let title = match[1].replace(/\s+/g, ' ').trim();
        const hitCount = match[2];
        let writer = match[3].trim();

        // 상단 공지사항, 불필요 영역 스킵
        if (/중고|장터|산악|완성차|부속|부품|댓글|공지|조회|추천|현재위치|로그인/i.test(writer) || writer.length > 16) {
          continue;
        }
        if (title.length < 2 || /현재위치/i.test(title)) {
          continue;
        }

        // seq 매핑
        let seq = seqMap.get(title);
        if (!seq) {
          // 공백 등 미세 차이가 있을 경우 유사 검색
          for (let [tKey, sVal] of seqMap.entries()) {
            if (tKey.includes(title) || title.includes(tKey)) {
              seq = sVal;
              break;
            }
          }
        }

        if (!seq) continue;

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

  console.log(`    └ [파싱 완료] ${board.name} -> 총 ${results.length}개 유효 매물 정제됨`);
  return results;
}

(async () => {
  console.log('====================================================');
  console.log('[START] 바이크셀 8개 통합 장터 구동 엔진 (완전 복구 라인 스캔 방식)');
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
