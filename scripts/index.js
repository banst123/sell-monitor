const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// 🔑 구글 API 키 및 텔레그램 환경변수 바인딩
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// 파일 저장 경로 정의
const TRACKING_FILE = path.join(process.cwd(), 'last_seq.json');
const SETTINGS_FILE = path.join(process.cwd(), 'user_settings.json');
const REPORT_BACKUP_FILE = path.join(process.cwd(), 'latest_report.txt'); 
const SOLD_DB_FILE = path.join(process.cwd(), 'sold_history.json');       // 누적 완판 마트
const PENDING_DB_FILE = path.join(process.cwd(), 'pending_posts.json');   // 실시간 가격 실드 DB
const PURCHASE_DB_FILE = path.join(process.cwd(), 'my_purchases.json');   // 사장님 직매입 전용 장부

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

const AXIOS_CONFIG = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Origin': 'https://bikesell.co.kr',
    'Referer': 'https://bikesell.co.kr/site/board/list.asp'
  },
  responseType: 'arraybuffer',
  timeout: 30000 // 바이크셀 랙 유발 방지용 대기시간 30초 상향 보정
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
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('🚨 [오류] TELEGRAM_BOT_TOKEN 또는 TELEGRAM_CHAT_ID 환경변수가 설정되지 않았습니다.');
    return;
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const maxLength = 4000;
  for (let i = 0; i < text.length; i += maxLength) {
    const chunk = text.substring(i, i + maxLength);
    try {
      await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: chunk, parse_mode: 'Markdown' });
      await new Promise(res => setTimeout(res, 500));
    } catch (err) {
      try { await axios.post(url, { chat_id: TELEGRAM_CHAT_ID, text: chunk }); } catch (e) {}
    }
  }
}

