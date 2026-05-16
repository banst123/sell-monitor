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
    name: '기타 중고장터 24',
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

  $('tr').each((_, tr) => {
    const $tr = $(tr);
    
    // 1. 게시글 링크 및 고유 번호(seq) 찾기
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

    // 2. 제목 깔끔하게 정제 (댓글 수 꼬리표 삭제)
    let title = $titleLink.text().replace(/\s+/g, ' ').trim();
    title = title.replace(/\[\s*\d+\s*\]$/, '').trim();
    if (!title) return;

    // 🎯 3. [완벽 치트키] 작성자 아이디 정밀 타격 로직
    let writer = '';

    // 바이크셀의 회원 아이디 링크 전용 시그니처 검색 (예: 멤버메뉴 클릭 팝업 링크 등)
    const $writerLink = $tr.find('a[href*="member"], a[href*="menu"], span[class*="writer"], td[onclick*="member"]');
    if ($writerLink.length > 0) {
      const rawText = $writerLink.text().replace(/로그인유지/g, '').trim();
      if (rawText && !/^\d+$/.test(rawText) && rawText.length >= 2) {
        writer = rawText;
      }
    }

    // 만약 위 링크로 잡히지 않는 특수 케이스라면 특정 td 영역 한정 추적
    if (!writer) {
      $tr.find('td').each((idx, td) => {
        const $td = $(td);
        const htmlContent = $td.html() || '';
        
        // 텍스트가 아닌 태그 속성 내부에 숨겨진 진짜 아이디를 정규식으로 기습 추출
        // 비회원 노출용 스크립트 파라미터나 닉네임 속성값 매칭
        const idMatch = htmlContent.match(/['"‘“]([a-zA-Z0-9_]{4,15})['"’”]/);
        if (idMatch && !htmlContent.includes('content.asp') && !htmlContent.includes('WatchList.asp')) {
          const candidate = idMatch[1];
          if (!['window', 'blank', 'center', 'market', 'click', 'true', 'false'].includes(candidate.toLowerCase())) {
            writer = candidate;
            return false;
          }
        }
        
        // 정규식도 안 통하면 시스템 방해어와 숫자가 완전히 배제된 순수 텍스트 칸 도려내기
        const txt = $td.text().trim();
        if (
          txt &&
          txt !== title &&
          !txt.includes('로그인유지') &&
          !txt.includes('중고장터') &&
          !txt.includes('댓글') &&
          !txt.includes('산악') &&
          !/^\d{4}-\d{2}-\d{2}$/.test(txt) &&
          !/^\d+$/.test(txt) &&
          txt.length >= 2 &&
          txt.length <= 15
        ) {
          writer = txt;
        }
      });
    }

    // 모든 수단을 동원해도 못 구한 아주 예외적인 경우에만 기본값 처리
    if (!writer || writer.includes('[') || writer === title) {
      writer = '확인불가(비회원)';
    }

    const id = `seq=${seq}`;
    if (results.some(p => p.id === id)) return;

    results.push({
      id,
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
  console.log('[DEBUG] 모니터링 스크립트 작동 시작...');
  const seen = loadSeenIds();
  const newSeen = new Set(seen);
  const newPosts = [];
  const FILTER_CONFIG = loadFilterConfig();

  try {
    for (const board of BOARDS) {
      let html;
      try { html = await httpGet(board.url); } catch (e) { continue; }
      const posts = parseList(html, board);

      for (const post of posts) {
        if (!seen.has(post.id)) {
          newPosts.push(post);
          newSeen.add(post.id);
        }
      }
    }

    const uniquePosts = Array.from(new Map(newPosts.map((p) => [p.id, p])).values());
    if (uniquePosts.length === 0) {
      console.log('[INFO] 새 글이 없습니다.');
      return;
    }

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
        post.matchReason = '🕒 정기검색 결과';
        if (groupedData[post.board]) groupedData[post.board].push(post);
        continue;
      }

      let matchedKeyword = keywords.find((kw) => titleLower.includes(kw.toLowerCase()));
      let matchedWriter = writers.find((wr) => writerLower.includes(wr.toLowerCase()));

      if (matchedWriter) {
        post.matchType = 'WRITER_MATCH';
        post.matchReason = `👤 지정게시자! (${matchedWriter})`;
        if (groupedData[post.board]) groupedData[post.board].push(post);
      } else if (matchedKeyword) {
        post.matchType = 'KEYWORD_MATCH';
        post.matchReason = `✨ 키워드! (${matchedKeyword})`;
        if (groupedData[post.board]) groupedData[post.board].push(post);
      }
    }

    for (const boardName of Object.keys(groupedData)) {
      const postsInBoard = groupedData[boardName];
      if (postsInBoard.length === 0) continue;

      const sortedPosts = postsInBoard.reverse();
      const hasWriterMatch = sortedPosts.some(p => p.matchType === 'WRITER_MATCH');
      const mainIcon = hasWriterMatch ? '🚨🚨' : '📦';
      const globalReason = sortedPosts[0].matchType === 'PERIODIC' ? '🕒 정기검색 결과' : '✨ 필터 매칭 결과';
      
      let messageLines = [
        `${mainIcon} <b>[${escapeHtml(boardName)}]</b> ${globalReason} (총 ${sortedPosts.length}건)`,
        `━━━━━━━━━━━━━━━━━━`
      ];

      sortedPosts.forEach((post, index) => {
        const safeTitle = escapeHtml(post.title);
        const safeWriter = escapeHtml(post.writer);
        const seqMatch = post.id.match(/seq=(\d+)/);
        const seq = seqMatch ? seqMatch[1] : '';

        let mobileUrl = 'https://bikesell.co.kr';
        let desktopUrl = 'https://bikesell.co.kr';
        if (seq) {
          mobileUrl = post.baseMobileUrl.replace('list.asp', 'content.asp') + `&dolseq=${seq}`;
          desktopUrl = post.baseDesktopUrl.replace('list.asp', 'content.asp') + `&dolseq=${seq}`;
        }

        const writerAlert = post.matchType === 'WRITER_MATCH' ? ' 🚨[특이게시자]' : '';

        messageLines.push(
          `${index + 1}️⃣ <b>${safeTitle}</b>${writerAlert}`,
          `👤 <code>${safeWriter}</code> | 🔗 <a href="${mobileUrl}">[📱모바일]</a> / <a href="${desktopUrl}">[💻PC]</a>\n`
        );
      });

      messageLines.push(`━━━━━━━━━━━━━━━━━━`);
      const finalCombinedText = messageLines.join('\n');

      try {
        await sendTelegramMessage(finalCombinedText);
        console.log(`[OK] ${boardName} 통합 메시지 발송 완료 (${sortedPosts.length}건)`);
      } catch (e) {
        console.error(`[ERROR] ${boardName} 메시지 통합 발송 실패:`, e.message);
      }
    }

    saveSeenIds(newSeen);
  } catch (e) {
    console.error('[FATAL] 에러:', e);
    process.exit(1);
  }
})();
