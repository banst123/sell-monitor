// scripts/monitor.js
import https from 'https';
import fs from 'fs';
import path from 'path';
import cheerio from 'cheerio';
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
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
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

// ★ 여기 셀렉터 부분이 실제 HTML과 다를 수 있으니, 필요하면 나중에 미세 조정
function parseList(html, board) {
  const $ = cheerio.load(html);

  const results = [];

  // 추정: 글 목록이 하나의 table 안에 있고, 각 글이 <tr>로 구성
  // 번호/제목/작성자/날짜 구조를 가정
  $('table tr').each((_, tr) => {
    const $tr = $(tr);
    const tds = $tr.find('td');

    if (tds.length < 4) return; // 헤더나 이상한 줄은 스킵

    const numText = $(tds[0]).text().trim();
    const titleLink = $(tds[1]).find('a').first();
    const title = titleLink.text().trim();
    const href = titleLink.attr('href') || '';
    const writer = $(tds[2]).text().trim();

    // 번호/제목/링크가 없는 줄은 스킵
    if (!title || !href) return;

    // 글 고유 ID는 href 전체를 기준으로 사용 (또는 번호)
    const id = href.trim() || numText;

    // 상세 링크 절대 경로로 만들기
    let url = href;
    if (href.startsWith('/')) {
      url = 'https://www.bikesell.co.kr' + href;
    } else if (!href.startsWith('http')) {
      url = 'https://www.bikesell.co.kr/' + href.replace(/^\//, '');
    }

    results.push({
      id,
      board: board.name,
      title,
      writer,
      url,
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
        `작성자: ${post.writer}\n` +
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