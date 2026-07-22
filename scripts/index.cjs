const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// 🔑 GitHub Secrets 환경변수 바인딩
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// 파일 저장 경로 정의
const TRACKING_FILE = path.join(process.cwd(), 'bhunt_last_seq.json');
const SETTINGS_FILE = path.join(process.cwd(), 'bhunt_user_settings.json');
const REPORT_BACKUP_FILE = path.join(process.cwd(), 'bhunt_latest_report.txt'); 
const SOLD_DB_FILE = path.join(process.cwd(), 'bhunt_sold_history.json');
const PENDING_DB_FILE = path.join(process.cwd(), 'bhunt_pending_posts.json');
const PURCHASE_DB_FILE = path.join(process.cwd(), 'bhunt_my_purchases.json');

const BIKESELL_CATEGORIES = [
  { top: 'MARKET', section: 'MARKET1',  name: '산악 완성차' },
  { top: 'MARKET', section: 'MARKET2',  name: '산악 프레임' },
  { top: 'MARKET', section: 'MARKET3',  name: '샥, 포크' },
  { top: 'MARKET', section: 'MARKET4',  name: '산악 자전거 부속' },
  { top: 'ROAD',   section: 'ROAD1',    name: '로드 완성차' },
  { top: 'ROAD',   section: 'ROAD2',    name: '로드 프레임' },
  { top: 'ROAD',   section: 'ROAD3',    name: '로드 휠셋' },
  { top: 'ROAD',   section: 'ROAD4',    name: '로드 부속' },
  { top: 'ROAD',   section: 'ROAD5',    name: '로드 용품' },
  { top: 'MARKET', section: 'MARKET31', name: '미니벨로 완성차' },
  { top: 'MARKET', section: 'MARKET34', name: '미니벨로 부속' },
  { top: 'MARKET', section: 'MARKET21', name: '전기 완성차' },
  { top: 'MARKET', section: 'MARKET24', name: '전기 부속품' }
];

// 🎯 타임아웃 30초 (30000ms) 설정
const AXIOS_CONFIG = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    'Origin': 'https://bikesell.co.kr',
    'Referer': 'https://bikesell.co.kr/site/board/list.asp'
  },
  responseType: 'arraybuffer',
  timeout: 30000 // ⚡ 30초 타임아웃
};

function loadSoldDB() {
  if (fs.existsSync(SOLD_DB_FILE)) {
    try { return JSON.parse(fs.readFileSync(SOLD_DB_FILE, 'utf8')); } catch (e) { return []; }
  }
  return [];
}

function saveSoldDB(data) {
  fs.writeFileSync(SOLD_DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function loadPendingDB() {
  if (fs.existsSync(PENDING_DB_FILE)) {
    try { return JSON.parse(fs.readFileSync(PENDING_DB_FILE, 'utf8')); } catch (e) { return []; }
  }
  return [];
}

function savePendingDB(data) {
  fs.writeFileSync(PENDING_DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function loadPurchaseDB() {
  if (fs.existsSync(PURCHASE_DB_FILE)) {
    try { return JSON.parse(fs.readFileSync(PURCHASE_DB_FILE, 'utf8')); } catch (e) { return []; }
  }
  return [];
}

function savePurchaseDB(data) {
  fs.writeFileSync(PURCHASE_DB_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function loadUserSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) { return getDefaultSettings(); }
  }
  return getDefaultSettings();
}

function getDefaultSettings() {
  return {
    bikes: "로드자전거 엘파마 레이다6 1대, MTB 자전거 자이언트 xtc 2011년형, 예거 벤츄라 gx axs, 메리다 e160 900e, 알리산 풀샥프레임에 바팡 48v 750w 모터 장착자전거, 모토벨로 xt7, 코스휠 t20",
    customPrompt: "자가정비(XTR/XT/Di2/AXS/가시마샥 등) 및 배터리 제작 인프라 활용 목적 유지. 구형 하급 배제하되 XT M8000 등 상급 구형은 포함. 완차조립 시 최소 10만원 마진 및 타부품 재활용 가능 품목 최우선. 부산 직거래 및 전국구 압도적 가성비 최상단 배치. [⚠️링크 오류 절대 방어 규정]: 리포트 출력 시 각 매물의 고유 Full URL 주소와 본문 내용, 매물번호(dolseq)가 서로 엉뚱하게 뒤섞이지 않도록 원본 데이터셋을 1:1로 초정밀 대조 검증 후 출력할 것. 시간당 공임 2만원 계산 시 가공/휠빌딩/나사산 전체재생 등 공장급 난이도 및 적자 매물은 즉시 탈락 처리. 5대 지표 엄격 산정 후 합산 48점 이상 탑티어 매물 포착 시 테두리와 제목을 온갖 특수문자와 [심장마비 주의] 대박 초특급 리얼 꿀매물 포착 문구로 도배하여 버스트 서식으로 출력할 것. 기준 미달 시 억지 리포트 쓰지 말고 딱 한 줄 '☕ 이번 주기는 패스합니다.'만 출력."
  };
}

function saveUserSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

function decodeEucKr(buffer) {
  try {
    const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('euc-kr') : new (require('util').TextDecoder)('euc-kr');
    return decoder.decode(buffer);
  } catch (e) { return buffer.toString('utf8'); }
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const maxLength = 4000;
  for (let i = 0; i < text.length; i += maxLength) {
    const chunk = text.substring(i, i + maxLength);
    try {
      await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: chunk, parse_mode: 'Markdown' }, { timeout: 10000 });
      await new Promise(res => setTimeout(res, 200));
    } catch (err) {
      try { await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: chunk }, { timeout: 10000 }); } catch (e) {}
    }
  }
}

