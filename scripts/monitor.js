// scripts/monitor.js
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

// 목록 HTML 파싱 (BIKESELL dt/dd 구조 기준)
function parseList(html, board) {
  const $ = cheerio.load(html);
  const results = [];

  // 글 목록 영역에서 dt와 dd가 번갈아 나오는 구조를 가정
  const dts = $('dt'); // 제목/링크/댓글수
  const dds = $('dd'); // 조회수/작성자/날짜

  dts.each((index, dt) => {
    const $dt = $(dt);
    const $dd = $(dds[index]); // 같은 인덱스의 dd를 매칭

    if (!$dd || $dd.length === 0) return;

    // 제목 및 링크
    const titleLink = $dt.find('a').first();
    const titleRaw = titleLink.text().trim(); // 예: "XXX ...[ 0 ]"
    const href = titleLink.attr('href') || '';

    if (!href || !titleRaw) return;

    // 제목에서 댓글수 [0] 부분 제거
    const title = titleRaw.replace(/\[\s*\d+\s*\]\s*$/, '').trim();

    // dd 안의 텍스트에서 조회수 / 작성자 / 날짜 추출
    // 예: "1053\nuilim45\n2026-05-13"
    const ddTextLines = $dd
      .text()
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    let views = '';
    let writer = '';
    let date = '';

    if (ddTextLines.length >= 3) {
      views = ddTextLines[0];  // 조회수
      writer = ddTextLines[1]; // 작성자ID
      date = ddTextLines[2];   // 날짜
    }

    // 관심게시판(WatchList) 링크는 제외
    if (href.includes('WatchList.asp')) return;

    // 실제 글 링크 패턴(l.asp 또는 content.asp)만 허용
    if (!href.includes('l.asp') && !href.includes('content.asp')) return;

    // 글 고유 ID로 href 전체를 사용
    const id = href.trim();

    // 상세 링크 절대 경로 만들기
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

      // 원하면 "새 글 없음"도 텔레그램으로 보내고 싶을 때 주석 해제
      /*
      const now = new Date().toISOString();
      const text =
        `BikeSell 모니터링 결과\n` +
        `시간: ${now}\n` +
        `대상 게시판: ${BOARDS.map((b) => b.name).join(', ')}\n` +
        `새 글: 없음`;

      try {
        await sendTelegramMessage(text);
        console.log('[OK] 새 글 없음 메시지 전송');
      } catch (e) {
        console.error('[ERROR] 새 글 없음 메시지 전송 실패:', e.message);
      }
      */

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