let lastUpdateId = 0;
async function checkTelegramCommands() {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`;
    const res = await axios.get(url);
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
        console.log('🧹 [원격 로그] 기록 파일(last_seq.json) 강제 파괴 완료.');
        await sendTelegramMessage(`🧹 [초기화 완료] 데이터 기록을 전면 삭제했습니다.`);
      }
      else if (text.startsWith('구매:')) {
        try {
          const rawPayload = text.replace('구매:', '').trim();
          const parts = rawPayload.split(/\s+/);
          const targetSeq = parseInt(parts[0], 10);
          let inputPrice = parseInt(parts[1], 10);

          if (!targetSeq || isNaN(inputPrice)) {
            await sendTelegramMessage(`⚠️ [입력 오류] 양식이 올바르지 않습니다.\n지침 ➔ 구매:[매물번호] [매입금액]\n예시 ➔ 구매:698432 250000`);
            continue;
          }

          if (inputPrice < 10000) inputPrice *= 10000; 

          let pendingDB = loadPendingDB();
          let soldDB = loadSoldDB();
          let purchaseDB = loadPurchaseDB();

          const foundInfo = pendingDB.find(p => p.seq === targetSeq) || soldDB.find(p => p.seq === targetSeq);
          const finalTitle = foundInfo ? foundInfo.title : `${targetSeq}번 수동 주입 품목`;
          const finalCat = foundInfo ? foundInfo.catName : "수동 지정 분류";

          const purchaseItem = {
            seq: targetSeq,
            catName: finalCat,
            title: finalTitle,
            price_parsed: inputPrice,
            is_reported: false, 
            purchased_at: new Date().toISOString().split('T')[0]
          };

          purchaseDB = purchaseDB.filter(p => p.seq !== targetSeq);
          purchaseDB.push(purchaseItem);
          savePurchaseDB(purchaseDB);

          let existSoldIdx = soldDB.findIndex(s => s.seq === targetSeq);
          if (existSoldIdx !== -1) {
            soldDB[existSoldIdx].price_parsed = inputPrice;
            soldDB[existSoldIdx].price_status = "사장님 직접 매입 건 (실가격 보정)";
          } else {
            soldDB.push({
              seq: targetSeq,
              catName: finalCat,
              title: finalTitle,
              price_parsed: inputPrice,
              price_status: "사장님 직접 매입 건",
              url: foundInfo ? foundInfo.url : `https://bikesell.co.kr/site/board/content.asp?dolseq=${targetSeq}`,
              is_reported: false,
              captured_at: new Date().toISOString().split('T')[0]
            });
          }
          saveSoldDB(soldDB);

          await sendTelegramMessage(`📦 [매입 장부 기록 성공]\n• 품목: [${finalCat}] ${finalTitle}\n• 확정 매입가: ${inputPrice.toLocaleString()}원\n➔ 해당 실데이터는 카테고리 추세 분석 가동 시 최우선 지표로 강제 주입됩니다.`);
        } catch (e) {
          await sendTelegramMessage(`❌ [매입 처리 실패] 내부 처리 중 오류 발생: ${e.message}`);
        }
      }
      else if (text === '/스캔') {
        console.log('🚀 [원격 로그] 즉시 테스트 수색 실행.');
        await sendTelegramMessage(`🚀 실시간 수색 및 감정 스캔을 강제 구동합니다.`);
        await runBikesellScanner(); 
      }
      else if (text === '/추세') {
        console.log('📊 [원격 로그] 마스터 통합 추세 분석 강제 정산 가동.');
        await sendTelegramMessage(`📊 현재까지 누적된 장부를 기반으로 즉시 추세 분석을 강제 정산합니다.`);
        
        let soldDB = loadSoldDB();
        let purchaseDB = loadPurchaseDB();
        let combinedTrendInput = "";
        let reportedItemsPool = [];

        for (const cat of BIKESELL_CATEGORIES) {
          let unreportedItems = soldDB.filter(p => p.catName === cat.name && p.is_reported !== true);
          if (unreportedItems.length > 0) {
            let soldDBText = "";
            unreportedItems.forEach(p => {
              const isMyBuy = purchaseDB.some(m => m.seq === p.seq);
              soldDBText += `• ${p.title} ➔ 최종실거래가: ${p.price_parsed > 0 ? p.price_parsed.toLocaleString() + '원' : '금액유실'} ${isMyBuy ? '(★내매입)' : ''}\n`;
            });

            let matchPurchases = purchaseDB.filter(p => p.catName === cat.name);
            let purchaseDBText = "";
            matchPurchases.forEach(p => {
              purchaseDBText += `• 번호 ${p.seq} ➔ 매입가: ${p.price_parsed.toLocaleString()}원 (${p.title})\n`;
            });

            combinedTrendInput += `\n### 📋 [게시판 분류]: ${cat.name}\n`;
            combinedTrendInput += `[중고장터 완판 장부]:\n${soldDBText}\n`;
            combinedTrendInput += `[사장님 실매입 이력]:\n${purchaseDBText || "최근 매입 데이터 없음"}\n`;
            combinedTrendInput += `-------------------------------------------\n`;
            reportedItemsPool.push(...unreportedItems);
          }
        }

        if (combinedTrendInput.length > 0) {
          const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
          const masterTrendPrompt = generateMasterTrendPrompt(settings, combinedTrendInput);
          try {
            const response = await ai.models.generateContent({ 
              model: 'gemini-3.1-flash-lite', 
              contents: [{ role: 'user', parts: [{ text: masterTrendPrompt }] }], 
              config: { temperature: 0.1 } 
            });
            await sendTelegramMessage(response.text);
            reportedItemsPool.forEach(p => { p.is_reported = true; });
            saveSoldDB(soldDB);
          } catch (err) {
            await sendTelegramMessage(`🚨 [강제 추세 가동 에러] ${err.message}`);
          }
        } else {
          await sendTelegramMessage(`☕ 현재 새로 누적된 미보고 완판 데이터(is_reported: false)가 장부에 단 1개도 없습니다.`);
        }
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

function generateMasterTrendPrompt(userSettings, combinedTrendInput) {
  return `너는 국내 최고 권위의 중고 자전거 시장 데이터 분석가이다. 
제공된 각 게시판별 완판 장부 내역과 [★내매입] 이력을 정밀 대조하여 실제 거래가 지배하는 가격 추세 리포트를 뜬구름 잡는 소리(뇌피셜) 없이 드라이하게 종합 작성하라.

[🚨 분석가 핵심 준칙 - 요청자 지침 절대 반영]:
1. 감정적 표현('꿀매', '대박' 등)과 소설 쓰기는 절대 전면 금지한다.
2. 제공된 각 게시판 섹션의 데이터 안에서만 기술하고, 데이터가 없는 카테고리는 언급하지 마라.
3. [★내매입] 혹은 [사장님 실매입 이력]에 기재된 품목은 자가정비 관점에서 마진 방어가 완벽하게 증명된 '골든 시세 기준점'이므로 하단 분석 시 핵심 벤치마킹 지표로 삼아라.
4. **아래 기재된 분석 요청 사장님의 현 하드웨어 인프라 인프라와 특수 목적 가이드를 기반으로 실전 공임 마진 10만 원을 확보할 수 있는 진입 단가와 유효 규격 전략을 설계해라.**

[⚙️ 분석 요청 사장님 인프라 데이터 및 AI 지침 정보]:
- 현재 운용 장비 목록: ${userSettings.bikes}
- 🔥 수색 및 통계 가이드라인: ${userSettings.customPrompt}

출력 형식 (보내야 할 게시판별로 단락을 나누어 깔끔하게 작성해라):
### 📊 [B-HUNT] 실거래 완료 및 시세 추세 종합 브리핑

### ■ 게시판: [게시판 분류명]
1️⃣ **실거래 성사 품목 현황:**
(제품명 ➔ 실거래가 형태로 목록화, 내매입 건은 앞에 [⭐내매입] 명시)
2️⃣ **데이터 기반 실거래 성사 구간 (Sweet Spot):**
(실제 거래가 뭉쳐서 터지는 가격선 및 수렴가 분석)
3️⃣ **자가정비 인프라 기반 실전 마진 진입 전략:**
(사장님의 보유 인프라 및 가이드라인 지침을 연동하여 공임 및 마진 10만 원 확보를 위한 하드웨어 표준 규격/수요 피드백)

---
[통합 실거래가 데이터 장부셋트]:
${combinedTrendInput}`;
}

async function runBikesellScanner() {
  const runTime = new Date().toLocaleString();
  console.log(`\n==================================================`);
  console.log(`⏰ 무인 관제탑 가동 개시: ${runTime}`);
  console.log(`==================================================`);
  
  const todayObj = new Date();
  const yesterdayObj = new Date(todayObj.getTime() - 24 * 60 * 60 * 1000);
  
  const mmToday = String(todayObj.getMonth() + 1).padStart(2, '0');
  const ddToday = String(todayObj.getDate()).padStart(2, '0');
  const matchToday1 = `${mmToday}-${ddToday}`;
  const matchToday2 = `${mmToday}.${ddToday}`;

  const mmYesterday = String(yesterdayObj.getMonth() + 1).padStart(2, '0');
  const ddYesterday = String(yesterdayObj.getDate()).padStart(2, '0');
  const matchYesterday1 = `${mmYesterday}-${ddYesterday}`;
  const matchYesterday2 = `${mmYesterday}.${ddYesterday}`;

  const isTrackingFileExists = fs.existsSync(TRACKING_FILE);
  let trackingData = {};
  if (isTrackingFileExists) {
    try { trackingData = JSON.parse(fs.readFileSync(TRACKING_FILE, 'utf8')); } catch(e) { trackingData = {}; }
  }
  const updatedTrackingData = { ...trackingData };

  let sessionCookie = '';
  try {
    const loginOkUrl = 'https://bikesell.co.kr/site/im/login_ok.asp';
    const params = new URLSearchParams();
    params.append('formname', 'login');
    params.append('dolid', 'banst123');
    params.append('dolpass', 'bst511790');
    params.append('idcheck', 'ON');

    const loginRes = await axios.post(loginOkUrl, params.toString(), {
      ...AXIOS_CONFIG,
      maxRedirects: 0,
      validateStatus: (status) => status >= 200 && status < 400 
    });

    if (loginRes.headers['set-cookie']) {
      sessionCookie = loginRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
    }
  } catch (err) { 
    console.log(`🚨 [로그인 실패] ${err.message}`);
    return; 
  }

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
        for (const td of tdMatches) {
          const text = td.replace(/<[^>]*>/g, '').trim();
          if (/[\d]{1,2}(:|-|\.)[\d]{1,2}/.test(text)) {
            dateStr = text;
          }
        }
        
        if (seq > 0 && dateStr) {
          pageItems.push({ seq, dateStr });
        }
      }
    } catch (err) { continue; }

    if (pageItems.length === 0) continue;

    pageItems.sort((a, b) => b.seq - a.seq);
    const lastExaminedSeq = trackingData[trackingKey] || 0;

    if (!isTrackingFileExists || lastExaminedSeq === 0) {
      const targetItems = pageItems.slice(0, 100); 
      for (let i = 0; i < targetItems.length; i++) {
        const item = targetItems[i];
        const rawDate = item.dateStr;
        const isTodayTime = rawDate.includes(':');
        const isTodayDate = rawDate.includes(matchToday1) || rawDate.includes(matchToday2);
        const isYesterdayDate = rawDate.includes(matchYesterday1) || rawDate.includes(matchYesterday2);

        if (!isTodayTime && !isTodayDate && !isYesterdayDate) continue; 
        allFlattenPosts.push({ catName: cat.name, seq: item.seq, dateStr: rawDate });
      }
    } else {
      for (const item of pageItems) {
        if (item.seq <= lastExaminedSeq) continue; 
        allFlattenPosts.push({ catName: cat.name, seq: item.seq, dateStr: item.dateStr });
      }
    }

    if (pageItems.length > 0) {
      updatedTrackingData[trackingKey] = Math.max(pageItems[0].seq, lastExaminedSeq);
    }
  }

  let soldDB = loadSoldDB();
  let pendingDB = loadPendingDB();
  let purchaseDB = loadPurchaseDB();

  pendingDB.forEach(p => {
    if (!soldDB.some(s => s.seq === p.seq) && !allFlattenPosts.some(a => a.seq === p.seq)) {
      allFlattenPosts.push({ catName: p.catName, seq: p.seq, dateStr: "RE-TRACKING" });
    }
  });

  let finalLivePosts = []; 

  for (const item of allFlattenPosts) {
    const catObj = BIKESELL_CATEGORIES.find(c => c.name === item.catName);
    const targetUrl = `https://bikesell.co.kr/site/board/content.asp?Search=&SearchText=&Page=1&Gotopage=1&doltop=${catObj.top}&dolsection=${catObj.section}&dolseq=${item.seq}&dolcha=&POINT=`;
    
    try {
      const contentRes = await axios.get(targetUrl, requestConfig);
      const contentHtml = decodeEucKr(contentRes.data);
      
      if (contentHtml.includes('비 회원은 확인하실 수 없습니다')) continue;
      if (contentHtml.includes('삭제된 게시물')) continue;

      let pureContent = contentHtml.replace(/<[^>]*>/g, ' ');
      const topAnchor = "신품판매나 전문적인 판매행위는 신고하여 주시기 바랍니다.";
      const topIndex = pureContent.indexOf(topAnchor);
      if (topIndex !== -1) pureContent = pureContent.substring(topIndex + topAnchor.length).trim();

      const titleMatch = contentHtml.match(/<font[^>]*size=["']?3["']?[^>]*>\s*<b>(.*?)<\/b>/i);
      let pageTitle = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : `글 번호 ${item.seq}`;
      const cleanContent = pureContent.replace(/\s+/g, ' ').trim();
      
      let priceParsed = 0;
      const priceMatch = cleanContent.match(/금액\s*([\d,]+)\s*만원|가격\s*([\d,]+)\s*만원|([\d,]+)\s*만원/i);
      if (priceMatch) {
        const numStr = priceMatch[1] || priceMatch[2] || priceMatch[3];
        priceParsed = parseInt(numStr.replace(/,/g, ''), 10);
        if (priceParsed < 10000) priceParsed *= 10000; 
      } else {
        const wonMatch = cleanContent.match(/([\d,]+)\s*원/);
        if (wonMatch) priceParsed = parseInt(wonMatch[1].replace(/,/g, ''), 10);
      }

      if (contentHtml.includes('판매가 완료되었습니다')) {
        if (!soldDB.some(p => p.seq === item.seq)) {
          let logStatus = "정상 파싱 성공";

          const myInward = purchaseDB.find(p => p.seq === item.seq);
          if (myInward) {
            priceParsed = myInward.price_parsed;
            logStatus = "사장님 직매입 품목 실가격 연동";
          } else if (priceParsed === 0 || priceParsed === null) {
            const historyBackup = pendingDB.find(p => p.seq === item.seq);
            if (historyBackup && historyBackup.price_at_live > 0) {
              priceParsed = historyBackup.price_at_live;
              logStatus = "금액 복원(역추적 완료)";
            } else {
              logStatus = "금액 유실됨(수요 데이터)";
            }
          }

          const soldItem = {
            seq: item.seq,
            catName: item.catName,
            title: pageTitle.substring(0, 30),
            price_parsed: priceParsed,
            price_status: logStatus,
            url: targetUrl,
            is_reported: false, 
            captured_at: new Date().toISOString().split('T')[0]
          };

          soldDB.push(soldItem);
          console.log(`💾 [DB 적재] 완판 확정 ➔ 방:[${item.catName}] | 금액: ${priceParsed.toLocaleString()}원`);
        }
      } else {
        if (priceParsed > 0) {
          const existingIdx = pendingDB.findIndex(p => p.seq === item.seq);
          const liveData = { seq: item.seq, catName: item.catName, price_at_live: priceParsed, updated_at: Date.now() };
          
          if (existingIdx !== -1) pendingDB[existingIdx] = liveData;
          else pendingDB.push(liveData);
        }
        
        if (item.dateStr !== "RE-TRACKING") {
          finalLivePosts.push({ catName: item.catName, seq: item.seq, url: targetUrl, title: pageTitle, content: cleanContent });
        }
      }
    } catch (e) {}
  }

  const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
  pendingDB = pendingDB.filter(p => p.updated_at > threeDaysAgo && !soldDB.some(s => s.seq === p.seq));
  
  savePendingDB(pendingDB);
  saveSoldDB(soldDB);

  if (!GEMINI_API_KEY) {
    console.error('🚨 [오류] GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');
    fs.writeFileSync(TRACKING_FILE, JSON.stringify(updatedTrackingData, null, 2), 'utf8');
    return;
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const userSettings = loadUserSettings();

  if (finalLivePosts.length > 0) {
    const CHUNK_SIZE = 40;
    let chunks = [];
    for (let i = 0; i < finalLivePosts.length; i += CHUNK_SIZE) {
      chunks.push(finalLivePosts.slice(i, i + CHUNK_SIZE));
    }

    for (let idx = 0; idx < chunks.length; idx++) {
      const currentChunk = chunks[idx];
      let chunkInput = "";
      currentChunk.forEach(p => {
        chunkInput += `\n[카테고리]: ${p.catName} | [매물번호]: ${p.seq}\n[링크]: ${p.url}\n[제목]: ${p.title}\n[본문]: ${p.content}\n----------------\n`;
      });

      const livePrompt = generateLivePrompt(userSettings, chunkInput, idx + 1, chunks.length);
      try {
        const response = await ai.models.generateContent({ model: 'gemini-3.1-flash-lite', contents: [{ role: 'user', parts: [{ text: livePrompt }] }], config: { temperature: 0.2 } });
        if (response.text && !response.text.includes('이번 주기는 패스합니다')) {
          await sendTelegramMessage(response.text);
        }
      } catch (err) {}
    }
  }

  let combinedTrendInput = ""; 
  let reportedItemsPool = [];   

  for (const cat of BIKESELL_CATEGORIES) {
    let unreportedItems = soldDB.filter(p => p.catName === cat.name && p.is_reported !== true);

    if (unreportedItems.length >= 20) {
      console.log(`📦 [장부 가감 정산] "${cat.name}" 게시판 조건 만족 (${unreportedItems.length}/20). 통합 처리 풀 이동.`);
      
      let soldDBText = "";
      unreportedItems.forEach(p => {
        const isMyBuy = purchaseDB.some(m => m.seq === p.seq);
        soldDBText += `• ${p.title} ➔ 최종실거래가: ${p.price_parsed > 0 ? p.price_parsed.toLocaleString() + '원' : '금액유실'} ${isMyBuy ? '(★내매입)' : ''}\n`;
      });

      let matchPurchases = purchaseDB.filter(p => p.catName === cat.name);
      let purchaseDBText = "";
      matchPurchases.forEach(p => {
        purchaseDBText += `• 번호 ${p.seq} ➔ 매입가: ${p.price_parsed.toLocaleString()}원 (${p.title})\n`;
      });

      combinedTrendInput += `\n### 📋 [게시판 분류]: ${cat.name}\n`;
      combinedTrendInput += `[중고장터 완판 장부]:\n${soldDBText}\n`;
      combinedTrendInput += `[사장님 실매입 이력]:\n${purchaseDBText || "최근 매입 데이터 없음"}\n`;
      combinedTrendInput += `-------------------------------------------\n`;

      reportedItemsPool.push(...unreportedItems);
    }
  }

  if (combinedTrendInput.length > 0) {
    console.log(`🧠 [AI 마스터 추세 분석] 토큰 세이빙 파이프라인 가동 및 단일 호출 정산 진입...`);
    const masterTrendPrompt = generateMasterTrendPrompt(userSettings, combinedTrendInput);

    try {
      const response = await ai.models.generateContent({ 
        model: 'gemini-3.1-flash-lite', 
        contents: [{ role: 'user', parts: [{ text: masterTrendPrompt }] }], 
        config: { temperature: 0.1 } 
      });
      
      await sendTelegramMessage(response.text);
      
      reportedItemsPool.forEach(p => { p.is_reported = true; });
      saveSoldDB(soldDB);
      console.log(`🏁 [통합 추세 보고 완료] 토큰 세이빙 정산 처리 잠금 완료.`);
    } catch (err) {
      console.log(`🚨 [통합 추세 가동 에러] ${err.message}`);
    }
  }

  fs.writeFileSync(TRACKING_FILE, JSON.stringify(updatedTrackingData, null, 2), 'utf8');
}

// 🎯 외부 크론 신호 호출 전용 메인 단발성 실행 시퀀스
(async () => {
  console.log('📢 [Project B-Hunt v9.9-Pro-Max-Linked] 외부 크론 신호 수신 - 스캔 실행.');
  try {
    await checkTelegramCommands(); // 텔레그램 원격 명령 체크 및 반영
    await runBikesellScanner();    // 스캔 및 AI 분석 구동
    console.log('✨ [스캔 완료] 프로세스를 종료합니다.');
  } catch (err) {
    console.error(`🚨 [실행 예외 발생] ${err.message}`);
  }
})();