let lastUpdateId = 0;
async function checkTelegramCommands() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=3`;
    const res = await axios.get(url, { timeout: 5000 });
    if (!res.data.ok || !res.data.result.length) return;

    for (const update of res.data.result) {
      lastUpdateId = update.update_id;
      if (!update.message || !update.message.text) continue;

      const text = update.message.text.trim();
      let settings = loadUserSettings();
      
      if (text.startsWith('장비:')) {
        settings.bikes = text.replace('장비:', '').trim();
        saveUserSettings(settings);
        await sendTelegramMessage(`⚙️ [장비 변경 완료]\n"${settings.bikes}"`);
      } 
      else if (text.startsWith('지침:')) {
        const newPrompt = text.replace('지침:', '').trim();
        if (settings.customPrompt && settings.customPrompt !== getDefaultSettings().customPrompt) {
          settings.customPrompt = `${settings.customPrompt}\n➔ 추가 지침: ${newPrompt}`;
        } else {
          settings.customPrompt = newPrompt; 
        }
        saveUserSettings(settings);
        await sendTelegramMessage(`💡 [AI 지침 중첩 추가 완료]\n"${settings.customPrompt}"`);
      } 
      else if (text === '/지침') {
        await sendTelegramMessage(`📋 [현재 관제탑 가동 지침 브리핑]\n\n⚙️ **보유 장비:**\n${settings.bikes}\n\n🔥 **수색 및 채점 지침:**\n${settings.customPrompt}`);
      }
      else if (text === '/초기화') {
        if (fs.existsSync(TRACKING_FILE)) fs.unlinkSync(TRACKING_FILE);
        await sendTelegramMessage(`🧹 [초기화 완료] 데이터 기록을 전면 삭제했습니다.`);
      }
    }
  } catch (err) {}
}

function generateLivePrompt(userSettings, textInput, chunkIndex, totalChunks) {
  return `너는 국내 최고의 자전거 중고 마켓 스펙/시세 감정 전문가야. 제공된 매물들을 분석하여 아래 '5대 평가 지표'에 따라 냉정하게 점수를 매기고 보고서를 작성해라. (현재 보고서 진행도: ${chunkIndex}/${totalChunks})

[🚨 철저한 독립형 절대평가 구동 규칙]:
1. **상대평가 완전 전면 금지**: 청크 데이터셋 내부에 들어온 매물들끼리 상호 비교하여 추천 여부나 합격 등수를 매기지 마라!
2. **건수 강제 조정 금지**: 사장님의 '공임 시간당 2만원 마진 가이드라인'과 '장비 인프라' 조건에 부합하는 매물이 10개 이상이면 10개 전부 누락 없이 메인 추천 리포트에 올려야 하며, 단 1개도 기준에 안 맞으면 억지로 지어내지 말고 딱 한 줄 '☕ 이번 주기는 패스합니다.'만 출력.

