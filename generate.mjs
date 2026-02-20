// generate.mjs
// GitHub Actions에서 실행: Claude API로 브리핑 생성 → index.html 주입

import { readFileSync, writeFileSync } from 'fs';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) throw new Error('ANTHROPIC_API_KEY 환경변수가 없습니다.');

// ─── Time helpers (KST / ET) ─────────────────────────────────
function partsInTZ(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const get = (t) => parts.find(p => p.type === t)?.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  };
}

function ymdDot({ year, month, day }) {
  return `${year}.${String(month).padStart(2,'0')}.${String(day).padStart(2,'0')}`;
}
function ymdCompact({ year, month, day }) {
  return `${year}${String(month).padStart(2,'0')}${String(day).padStart(2,'0')}`;
}
function koreanDate({ year, month, day }) {
  return `${year}년 ${month}월 ${day}일`;
}

// ─── 미국장 마감일(ET) 계산 ───────────────────────────────────
// 원칙: ET 기준으로
// - ET 시간이 16:00(정규장 마감) 이후면 "해당 ET 날짜"가 마감일
// - 16:00 이전이면 "직전 거래일"이 마감일
// - 토/일이면 직전 금요일로 롤백
function getUSCloseDateET(now = new Date()) {
  const etNow = partsInTZ(now, 'America/New_York');

  // close day candidate
  let y = etNow.year, m = etNow.month, d = etNow.day;

  const afterClose = (etNow.hour > 16) || (etNow.hour === 16 && etNow.minute >= 0);
  if (!afterClose) {
    // before 16:00 ET => previous day
    const tmp = new Date(Date.UTC(y, m - 1, d));
    tmp.setUTCDate(tmp.getUTCDate() - 1);
    const p = partsInTZ(tmp, 'America/New_York');
    y = p.year; m = p.month; d = p.day;
  }

  // weekend rollback (ET calendar)
  // Create a UTC date that corresponds to ET date (date-only anchor)
  let anchor = new Date(Date.UTC(y, m - 1, d));
  const dow = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(anchor);
  if (dow === 'Sat') anchor.setUTCDate(anchor.getUTCDate() - 1);
  if (dow === 'Sun') anchor.setUTCDate(anchor.getUTCDate() - 2);

  return partsInTZ(anchor, 'America/New_York'); // returns {y,m,d,...} with same date in ET
}

// ─── 실행 시각/기준일 산출 ───────────────────────────────────
const now = new Date();
const kstNow = partsInTZ(now, 'Asia/Seoul');
const usCloseET = getUSCloseDateET(now);

const dataDate = ymdDot(usCloseET);          // 미국장 마감일(ET) 예: 2026.02.19
const usDateFull = koreanDate(usCloseET);    // 예: 2026년 2월 19일
const runKst = `${ymdDot(kstNow)} ${String(kstNow.hour).padStart(2,'0')}:${String(kstNow.minute).padStart(2,'0')}`; // 예: 2026.02.20 06:10
const nextDayKR = ymdDot(kstNow);            // 한국 오늘(생성일) 예: 2026.02.20

console.log(`🗓  미국장 마감일(ET): ${dataDate}`);
console.log(`🗓  생성 시각(KST): ${runKst} KST`);

