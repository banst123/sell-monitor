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

    // 🎯 [구조적 정밀 타격 파싱] 
    // 바이크셀의 td 구조상 3번째 혹은 4번째 td에 작성자 정보가 위치함
    let writer = '';
    $tr.find('td').each((idx, td) => {
      const tdText = $(td).text().trim();
      
      // 진짜 아이디는 대개 영문/숫자 혼합이며, '로그인유지/중고장터/조회수' 등의 고정 단어들을 비껴감
      if (
        tdText && 
        !tdText.includes('로그인유지') && 
        !tdText.includes('중고장터') && 
        !tdText.includes('댓글') && 
        !/^\d{4}-\d{2}-\d{2}$/.test(tdText) && // 날짜 제외
        !/^\d+$/.test(tdText) // 조회수 및 순번 제외
      ) {
        // 장터 분류 텍스트(산악완성차 등)가 포함된 경우 깨끗하게 지우고 순수 아이디만 추출
        let cleanText = tdText
          .replace(/산악/g, '')
          .replace(/완성차/g, '')
          .replace(/프레임/g, '')
          .replace(/부속/g, '')
          .replace(/샥포크/g, '')
          .replace(/기타/g, '')
          .replace(/\[\d+\]/g, '')
          .trim();

        if (cleanText.length >= 2 && cleanText.length <= 20) {
          writer = cleanText;
        }
      }
    });

    const id = `seq=${seq}`;
    if (results.some(p => p.id === id)) return;

    results.push({
      id,
      board: board.name,
      title,
      writer: writer || '로그인유지', 
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
