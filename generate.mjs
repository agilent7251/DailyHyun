// generate.mjs
// GitHub Actions에서 실행: Claude API로 브리핑 생성 → index.html 주입

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) throw new Error('ANTHROPIC_API_KEY 환경변수가 없습니다.');

// ─── 날짜 계산 ───────────────────────────────────────────────
// KST 06:10에 실행 → 전날 미국 장 마감(전날 동부 오후 4시) 기준
const now = new Date();
// KST = UTC+9, 이 스크립트는 UTC 21:10에 실행됨 → KST 익일 06:10
// "전날 미국 마감" = UTC 기준 오늘(= KST 기준 어제) 20:00(동부 4PM)
const usCloseDate = new Date(now);
usCloseDate.setUTCHours(20, 0, 0, 0); // 당일 UTC 20:00 (동부 오후 4시)

// 날짜 포맷 함수
function fmtKR(d) {
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth()+1).padStart(2,'0')}.${String(d.getUTCDate()).padStart(2,'0')}`;
}
function fmtKorean(d) {
  return `${d.getUTCFullYear()}년 ${d.getUTCMonth()+1}월 ${d.getUTCDate()}일`;
}

const dataDate   = fmtKR(usCloseDate);          // 예: 2026.02.18
const kstNextDay = new Date(now);               // KST 오늘 = 미국 전날+1
const nextDayKR  = fmtKR(kstNextDay);          // 예: 2026.02.19 (한국 오늘)
const usDateFull = fmtKorean(usCloseDate);     // 예: 2026년 2월 18일

console.log(`🗓  미국 마감 날짜: ${dataDate}`);
console.log(`🗓  한국 오늘 날짜: ${nextDayKR}`);

// ─── Claude API 호출 ──────────────────────────────────────────
async function callClaude(systemPrompt, userPrompt) {
  const { default: fetch } = await import('node-fetch');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05'
    },
    body: JSON.stringify({
      model: 'claude-opus-4-6',
      max_tokens: 8192,
      tools: [{
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 8
      }],
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API 오류 ${res.status}: ${err}`);
  }

  const data = await res.json();
  // content 배열에서 text만 합치기
  return data.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

// ─── 1단계: 브리핑 텍스트 + 섹터 데이터 생성 ─────────────────
const briefingSystemPrompt = `
당신은 매일 아침 미국 주식시장 마감 브리핑을 작성하는 전문 애널리스트입니다.
웹 검색을 통해 ${dataDate} (${usDateFull}) 미국 시장 마감 데이터를 수집하고,
아래 형식에 맞게 정확한 수치로 브리핑을 작성하세요.

출력은 반드시 JSON 형식으로만 해주세요. 마크다운 코드블록(json) 없이 순수 JSON만 출력하세요.

JSON 구조:
{
  "briefing_text": "...",
  "sectors": [
    {"name": "Energy", "val": 1.72},
    ...
  ]
}

briefing_text 형식 (이 형식 그대로 유지):
[전일 미국 증시_${dataDate.replace(/\./g, '')}]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ 주요 지수
다우존스         XX,XXX.XX    (X.XX%↑↓)
S&P 500           X,XXX.XX    (X.XX%↑↓)
나스닥           XX,XXX.XX    (X.XX%↑↓)
달러인덱스           XX.XX    (X.XX%↑↓)
DAX              XX,XXX.XX    (X.XX%↑↓)
영국 FTSE         XX,XXX.XX   (X.XX%↑↓)
유로스톡스50       X,XXX.XX    (X.XX%↑↓)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ 섹터
섹터별 상승 Top 3
  1. [섹터명]               +X.XX%↑
  2. [섹터명]               +X.XX%↑
  3. [섹터명]               +X.XX%↑

섹터별 하락 Top 3
  1. [섹터명]               -X.XX%↓
  2. [섹터명]               -X.XX%↓
  3. [섹터명]               -X.XX%↓

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ 주요 자산 및 참고 지수
미국채 10년물         X.XXX%    (±X.Xbp↑↓)
WTI 원유              $XX.XX    (±X.XX%↑↓)
비트코인             $XX,XXX    (±X.XX%↑↓)
CBOE VIX              XX.XX    (±X.XX%↑↓)
금 (Gold)          $X,XXX.XX   (±X.XX%↑↓)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ 빅테크 & 특징주
NVDA  엔비디아            ±X.XX%↑↓    ($XXX.XX)
TSLA  테슬라              ±X.XX%↑↓    ($XXX.XX)
AAPL  애플                ±X.XX%↑↓    ($XXX.XX)
MSFT  마이크로소프트      ±X.XX%↑↓    ($XXX.XX)
META  메타                ±X.XX%↑↓    ($XXX.XX)
AMZN  아마존              ±X.XX%↑↓    ($XXX.XX)
AVGO  브로드컴            ±X.XX%↑↓    ($XXX.XX)
[당일 특징주 1~2개 추가, 급등락 이유 한 줄]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ 주요 시장 이벤트 (${dataDate} 발표)
[당일 발생한 주요 이벤트 2~4개, ★★★/★★☆/★☆☆ 중요도 표시]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

■ 향후 주요 이벤트
[향후 2~5일 내 주요 경제지표 발표, 실적 발표 일정]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
※ 마감가 기준 (미국 동부 오후 4시 / 한국 오전 6시)
※ 참고용 자료이며 투자 판단은 본인 책임입니다

sectors 배열에는 S&P 500 전체 11개 섹터의 당일 등락률을 실제 수치로 넣어주세요.
(Energy, Basic Materials, Technology, Consumer Cyclical, Financial, Communication Services, Healthcare, Industrials, Consumer Defensive, Real Estate, Utilities)
`;