[분석 요청자의 특수 조건 및 실시간 집중 타깃 가이드라인]:
- 현재 보유 장비 상태: ${userSettings.bikes}
- 🔥 [수색 지침 필터링 핵심]: ${userSettings.customPrompt}

출력 형식:
### 🎯 실시간 엄선 꿀매물 포착 리포트 (${chunkIndex}/${totalChunks})
* **분류 카테고리:** [카테고리명]
* **매물 연결:** - [👉 [페이지 이동]](Full URL 링크 주소)
* **글 제목:** [제목]
* **판매가격:** [가격]
* **📊 5대 지표 감정 스코어:**
  - 💰 가격 점수: [X]/10점 | ⚙️ 활용성: [X]/10점 | 🌐 범용성: [X]/10점 | ⚡ 성능: [X]/10점 | 🛠️ 정비성: [X]/10점
  - 📈 **종합 꿀매 지수:** [5개 점수의 평균치 계산]%
* **추천 이유 및 역발상 전략:** - (여기에 한 칸 엔터와 들여쓰기 적용 후 상세 기술...)

---
### ⚠️ B급 정비 및 부품 적출용 탈락 매물 백업 보드
* **[매물번호: 000000]** [글 제목]
  - **매물 연결:** - [👉 [페이지 이동]](Full URL 링크 주소)
  - ❌ **탈락 사유:** (★무조건 2줄 이내 제한) [이유 완결 서술]

