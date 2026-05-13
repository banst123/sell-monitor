// scripts/monitor.js
import dotenv from 'dotenv';
dotenv.config();// scripts/monitor.js
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
  console.error('TELEGRAM_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수가 없습니다.');
  process.exit(1);
}

// 모니터링할 게시판들
const BOARDS = [
  {
    name: '산악완성차 중고장터',
    url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET1',
  },
  {
    name: '산악프레임 중고장터',
    url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET2',
  },
  {
    name: '산악 샥포크 중고장터',
    url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET3',
  },
  {
    name: '산악부속 중고장터',
    url: 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET4',
  },
];

// 이미 본 글 ID 저장 파일
const SEEN_FILE = path.join(__dirname, '..', 'seen_posts.json');

function loadSeenIds() {
  try {
    if (!fs.existsSync(SEEN_FILE)) return new Set();
    const raw = fs.readFileSync(SEEN_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr);
  } catch (e) {
    console.error('seen_posts.json 읽기 오류:', e);
    return new Set();
  }
}

function saveSeenIds(set) {
  try {
    const arr = Array.from(set);
    fs.writeFileSync(SEEN_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) {
    console.error('seen_posts.json 저장 오류:', e);
  }
}

// bikesell이 EUC-KR로 응답한다고 가정하고 UTF-8로 디코딩
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
            console.error('Telegram API error:', json);
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

// 목록 HTML 파싱 (BIKESELL 실제 리스트 구조 기준)
function parseList(html, board) {
  const $ = cheerio.load(html);
  const results = [];

  // content.asp로 가는 글 제목 링크만 대상으로
  $('a[href*="content.asp"]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href') || '';
    let titleRaw = $a.text().trim();

    if (!href || !titleRaw) return;

    // 관심게시판(WatchList) 등은 제외
    if (href.includes('WatchList.asp')) return;

    // 제목에서 댓글수 [0] 꼬리 제거 (만약 a 안에 붙어 있다면)
    titleRaw = titleRaw.replace(/\[\s*\d+\s*\]\s*$/, '').trim();

    // a 태그 뒤에 이어진 텍스트/태그에서 조회수 / 작성자 / 날짜 추출
    // 예: "[ 0 ]4[Khc1211]2026-05-14"
    let tail = '';
    let node = a.nextSibling;

    while (node) {
      if (node.type === 'text') {
        tail += node.data;
      } else if (node.type === 'tag') {
        tail += $(node).text();
      }
      if (tail.length > 100) break;
      node = node.nextSibling;
    }

    tail = tail.replace(/\s+/g, ' ').trim();

    // 댓글수 [숫자] 제거
    tail = tail.replace(/\[\s*\d+\s*\]/, '').trim();

    // 조회수(숫자) + 작성자(문자열) + 날짜(YYYY-MM-DD)
    const m = tail.match(/^(\d+)\s*([^\d]+?)\s*(\d{4}-\d{2}-\d{2})$/);

    let views = '';
    let writer = '';
    let date = '';

    if (m) {
      views = m[1].trim();
      writer = m[2].trim();
      date = m[3].trim();
    }

    const id = href.trim();

    let url = href;
    if (href.startsWith('/')) {
      url = 'https://www.bikesell.co.kr' + href;
    } else if (!href.startsWith('http')) {
      url = 'https://www.bikesell.co.kr/' + href.replace(/^\//, '');
    }

    results.push({
      id,
      board: board.name,
      title: titleRaw,
      writer,
      url,
      views,
      date,
    });
  });

  return results;
}

(async () => {
  const seen = loadSeenIds();
  const newSeen = new Set(seen);
  const newPosts = [];

  try {
    for (const board of BOARDS) {
      console.log(`[INFO] ${board.name} 페이지 요청: ${board.url}`);
      let html;
      try {
        html = await httpGet(board.url);
      } catch (e) {
        console.error(`[ERROR] ${board.name} 요청 실패:`, e.message);
        continue;
      }

      const posts = parseList(html, board);
      console.log(`[INFO] ${board.name} 파싱 결과: ${posts.length}개 항목`);

      for (const post of posts) {
        if (!seen.has(post.id)) {
          newPosts.push(post);
          newSeen.add(post.id);
        }
      }
    }

    if (newPosts.length === 0) {
      console.log('[INFO] 새 글 없음');
      return;
    }

    console.log(`[INFO] 새 글 ${newPosts.length}개 발견, 텔레그램 전송`);

    for (const post of newPosts) {
      const text =
        `[${post.board}] 새 글 발견\n` +
        `제목: ${post.title}\n` +
        `작성자: ${post.writer || '(미상)'}\n` +
        `링크: ${post.url}`;

      try {
        await sendTelegramMessage(text);
        console.log('[OK] 메시지 전송:', post.title);
      } catch (e) {
        console.error('[ERROR] 메시지 전송 실패:', e.message);
      }
    }

    saveSeenIds(newSeen);
  } catch (e) {
    console.error('[FATAL] 스크립트 오류:', e);
    process.exit(1);
  }
})();