// ─── 2단계: 뉴스 HTML 생성 ───────────────────────────────────
const newsSystemPrompt = `
당신은 미국 주식시장 뉴스를 정리하는 전문가입니다.
${dataDate} 미국 시장에서 있었던 주요 뉴스/이슈를 웹 검색으로 수집하여
HTML 형식으로 반환하세요.

출력은 순수 HTML만 출력하세요. 설명이나 마크다운 없이 HTML 태그만.

각 뉴스 아이템은 아래 구조를 사용하세요:
<div class="news-item">
  <div class="news-tag tag-[fed|geo|macro|corp|market]">[Fed|지정학|매크로|기업|시장]</div>
  <div class="news-body">
    <div class="news-headline">헤드라인 제목</div>
    <div class="news-desc">
      상세 설명 (3~5문장, 수치 포함)
    </div>
    <div class="news-source">출처: 출처1 · 출처2</div>
  </div>
</div>

5~7개 뉴스 아이템을 작성하세요.
tag 클래스는 다음 중 선택:
- tag-fed: Fed/통화정책 관련
- tag-geo: 지정학/정치 리스크
- tag-macro: 경제지표/매크로
- tag-corp: 기업/실적/M&A
- tag-market: 시장 흐름/테마
`;

// ─── 3단계: 한국장 전망 HTML 생성 ────────────────────────────
const outlookSystemPrompt = `
당신은 미국 시황을 바탕으로 한국 주식시장 전망을 분석하는 전문가입니다.
${dataDate} 미국 시장 마감 결과를 바탕으로 ${nextDayKR} 한국 시장 전망을 HTML로 작성하세요.

출력은 순수 HTML만 출력하세요. 설명이나 마크다운 없이 HTML 태그만.

아래 구조를 사용하세요:

<div class="outlook-summary">
  <div class="outlook-verdict">
    <div class="verdict-label">방향성</div>
    <div class="verdict-value verdict-[up|flat|down]">[↗|→|↘]</div>
    <div style="font-size:10px;color:var(--[up|gold|down]);font-family:var(--mono);margin-top:2px">[강세|소폭 강세|중립|소폭 약세|약세]</div>
  </div>
  <div class="outlook-summary-text">
    종합 전망 2~3문장
  </div>
</div>

[outlook-item 3~5개]:
<div class="outlook-item">
  <div class="outlook-dot dot-[up|down|flat]"></div>
  <div>
    <div class="outlook-text">
      <strong>항목 제목</strong><br>
      설명 2~3문장
    </div>
    <div class="outlook-sub">관련 종목 또는 지표 메모</div>
  </div>
</div>

<div class="outlook-disclaimer">
  ※ 본 전망은 ${dataDate} 미국 시황 및 공개된 뉴스 기반의 참고 의견입니다. 실제 시장은 돌발 변수에 따라 크게 달라질 수 있으며, 투자 결정의 근거로 사용하지 마십시오.
</div>
`;

