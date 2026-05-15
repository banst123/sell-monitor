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
  console.error('TELEGRAM_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수가 없습니다.');
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
    fs.writeFileSync(SEEN_FILE, JSON.stringify(Array.from(set), null, 2), 'utf8');
  } catch (e) {
    console.error('seen_posts.json 저장 오류:', e);
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
      disable_web_page_preview: false,
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

function normalizeId(href) {
  try {
    const u = new URL(href, 'https://www.bikesell.co.kr');
    const seq = u.searchParams.get('seq') || u.searchParams.get('no') || u.searchParams.get('num') || u.searchParams.get('idx') || '';
    if (seq) return `${u.pathname}?seq=${seq}`;
    return u.pathname;
  } catch {
    return href.trim();
  }
}

function parseList(html, board) {
  const $ = cheerio.load(html);
  const listText = $('body').text();

  const rawLines = listText
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const results = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const titleMatch = line.match(/(.+)\[\s*\d+\s*\]$/);
    if (!titleMatch) continue;

    const title = titleMatch[1].trim();
    const viewsLine = rawLines[i + 1] || '';
    const writerLine = rawLines[i + 2] || '';
    const dateLine = rawLines[i + 3] || '';

    const viewsMatch = viewsLine.match(/^(\d+)$/);
    const views = viewsMatch ? viewsMatch[1] : '';

    const writerMatch = writerLine.match(/^([\w가-힣]+)$/);
    const writer = writerMatch ? writerMatch[1] : '';

    const dateMatch = dateLine.match(/^(\d{4}-\d{2}-\d{2})$/);
    const date = dateMatch ? dateMatch[1] : '';

    if (!views || !writer || !date) continue;

    let href = '';
    $('a[href*="content.asp"]').each((_, a) => {
      const text = $(a).text().replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (title.includes(text) || text.includes(title)) {
        href = $(a).attr('href') || '';
        return false;
      }
    });

    if (!href) continue;
    if (href.includes('WatchList.asp')) continue;

    const id = normalizeId(href);

    let url;
    try {
      url = new URL(href, 'https://www.bikesell.co.kr/site/board/').toString();
    } catch {
      url = 'https://www.bikesell.co.kr';
    }

    results.push({
      id,
      board: board.name,
      title,
      writer,
      url,
      views,
      date,
      mobileUrl: board.mobileUrl,
    });
  }

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

    const uniquePosts = Array.from(new Map(newPosts.map((p) => [p.id, p])).values());

    if (uniquePosts.length === 0) {
      console.log('[INFO] 새 글 없음');
      return;
    }

    console.log(`[INFO] 새 글 ${uniquePosts.length}개 발견, 텔레그램 전송`);

    for (const post of uniquePosts) {
      const text =
        `[${post.board}] 새 글 발견\n` +
        `제목: ${post.title}\n` +
        `작성자: ${post.writer || '(미상)'}\n` +
        `모바일 보기: ${post.mobileUrl}`;

      try {
        await sendTelegramMessage(text);
        console.log('[OK] 메시지 전송:', post.title, '/', post.writer || '(미상)');
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
