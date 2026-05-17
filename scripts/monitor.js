import * as dotenv from "dotenv";
dotenv.config();

import https from "https";
import fs from "fs";
import path from "path";
import * as cheerio from "cheerio";
import iconv from "iconv-lite";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TOKEN || !CHAT_ID) {
  console.error(
    "[FATAL] TELEGRAM_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수가 없습니다."
  );
  process.exit(1);
}

const BOARDS = [
  {
    name: "산악완성차 중고장터",
    url: "https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET1",
    mobileUrl: "https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET1",
  },
  {
    name: "산악프레임 중고장터",
    url: "https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET2",
    mobileUrl: "https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET2",
  },
  {
    name: "산악 샥포크 중고장터",
    url: "https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET3",
    mobileUrl: "https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET3",
  },
  {
    name: "산악부속 중고장터",
    url: "https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET4",
    mobileUrl: "https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET4",
  },
  {
    name: "전기자전거 부품장터",
    url: "https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET24",
    mobileUrl: "https://bikesell.co.kr/site/m/list.asp?doltop=MARKET&dolsection=MARKET24",
  },
];

const SEEN_FILE = path.join(__dirname, "..", "seen_posts.json");
const CONFIG_FILE = path.join(__dirname, "..", "filter_config.json");

// --------------------------
// 공통 유틸
// --------------------------

function loadSeenIds() {
  try {
    if (!fs.existsSync(SEEN_FILE)) return new Set();
    const raw = fs.readFileSync(SEEN_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveSeenIds(set) {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(Array.from(set), null, 2), "utf8");
  } catch (e) {
    console.error("[ERROR] seen_posts.json 저장 오류:", e);
  }
}

function loadFilterConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { KEYWORDS: [], WRITERS: [] };
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    return JSON.parse(raw);
  } catch {
    return { KEYWORDS: [], WRITERS: [] };
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve(iconv.decode(Buffer.concat(chunks), "euc-kr"))
        );
      }
    );
    req.on("error", (err) => reject(err));
  });
}

function sendTelegramMessage(text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
    const options = {
      hostname: "api.telegram.org",
      path: `/bot${TOKEN}/sendMessage`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", (err) => reject(err));
    req.write(payload);
    req.end();
  });
}

function escapeHtml(text) {
  return (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --------------------------
// 핵심: 텍스트 기반 파서
// --------------------------
//
// 게시판 HTML -> 텍스트만 추출 -> 줄 단위 파싱
// 패턴:
// [제목](링크)[ 0 ]
// 조회수
// [작성자](javascript:Popup(...);)
// YYYY-MM-DD

function extractPlainTextFromHtml(html) {
  const $ = cheerio.load(html);
  // 화면에 보이는 텍스트 전체
  const bodyText = $("body").text() || "";
  return bodyText;
}

/**
 * bikesell 리스트 텍스트를 파싱해
 * { title, author, views, date } 배열을 반환
 */
function parseBikeSellListText(rawText) {
  const lines = rawText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const posts = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // YYYY-MM-DD 꼴 날짜 라인 찾기
    if (/^\d{4}-\d{2}-\d{2}$/.test(line)) {
      const dateLine = line;
      const authorLine = lines[i - 1] || "";
      const viewsLine = lines[i - 2] || "";
      const titleLine = lines[i - 3] || "";

      // 작성자: [작성자](...)
      let author = authorLine;
      const authorMatch = authorLine.match(/^\[(.+?)\]/);
      if (authorMatch) {
        author = authorMatch[1];
      }

      // 제목: [제목](링크) 또는 [제목]
      let title = titleLine;
      const titleMatch = titleLine.match(/^\[(.+?)\]/);
      if (titleMatch) {
        title = titleMatch[1];
      }

      // 조회수: 숫자 한 줄
      let views = null;
      const viewsMatch = viewsLine.match(/^\d+$/);
      if (viewsMatch) {
        views = parseInt(viewsMatch[0], 10);
      }

      posts.push({
        title,
        author,
        views,
        date: dateLine,
      });
    }
  }

  return posts;
}

// --------------------------
// seq(dolseq) 추출용: a[href*="content.asp"]에서
// --------------------------

function parseSeqFromHtml(html) {
  const $ = cheerio.load(html);
  const map = new Map(); // title -> seq

  $("a[href*='content.asp']").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href") || "";
    const txt = $a.text().trim();
    if (!txt) return;

    const seqMatch =
      href.match(/dolseq=(\d+)/) ||
      href.match(/seq=(\d+)/) ||
      href.match(/no=(\d+)/);
    if (!seqMatch) return;

    const seq = seqMatch[1];
    // 같은 제목이 여러 번 있어도 마지막으로 본 것을 사용
    map.set(txt, seq);
  });

  return map;
}

// --------------------------
// 메인 로직
// --------------------------