// ─── 실행 ────────────────────────────────────────────────────
console.log('🤖 Claude API 호출 시작...');

let briefingJSON, newsHtml, outlookHtml;

try {
  console.log('  [1/3] 브리핑 텍스트 + 섹터 데이터 생성 중...');
  const briefingRaw = await callClaude(
    briefingSystemPrompt,
    `${dataDate} (${usDateFull}) 미국 주식시장 마감 데이터를 웹 검색으로 수집해서 지정된 JSON 형식으로 브리핑을 작성해주세요. 주요 지수 종가, 섹터별 등락률, 빅테크 주가, 주요 채권/원자재 가격을 모두 실제 수치로 작성하세요.`
  );

  // JSON 파싱 시도
  const jsonMatch = briefingRaw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('JSON을 찾을 수 없습니다: ' + briefingRaw.slice(0, 200));
  briefingJSON = JSON.parse(jsonMatch[0]);
  console.log('  ✅ 브리핑 텍스트 생성 완료');

} catch (e) {
  console.error('  ❌ 브리핑 생성 실패:', e.message);
  // 폴백: 기존 index.html의 내용 유지
  process.exit(0);
}

try {
  console.log('  [2/3] 뉴스 HTML 생성 중...');
  newsHtml = await callClaude(
    newsSystemPrompt,
    `${dataDate} 미국 시장의 주요 뉴스와 이슈를 웹 검색으로 찾아서 HTML로 작성해주세요. Fed, 지정학, 기업 실적, 시장 테마 등 다양한 카테고리를 포함하세요.`
  );
  console.log('  ✅ 뉴스 HTML 생성 완료');
} catch (e) {
  console.error('  ❌ 뉴스 생성 실패:', e.message);
  newsHtml = '<div class="news-item"><div class="news-body"><div class="news-headline">뉴스 생성 실패</div><div class="news-desc">잠시 후 다시 시도해주세요.</div></div></div>';
}

try {
  console.log('  [3/3] 한국장 전망 HTML 생성 중...');
  outlookHtml = await callClaude(
    outlookSystemPrompt,
    `${dataDate} 미국 시장 마감 결과를 바탕으로 ${nextDayKR} 한국 주식시장(코스피/코스닥) 전망을 HTML로 작성해주세요. 관련 한국 종목도 구체적으로 언급하세요.`
  );
  console.log('  ✅ 한국장 전망 HTML 생성 완료');
} catch (e) {
  console.error('  ❌ 한국장 전망 생성 실패:', e.message);
  outlookHtml = '<div class="outlook-disclaimer">전망 생성에 실패했습니다. 잠시 후 다시 시도해주세요.</div>';
}

// ─── HTML 주입 ───────────────────────────────────────────────
console.log('📝 index.html 업데이트 중...');

let html = readFileSync('index.html', 'utf-8');

const sectorsJson = JSON.stringify(briefingJSON.sectors || []);
const briefingText = (briefingJSON.briefing_text || '').replace(/`/g, '\\`');
const footerText = `${dataDate} 미국 동부 오후 4시 마감가 기준 / 한국 ${nextDayKR} 오전 6시<br>데이터: Claude AI · Investing.com · Finviz<br>참고용 자료 · 투자 판단의 최종 책임은 본인에게 있습니다`;

html = html
  .replace(/<!--BRIEFING_TEMPLATE-->/g, briefingText)
  .replace(/<!--SECTORS_JSON-->/g, sectorsJson)
  .replace(/<!--DATA_DATE-->/g, dataDate)
  .replace(/<!--NEWS_DATE-->/g, dataDate)
  .replace(/<!--OUTLOOK_DATE-->/g, `${nextDayKR} 오전 9시 개장`)
  .replace(/<!--SECTOR_DATE-->/g, dataDate)
  .replace(/<!--NEWS_HTML-->/g, newsHtml.trim())
  .replace(/<!--OUTLOOK_HTML-->/g, outlookHtml.trim())
  .replace(/<!--FOOTER_TEXT-->/g, footerText);

writeFileSync('index.html', html, 'utf-8');
console.log('✅ index.html 업데이트 완료!');
console.log(`   데이터 기준일: ${dataDate}`);
