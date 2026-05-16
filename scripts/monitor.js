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
    if (!fs.existsSync(SEEN_FILE)) {
      console.log('[DEBUG] seen_posts.json 파일이 없어 빈 Set을 생성합니다.');
      return new Set();
    }
    const raw = fs.readFileSync(SEEN_FILE, 'utf8');
    const arr = JSON.parse(raw);
    console.log(`[DEBUG] 불러온 기존 캐시(이미 본 글) 개수: ${arr.length}개`);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr);
  } catch (e) {
    console.error('[ERROR] seen_posts.json 읽기 오류:', e);
    return new Set();
  }
}

function saveSeenIds(set) {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(Array.from(set), null, 2), 'utf8');
    console.log(`[DEBUG] 캐시 업데이트 완료. 현재 총 저장된 글 개수: ${set.size}개`);
  } catch (e) {
    console.error('[ERROR] seen_posts.json 저장 오류:', e);
  }
}

function loadFilterConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      console.log('[WARN] filter_config.json 파일이 없어 전체 알림 모드로 진행합니다.');
      return { KEYWORDS: [], WRITERS: [] };
    }
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(raw);
    console.log('[DEBUG] 로드된 필터 설정:', JSON.stringify(config));
    return config;
  } catch (e) {
    console.error('[ERROR] filter_config.json 읽기 실패, 전체 알림으로 진행:', e.message);
    return { KEYWORDS: [], WRITERS: [] };
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const decoded = iconv.decode(buffer, 'euc-kr');
          resolve(decoded);
        });
      }
    );
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
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) {
            return reject(new Error(json.description || 'Telegram API error'));
          }
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// [완벽 개조] 행(tr) 단위로 쪼갠 뒤 오직 순수 제목 태그에서만 링크를 추출하는 정밀 파서
function parseList(html, board) {
  const $ = cheerio.load(html);
  const results = [];

  // 바이크셀의 모든 게시글 목록 테이블 행(tr)을 순회합니다.
  $('tr').each((_, tr) => {
    const $tr = $(tr);
    
    // 행 내부에서 content.asp 링크를 가진 a 태그들을 찾습니다.
    const $links = $tr.find('a[href*="content.asp"]');
    if ($links.length === 0) return;

    // [핵심 교정] 동일 tr 내에 링크가 여러 개(이미지, 아이콘 등) 있을 경우, 
    // 실제 '글 제목 텍스트'를 품고 있는 온전한 제목 태그 하나만 정밀 필터링합니다.
    let $titleLink = null;
    $links.each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      const text = $a.text().trim();
      
      // 장바구니 링크 제외 및 텍스트가 채워져 있는 본문 제목용 태그 선정
      if (!href.includes('WatchList.asp') && text.length > 1) {
        $titleLink = $a;
        return false; // 매칭되는 진짜 제목 링크를 찾았으므로 루프 조기 종료
      }
    });

    if (!$titleLink) return;

    const href = $titleLink.attr('href') || '';
    const seqMatch = href.match(/seq=(\d+)/) || href.match(/no=(\d+)/);
    if (!seqMatch) return;
    const seq = seqMatch[1];

    // 해당 행(tr)의 전체 텍스트 라인 분할 파싱
    const containerText = $tr.text() || '';
    const lines = containerText.split('\n').map(s => s.trim()).filter(s => s.length > 0);

    // 제목 및 댓글수 제거 가공
    let title = $titleLink.text().replace(/\s+/g, ' ').trim();
    title = title.replace(/\[\s*\d+\s*\]$/, '').trim();

    if (!title) return;

    // 행 내부 데이터에서 작성자 파싱 추출
    let writer = '';
    let views = '';
    let date = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (!views && /^\d+$/.test(line) && line !== seq) {
        views = line;
        continue;
      }
      if (!date && /^\d{4}-\d{2}-\d{2}$/.test(line)) {
        date = line;
        continue;
      }
      if (!writer && /^([\w가-힣]+)$/.test(line) && !line.includes(title) && line !== views && line !== date) {
        writer = line;
      }
    }

    const id = `seq=${seq}`;

    // 행 내부 파싱이므로 중복 등록 방지 처리
    if (results.some(p => p.id === id)) return;

    results.push({
      id,
      board: board.name,
      title,
      writer: writer || '확인불가',
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
      console.log(`\n[INFO] ${board.name} 페이지 요청 중: ${board.url}`);
      let html;
      try {
        html = await httpGet(board.url);
      } catch (e) {
        console.error(`[ERROR] ${board.name} 요청 실패:`, e.message);
        continue;
      }

      const posts = parseList(html, board);
      console.log(`[INFO] ${board.name} 파싱 성공: 총 ${posts.length}개 항목 추출됨`);

      if (posts.length > 0) {
        console.log(`  └─ [파싱샘플 1] 제목: "${posts[0].title}" | 작성자: "${posts[0].writer}"`);
      }

      for (const post of posts) {
        if (!seen.has(post.id)) {
          newPosts.push(post);
          newSeen.add(post.id);
        }
      }
    }

    const uniquePosts = Array.from(new Map(newPosts.map((p) => [p.id, p])).values());
    console.log(`\n[DEBUG] 중복 제거 후 새로 발견된 전체 글 개수: ${uniquePosts.length}개`);

    if (uniquePosts.length === 0) {
      console.log('[INFO] 새로 올라온 글이 아예 없습니다. 종료합니다.');
      return;
    }

    console.log('\n[DEBUG] --- 필터링 조건 검사 시작 ---');
    const filteredPosts = uniquePosts.filter((post) => {
      const titleLower = post.title.toLowerCase();
      const writerLower = (post.writer || '').toLowerCase();

      const keywords = Array.isArray(FILTER_CONFIG.KEYWORDS) ? FILTER_CONFIG.KEYWORDS : [];
      const writers = Array.isArray(FILTER_CONFIG.WRITERS) ? FILTER_CONFIG.WRITERS : [];

      const hasKeywords = keywords.length > 0;
      const hasWriters = writers.length > 0;

      if (!hasKeywords && !hasWriters) {
        return true; 
      }

      const keywordMatches = hasKeywords && keywords.some((kw) => titleLower.includes(kw.toLowerCase()));
      const writerMatches = hasWriters && writers.some((wr) => writerLower.includes(wr.toLowerCase()));

      const isMatch = keywordMatches || writerMatches;
      
      if (isMatch) {
        console.log(`  [매칭성공] 제목: "${post.title}" | 작성자: "${post.writer}"`);
      } else {
        console.log(`  [매칭실패] 제목: "${post.title}" | 작성자: "${post.writer}"`);
      }

      return isMatch;
    });
    console.log('[DEBUG] --- 필터링 조건 검사 종료 ---\n');

    if (filteredPosts.length === 0) {
      console.log('[INFO] 새 글은 감지되었으나 설정한 키워드/게시자 조건에 걸리는 글이 단 하나도 없습니다.');
      saveSeenIds(newSeen);
      return;
    }

    const finalDispatchPosts = filteredPosts.reverse();

    console.log(`[INFO] 최종 필터를 통과한 새 글 ${finalDispatchPosts.length}개 발견, 텔레그램 전송을 실행합니다.`);

    for (const post of finalDispatchPosts) {
      const safeTitle = escapeHtml(post.title);
      const safeWriter = escapeHtml(post.writer || '(미상)');
      const safeBoard = escapeHtml(post.board);

      const seqMatch = post.id.match(/seq=(\d+)/);
      const seq = seqMatch ? seqMatch[1] : '';

      let finalMobileUrl = 'https://bikesell.co.kr';
      let finalDesktopUrl = 'https://bikesell.co.kr';

      if (seq) {
        finalMobileUrl = post.baseMobileUrl.replace('list.asp', 'content.asp') + `&dolseq=${seq}`;
        finalDesktopUrl = post.baseDesktopUrl.replace('list.asp', 'content.asp') + `&dolseq=${seq}`;
      }

      const text =
        `[${safeBoard}] 조건 일치 글 발견!\n` +
        `제목: <b>${safeTitle}</b>\n` +
        `작성자: ${safeWriter}\n` +
        `🔗 <b>링크:</b> <a href="${finalMobileUrl}">[📱 모바일 보기]</a> | <a href="${finalDesktopUrl}">[💻 PC 보기]</a>`;

      try {
        await sendTelegramMessage(text);
        console.log(`  [OK] 전송완료 -> 제목: ${post.title}\n    └─ 모바일: ${finalMobileUrl}\n    └─ 데스크탑: ${finalDesktopUrl}`);
      } catch (e) {
        console.error(`  [ERROR] 전송실패 -> 제목: (${post.title}):`, e.message);
      }
    }

    saveSeenIds(newSeen);
  } catch (e) {
    console.error('[FATAL] 스크립트 처리 중 심각한 오류 발생:', e);
    process.exit(1);
  }
})();
