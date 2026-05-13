// scripts/monitor.js
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

// 목록 HTML 파싱 (텍스트 라인 기반: 제목/조회수/작성자/날짜)
function parseList(html, board) {
  const $ = cheerio.load(html);

  // 리스트 영역만 대략 좁혀서 텍스트 추출 (필요시 셀렉터 조정)
  const listText = $('body').text(); // 우선 전체에서 시작
  const rawLines = listText
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const results = [];

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];

    // 제목 후보: 끝에 [ 숫자 ]가 붙은 라인
    // 예: "DT XRC1501 ...[ 0 ]"
    const titleMatch = line.match(/(.+)\[\s*\d+\s*\]$/);
    if (!titleMatch) continue;

    const title = titleMatch[1].trim();

    // 그 다음 줄 3개가 각각 조회수, 작성자, 날짜라고 가정
    const viewsLine = rawLines[i + 1] || '';
    const writerLine = rawLines[i + 2] || '';
    const dateLine = rawLines[i + 3] || '';

    // 조회수 = 숫자
    const viewsMatch = viewsLine.match(/^(\d+)$/);
    const views = viewsMatch ? viewsMatch[1] : '';

    // 작성자 = 공백 없는 한 덩어리 (한글/영문/숫자)
    const writerMatch = writerLine.match(/^([\w가-힣]+)$/);
    const writer = writerMatch ? writerMatch[1] : '';

    // 날짜 = YYYY-MM-DD
    const dateMatch = dateLine.match(/^(\d{4}-\d{2}-\d{2})$/);
    const date = dateMatch ? dateMatch[1] : '';

    // 최소한 조회수/작성자/날짜가 모두 형태를 만족할 때만 유효 글로 인정
    if (!views || !writer || !date) continue;

    // 제목에 해당하는 a[href*="content.asp"] 링크 찾기
    // 제목 텍스트가 줄바꿈 등으로 조금 달라질 수 있으니, 포함 관계로 느슨하게 매칭
    let href = '';
    $('a[href*="content.asp"]').each((_, a) => {
      const text = $(a).text().replace(/\s+/g, ' ').trim();
      if (!text) return;
      if (title.includes(text) || text.includes(title)) {
        href = $(a).attr('href') || '';
        return false; // break
      }
    });

    if (!href) continue;
    if (href.includes('WatchList.asp')) continue;

    const id = href.trim();

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