[전체 데이터 셋트]:
${textInput}`;
}

// 🎯 전체 패킷 상세 트레이싱 + 30초 1회 타임아웃 세션 수급 함수
async function getBikesellSession() {
  console.log('\n==================================================');
  console.log('🔬 [전체 패킷 심층 분석 모드] 로그인 시퀀스 가동 (30초 제한)');
  console.log('==================================================');

  // URL 대소문자 및 도메인 정밀 트레이싱
  const loginPageUrl = 'https://bikesell.co.kr/site/im/login.asp';
  const loginOkUrl = 'https://bikesell.co.kr/site/im/login_ok.asp';

  let initialCookie = '';

  // -------------------------------------------------------------------
  // [1단계] GET 로그인 페이지 요청 패킷 분석
  // -------------------------------------------------------------------
  console.log(`\n📤 [GET 요청 패킷]`);
  console.log(`• URL: ${loginPageUrl}`);
  console.log(`• 요청 헤더: ${JSON.stringify(AXIOS_CONFIG.headers, null, 2)}`);

  try {
    const initRes = await axios.get(loginPageUrl, {
      ...AXIOS_CONFIG,
      validateStatus: (status) => status >= 200 && status < 600 // 404/500 에러도 캡처
    });

    console.log(`\n📥 [GET 응답 패킷]`);
    console.log(`• Status Code: ${initRes.status} ${initRes.statusText}`);
    console.log(`• 응답 헤더: ${JSON.stringify(initRes.headers, null, 2)}`);

    if (initRes.headers['set-cookie']) {
      initialCookie = initRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
      console.log(`• 🍪 발급된 Cookie: ${initialCookie}`);
    } else {
      console.log(`• 🍪 발급된 Cookie: 없음`);
    }

    const initBodySnippet = decodeEucKr(initRes.data).replace(/\s+/g, ' ').substring(0, 300);
    console.log(`• 📄 응답 본문 미리보기: "${initBodySnippet}"`);

    if (initRes.status === 404) {
      console.log(`🚨 [404 원인 분석] GET 요청 URL 경로가 올바르지 않거나, 서버에서 직접 차단했습니다.`);
      return '';
    }

  } catch (err) {
    console.log(`🚨 [1단계 GET 네트워크 예외]: ${err.message}`);
    if (err.response) {
      console.log(`• Exception Status: ${err.response.status}`);
      console.log(`• Exception Headers: ${JSON.stringify(err.response.headers, null, 2)}`);
    }
    return '';
  }

  // -------------------------------------------------------------------
  // [2단계] cURL 명령어 출력 (터미널 수동 교차 검증용)
  // -------------------------------------------------------------------
  const payloadString = 'formname=login&dolid=banst123&dolpass=bst511790&idcheck=ON';
  console.log('\n📋 [재현용 cURL 명령어]');
  console.log(`curl -v -X POST "${loginOkUrl}" \\`);
  console.log(`  -H "User-Agent: ${AXIOS_CONFIG.headers['User-Agent']}" \\`);
  console.log(`  -H "Content-Type: application/x-www-form-urlencoded" \\`);
  console.log(`  -H "Referer: ${loginPageUrl}" \\`);
  if (initialCookie) console.log(`  -H "Cookie: ${initialCookie}" \\`);
  console.log(`  --data "${payloadString}"\n`);

  // -------------------------------------------------------------------
  // [3단계] POST 로그인 요청 패킷 분석
  // -------------------------------------------------------------------
  const postHeaders = {
    ...AXIOS_CONFIG.headers,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': initialCookie,
    'Referer': loginPageUrl
  };

  console.log(`📤 [POST 요청 패킷]`);
  console.log(`• URL: ${loginOkUrl}`);
  console.log(`• 요청 헤더: ${JSON.stringify(postHeaders, null, 2)}`);
  console.log(`• Payload Body: ${payloadString}`);

  try {
    const params = new URLSearchParams();
    params.append('formname', 'login');
    params.append('dolid', 'banst123');
    params.append('dolpass', 'bst511790');
    params.append('idcheck', 'ON');

    const loginRes = await axios.post(loginOkUrl, params.toString(), {
      ...AXIOS_CONFIG,
      headers: postHeaders,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 600
    });

    console.log(`\n📥 [POST 응답 패킷]`);
    console.log(`• Status Code: ${loginRes.status} ${loginRes.statusText}`);
    console.log(`• 응답 헤더: ${JSON.stringify(loginRes.headers, null, 2)}`);

    const responseBody = decodeEucKr(loginRes.data);
    const setCookieHeaders = loginRes.headers['set-cookie'];

    if (responseBody.includes('비밀번호가 틀립니다')) {
      console.log('❌ [인증 진단]: "비밀번호가 틀립니다" 경고창 확인');
    } else if (responseBody.includes('존재하지 않는')) {
      console.log('❌ [인증 진단]: "존재하지 않는 아이디" 경고창 확인');
    } else if (responseBody.includes('location.href') || responseBody.includes('main.asp')) {
      console.log('✅ [인증 진단]: 리다이렉션 구문 확인 (로그인 성립)');
    } else {
      const cleanBodySnippet = responseBody.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 200);
      console.log(`📄 [응답 본문 텍스트 요약]: "${cleanBodySnippet}"`);
    }

    let finalCookie = initialCookie;
    if (setCookieHeaders && setCookieHeaders.length > 0) {
      const authCookie = setCookieHeaders.map(c => c.split(';')[0]).join('; ');
      finalCookie = initialCookie ? `${initialCookie}; ${authCookie}` : authCookie;
    }

    console.log(`\n✅ [최종 획득 세션 쿠키]: ${finalCookie || '없음'}\n`);
    return finalCookie;

  } catch (err) {
    console.log(`🚨 [2단계 POST 네트워크 예외]: ${err.message}`);
    if (err.response) {
      console.log(`• Exception Status: ${err.response.status}`);
      console.log(`• Exception Headers: ${JSON.stringify(err.response.headers, null, 2)}`);
    }
  }

  return '';
}

async function runBikesellScanner() {
  const isTrackingFileExists = fs.existsSync(TRACKING_FILE);
  let trackingData = {};
  if (isTrackingFileExists) {
    try { trackingData = JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8')); } catch(e) { trackingData = {}; }
  }
  const updatedTrackingData = { ...trackingData };

  let sessionCookie = await getBikesellSession();
  const requestConfig = { ...AXIOS_CONFIG, headers: { ...AXIOS_CONFIG.headers, 'Cookie': sessionCookie } };
  let allFlattenPosts = []; 

  for (const cat of BIKESELL_CATEGORIES) {
    const trackingKey = `${cat.top}_${cat.section}`;
    const listUrl = `https://bikesell.co.kr/site/board/list.asp?doltop=${cat.top}&dolsection=${cat.section}`;
    let pageItems = []; 

    try {
      const listRes = await axios.get(listUrl, requestConfig);
      const html = decodeEucKr(listRes.data);
      const trMatches = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || [];
      
      for (const tr of trMatches) {
        if (!tr.includes('dolseq=')) continue;
        const seqMatch = tr.match(/dolseq=(\d+)/);
        if (!seqMatch) continue;
        const seq = parseInt(seqMatch[1], 10);
        
        const tdMatches = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
        let dateStr = "";
        for (const td mysterious td of tdMatches) {
          const text = td.replace(/<[^>]*>/g, '').trim();
          if (/[\d]{1,2}(:|-|\.)[\d]{1,2}/.test(text)) dateStr = text;
        }
        if (seq > 0 && dateStr) pageItems.push({ seq, dateStr });
      }
    } catch (err) { continue; }

    if (pageItems.length === 0) continue;
    pageItems.sort((a, b) => b.seq - a.seq);
    const lastExaminedSeq = trackingData[trackingKey] || 0;

    for (const item of pageItems) {
      if (item.seq <= lastExaminedSeq) continue; 
      allFlattenPosts.push({ catName: cat.name, seq: item.seq, dateStr: item.dateStr });
    }

    if (pageItems.length > 0) {
      updatedTrackingData[trackingKey] = Math.max(pageItems[0].seq, lastExaminedSeq);
    }
  }

  let soldDB = loadSoldDB();
  let pendingDB = loadPendingDB();
  let purchaseDB = loadPurchaseDB();
  let finalLivePosts = []; 

  for (const item of allFlattenPosts) {
    const catObj = BIKESELL_CATEGORIES.find(c => c.name === item.catName);
    const targetUrl = `https://bikesell.co.kr/site/board/content.asp?Search=&SearchText=&Page=1&Gotopage=1&doltop=${catObj.top}&dolsection=${catObj.section}&dolseq=${item.seq}&dolcha=&POINT=`;
    
    try {
      const contentRes = await axios.get(targetUrl, requestConfig);
      const contentHtml = decodeEucKr(contentRes.data);
      
      if (contentHtml.includes('비 회원은 확인하실 수 없습니다') || contentHtml.includes('삭제된 게시물')) continue;

      let pureContent = contentHtml.replace(/<[^>]*>/g, ' ');
      const titleMatch = contentHtml.match(/<font[^>]*size=["']?3["']?[^>]*>\s*<b>(.*?)<\/b>/i);
      let pageTitle = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : `글 번호 ${item.seq}`;
      const cleanContent = pureContent.replace(/\s+/g, ' ').trim();

      if (!contentHtml.includes('판매가 완료되었습니다')) {
        finalLivePosts.push({ catName: item.catName, seq: item.seq, url: targetUrl, title: pageTitle, content: cleanContent });
      }
    } catch (e) {}
  }

  if (GEMINI_API_KEY && finalLivePosts.length > 0) {
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    const userSettings = loadUserSettings();
    
    let chunkInput = "";
    finalLivePosts.slice(0, 30).forEach(p => {
      chunkInput += `\n[카테고리]: ${p.catName} | [매물번호]: ${p.seq}\n[링크]: ${p.url}\n[제목]: ${p.title}\n[본문]: ${p.content}\n----------------\n`;
    });

    const livePrompt = generateLivePrompt(userSettings, chunkInput, 1, 1);
    try {
      const response = await ai.models.generateContent({ model: 'gemini-3.1-flash-lite', contents: [{ role: 'user', parts: [{ text: livePrompt }] }], config: { temperature: 0.2 } });
      if (response.text && !response.text.includes('이번 주기가 패스합니다')) {
        await sendTelegramMessage(response.text);
      }
    } catch (err) {}
  }

  fs.writeFileSync(TRACKING_FILE, JSON.stringify(updatedTrackingData, null, 2), 'utf8');
}

// 🎯 단발성 스캔 실행 엔트리
(async () => {
  console.log('📢 [Project B-Hunt] 스캔 프로세스 가동');
  try {
    await checkTelegramCommands();
    await runBikesellScanner();
    console.log('✨ [스캔 완료] 프로세스를 종료합니다.');
  } catch (err) {
    console.error(`🚨 [실행 예외] ${err.message}`);
  }
})();