(async () => {
  console.log("[DEBUG] bikesell 모니터(텍스트 파싱 버전) 시작...");
  const seen = loadSeenIds();
  const newSeen = new Set(seen);
  const newPosts = [];
  const FILTER_CONFIG = loadFilterConfig();

  try {
    for (const board of BOARDS) {
      let html;
      try {
        html = await httpGet(board.url);
      } catch (e) {
        console.error(`[WARN] ${board.name} HTML 가져오기 실패:`, e.message);
        continue;
      }

      // 1) 텍스트 기반으로 제목/작성자/조회수/날짜 파싱
      const plain = extractPlainTextFromHtml(html);
      const parsedList = parseBikeSellListText(plain);

      // 2) seq(dolseq) 매핑: 제목 텍스트 기준
      const seqMap = parseSeqFromHtml(html);

      // 3) 게시글 객체 구성
      for (const item of parsedList) {
        // 제목에서 seq 찾기 (완전히 같은 문자열일 필요가 있어서, 필요하면 나중에 보강)
        const seq = seqMap.get(item.title);
        if (!seq) {
          // seq가 꼭 필요 없으면 이 return을 주석처리해도 됨
          // (링크 없이 제목만 알림 보내기)
          continue;
        }

        const id = `seq=${seq}`;
        if (newSeen.has(id)) continue;

        newSeen.add(id);

        newPosts.push({
          id,
          board: board.name,
          title: item.title,
          writer: item.author || "일반판매자",
          views: item.views,
          date: item.date,
          baseMobileUrl: board.mobileUrl,
          baseDesktopUrl: board.url,
        });
      }
    }

    const uniquePosts = Array.from(
      new Map(newPosts.map((p) => [p.id, p])).values()
    );

    if (uniquePosts.length === 0) {
      console.log("[INFO] 새 글이 없습니다.");
      return;
    }

    // 새로 본 글 저장
    saveSeenIds(newSeen);

    // 필터 적용 및 보드별 그룹화
    const groupedData = {};
    BOARDS.forEach((b) => {
      groupedData[b.name] = [];
    });

    const keywords = Array.isArray(FILTER_CONFIG.KEYWORDS)
      ? FILTER_CONFIG.KEYWORDS
      : [];
    const writers = Array.isArray(FILTER_CONFIG.WRITERS)
      ? FILTER_CONFIG.WRITERS
      : [];
    const hasFilters = keywords.length > 0 || writers.length > 0;

    for (const post of uniquePosts) {
      const titleLower = post.title.toLowerCase();
      const writerLower = post.writer.toLowerCase();

      if (!hasFilters) {
        post.matchType = "PERIODIC";
        post.matchReason = "검색 조건 없음 (정기 스캔)";
        if (groupedData[post.board]) groupedData[post.board].push(post);
        continue;
      }

      const matchedWriter = writers.find((wr) =>
        writerLower.includes(wr.toLowerCase())
      );
      const matchedKeyword = keywords.find((kw) =>
        titleLower.includes(kw.toLowerCase())
      );

      if (matchedWriter) {
        post.matchType = "WRITER_MATCH";
        post.matchReason = `지정게시자 필터 감지 [${matchedWriter}]`;
        if (groupedData[post.board]) groupedData[post.board].push(post);
      } else if (matchedKeyword) {
        post.matchType = "KEYWORD_MATCH";
        post.matchReason = `키워드 필터 감지 [${matchedKeyword}]`;
        if (groupedData[post.board]) groupedData[post.board].push(post);
      }
    }

    // 보드별 텔레그램 발송
    for (const boardName of Object.keys(groupedData)) {
      const postsInBoard = groupedData[boardName];
      if (postsInBoard.length === 0) continue;

      const sortedPosts = postsInBoard.reverse();
      const hasWriterMatch = sortedPosts.some(
        (p) => p.matchType === "WRITER_MATCH"
      );
      const mainIcon = hasWriterMatch ? "🚨🚨" : "📦";
      const globalReason =
        sortedPosts[0].matchType === "PERIODIC"
          ? "🕒 정기검색 결과"
          : "✨ 필터 매칭 결과";

      const msg = [];

      msg.push(
        `${mainIcon} <b>[${escapeHtml(
          boardName
        )}]</b> ${globalReason} (총 ${sortedPosts.length}건)`
      );
      msg.push(`━━━━━━━━━━━━━━━━━━`);

      for (let i = 0; i < sortedPosts.length; i++) {
        const p = sortedPosts[i];
        const displayTitle = escapeHtml(p.title);
        const displayWriter = escapeHtml(p.writer);
        const displayReason = escapeHtml(p.matchReason || "");

        const seqMatch = p.id.match(/seq=(\d+)/);
        const seq = seqMatch ? seqMatch[1] : "";

        let mobileUrl = "https://bikesell.co.kr";
        let desktopUrl = "https://bikesell.co.kr";
        if (seq) {
          mobileUrl =
            p.baseMobileUrl.replace("list.asp", "content.asp") +
            `&dolseq=${seq}`;
          desktopUrl =
            p.baseDesktopUrl.replace("list.asp", "content.asp") +
            `&dolseq=${seq}`;
        }

        const writerAlert =
          p.matchType === "WRITER_MATCH" ? " 🚨[특이게시자]" : "";
        const simpleIdx = `${i + 1}.`;

        msg.push(
          `<b>${simpleIdx} ${displayTitle}</b>${writerAlert}`,
          `👤 작성자: <code>${displayWriter}</code>`,
          `📅 날짜: <code>${p.date || "-"}</code>`,
          `🛠️ 디버그: <i>${displayReason} (ID: ${p.id})</i>`,
          `🔗 링크: <a href="${mobileUrl}">[📱모바일]</a> / <a href="${desktopUrl}">[💻PC]</a>\n`
        );
      }

      msg.push(`━━━━━━━━━━━━━━━━━━`);

      const finalText = msg.join("\n");

      try {
        await sendTelegramMessage(finalText);
        console.log(
          `[OK] ${boardName} 통합 메시지 발송 완료 (${sortedPosts.length}건)`
        );
      } catch (e) {
        console.error(
          `[ERROR] ${boardName} 메시지 통합 발송 실패:`,
          e.message
        );
      }
    }
  } catch (e) {
    console.error("[FATAL] 에러:", e);
    process.exit(1);
  }
})();
