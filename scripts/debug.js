import * as dotenv from 'dotenv';
dotenv.config();

import https from 'https';
import iconv from 'iconv-lite';
import * as cheerio from 'cheerio';

const keepAliveAgent = new https.Agent({ keepAlive: true });

function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      agent: keepAliveAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
        'Connection': 'keep-alive'
      },
    }, (res) => {
      console.log(`[디버그] HTTP 응답 상태 코드: ${res.statusCode}`);
      console.log(`[디버그] 응답 헤더 Content-Type: ${res.headers['content-type']}`);
      
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(iconv.decode(Buffer.concat(chunks), 'euc-kr')));
    }).on('error', reject);
  });
}

(async () => {
  console.log('🔍 바이크셀 서버 데이터 정밀 진단 시작...');
  try {
    const targetUrl = 'https://bikesell.co.kr/site/board/list.asp?doltop=MARKET&dolsection=MARKET1';
    const html = await httpGet(targetUrl);
    
    console.log('\n==================================================');
    console.log(`[디버그] 서버에서 받아온 HTML 총 길이: ${html.length}자`);
    console.log('==================================================\n');

    if (html.length < 1000) {
      console.log('⚠️ 서버가 정상적인 페이지를 주지 않았습니다. 본문 전체 출력:');
      console.log(html);
      return;
    }

    // 앞부분과 뒷부분 샘플 출력
    console.log('--- [HTML 상단 500자 샘플] ---');
    console.log(html.substring(0, 500));
    
    console.log('\n--- [DOM 구조 분석] ---');
    const $ = cheerio.load(html);
    
    const trCount = $('tr').length;
    const aCount = $('a').length;
    const contentLinkCount = $('a[href*="content.asp"], a[href*="Content.asp"]').length;
    
    console.log(`· 화면 내 전체 <tr> 태그 개수: ${trCount}개`);
    console.log(`· 화면 내 전체 <a> 링크 개수: ${aCount}개`);
    console.log(`· content.asp가 포함된 링크 개수: ${contentLinkCount}개`);

    // 만약 링크가 있다면 샘플 주소 몇 개 출력
    if (aCount > 0) {
      console.log('\n--- [발견된 링크 주소 상위 5개 추출] ---');
      $('a').slice(0, 5).each((i, el) => {
        console.log(`  ${i + 1}. text: "${$(el).text().trim()}" | href: "${$(el).attr('href')}"`);
      });
    }

  } catch (err) {
    console.error('❌ 네트워크 요청 실패:', err.message);
  }
})();