// ─── Claude API 호출 ──────────────────────────────────────────
async function callClaude(systemPrompt, userPrompt) {
  const { default: fetch } = await import('node-fetch');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
      // web_search tool 사용 중이면 beta 헤더 필요(계정/플랜에 따라 실패할 수 있음)
      'anthropic-beta': 'web-search-2025-03-05'
    },
    body: JSON.stringify({
      model: model: "claude-sonnet-4-6",
      max_tokens: 1200,
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
  return (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

async function callClaudeWithRetry(systemPrompt, userPrompt, { tries = 3, baseDelayMs = 1200 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await callClaude(systemPrompt, userPrompt);
    } catch (e) {
      lastErr = e;
      const wait = baseDelayMs * Math.pow(2, i);
      console.error(`⚠️ Claude 호출 실패 (try ${i + 1}/${tries}): ${e.message}`);
      if (i < tries - 1) await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
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
[전일 미국 증시_${ymdCompact(usCloseET)}]
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

// Step 1 (must succeed)
try {
  console.log('  [1/3] 브리핑 텍스트 + 섹터 데이터 생성 중...');
  const briefingRaw = await callClaudeWithRetry(
    briefingSystemPrompt,
    `${dataDate} (${usDateFull}) 미국 주식시장 마감 데이터를 웹 검색으로 수집해서 지정된 JSON 형식으로 브리핑을 작성해주세요. 주요 지수 종가, 섹터별 등락률, 빅테크 주가, 주요 채권/원자재 가격을 모두 실제 수치로 작성하세요.`,
    { tries: 3 }
  );

  const jsonMatch = briefingRaw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('JSON을 찾을 수 없습니다: ' + briefingRaw.slice(0, 200));
  briefingJSON = JSON.parse(jsonMatch[0]);
  console.log('  ✅ 브리핑 텍스트 생성 완료');
} catch (e) {
  console.error('  ❌ 브리핑 생성 실패:', e.message);
  process.exit(1);
}

// Step 2 (must succeed)
try {
  console.log('  [2/3] 뉴스 HTML 생성 중...');
  newsHtml = await callClaudeWithRetry(
    newsSystemPrompt,
    `${dataDate} 미국 시장의 주요 뉴스와 이슈를 웹 검색으로 찾아서 HTML로 작성해주세요. Fed, 지정학, 기업 실적, 시장 테마 등 다양한 카테고리를 포함하세요.`,
    { tries: 3 }
  );
  console.log('  ✅ 뉴스 HTML 생성 완료');
} catch (e) {
  console.error('  ❌ 뉴스 생성 실패:', e.message);
  process.exit(1);
}

// Step 3 (must succeed)
try {
  console.log('  [3/3] 한국장 전망 HTML 생성 중...');
  outlookHtml = await callClaudeWithRetry(
    outlookSystemPrompt,
    `${dataDate} 미국 시장 마감 결과를 바탕으로 ${nextDayKR} 한국 주식시장(코스피/코스닥) 전망을 HTML로 작성해주세요. 관련 한국 종목도 구체적으로 언급하세요.`,
    { tries: 3 }
  );
  console.log('  ✅ 한국장 전망 HTML 생성 완료');
} catch (e) {
  console.error('  ❌ 한국장 전망 생성 실패:', e.message);
  process.exit(1);
}

// ─── HTML 주입 ───────────────────────────────────────────────
console.log('📝 index.html 업데이트 중...');

let html = readFileSync('index.html', 'utf-8');

const sectorsJson = JSON.stringify(briefingJSON.sectors || []);
const briefingText = (briefingJSON.briefing_text || '').replace(/`/g, '\`');
const footerText = `${dataDate} 미국 동부 오후 4시 마감가 기준 / 한국 ${nextDayKR} 오전 6시<br>데이터: Claude AI · Investing.com · Finviz<br>참고용 자료 · 투자 판단의 최종 책임은 본인에게 있습니다`;

html = html
  .replace(/<!--BRIEFING_TEMPLATE-->/g, briefingText)
  .replace(/<!--SECTORS_JSON-->/g, sectorsJson)
  .replace(/<!--DATA_DATE-->/g, dataDate)
  .replace(/<!--RUN_KST-->/g, runKst)
  .replace(/<!--NEWS_DATE-->/g, dataDate)
  .replace(/<!--OUTLOOK_DATE-->/g, `${nextDayKR} 오전 9시 개장`)
  .replace(/<!--SECTOR_DATE-->/g, dataDate)
  .replace(/<!--NEWS_HTML-->/g, newsHtml.trim())
  .replace(/<!--OUTLOOK_HTML-->/g, outlookHtml.trim())
  .replace(/<!--FOOTER_TEXT-->/g, footerText);

writeFileSync('index.html', html, 'utf-8');
console.log('✅ index.html 업데이트 완료!');
console.log(`   미국장 마감 기준일(ET): ${dataDate}`);
console.log(`   생성 시각(KST): ${runKst} KST`);
