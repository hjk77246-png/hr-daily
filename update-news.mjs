#!/usr/bin/env node
// update-news.mjs — HR Daily News Updater v5
//
// 수집 아키텍처 (Layer 1→2→3→4)
//   Layer 1. 데이터 소스
//     - 매일노동뉴스 RSS (국내 노동 전문 1순위, 직접 RSS)
//     - Google 뉴스 RSS (고용노동부 / 대법원·중노위 / 법제처 /
//                        경총 / 한국노동연구원 / 이레이버 영역 포함)
//   Layer 2. 수집 엔진 → GitHub Actions Cron (매일 09:00 KST)
//   Layer 3. AI 처리  → Gemini 2.0 Flash (무료) — 분류·요약·중복제거
//   Layer 4. 저장소  → data.json (GitHub Pages 정적 배포)

import { writeFileSync } from 'fs';

const GEMINI_API_KEY   = process.env.GEMINI_API_KEY || '';
const MAX_PER_CATEGORY = 5;

// ══════════════════════════════════════════════════════════
//  소스 설계
//  ┌ 매일노동뉴스 RSS → 키워드 기반 카테고리 라우팅
//  └ 카테고리별 Google 뉴스 RSS (국내 한정)
//      law   : 법제처·국회 법령 동향
//      cases : 대법원·중노위·노동위원회 판례
//      gov   : 고용노동부·경총·한국노동연구원 정책·동향
//      hr    : HR 인사관리·이레이버 노무 실무
// ══════════════════════════════════════════════════════════

const LABORTODAY_RSS = 'http://www.labortoday.co.kr/rss/allArticle.xml';

const SOURCES = {
  law: {
    label: '노동법 개정·입법 동향',
    kw: [
      // 순수 입법 키워드만 (HR 뉴스와 겹치지 않게)
      '개정','입법','법안','제정','법률안','시행령','시행규칙',
      '최저임금법','근로기준법','산안법','고평법','파견법',
      '노동조합법','중대재해법','산업안전보건법','근로시간법',
      '국회','법제처','입법예고','국회상임위','법제사',
      '통과','발의','제안','의안번호','개정안',
    ],
    google: [
      { q: '노동법 개정 입법 법안 시행령 국회',    label: 'Google 뉴스(입법)' },
      { q: '법제처 법령 근로기준법 최저임금 개정',  label: 'Google 뉴스(법제처)' },
    ],
  },

  cases: {
    label: '대법원·노동위원회 판례',
    kw: [
      '판결','판례','대법원','고등법원','지방법원','행정법원',
      '노동위원회','중노위','판정','부당해고','부당노동행위',
      '근로자지위확인','소송','선고','구제신청','심판',
      '파기환송','확정','취소 판결','원고','피고',
    ],
    google: [
      { q: '대법원 노동 판결 부당해고 취소',         label: 'Google 뉴스(대법원)' },
      { q: '노동위원회 중노위 판정 구제신청 심판',   label: 'Google 뉴스(노동위)' },
    ],
  },

  gov: {
    label: '고용부·경총·연구원 동향',
    kw: [
      '고용노동부','노동부','행정해석','가이드라인','지침','고시',
      '공고','보도자료','근로감독','노동청','지원사업','지원금',
      '일자리','직업훈련','고용정책','장관','차관',
      '경총','경영계','사용자단체',
      '한국노동연구원','노동연구원','KLI',
    ],
    google: [
      { q: '고용노동부 보도자료 행정해석 지침 정책',  label: 'Google 뉴스(고용부)' },
      { q: '경총 경영계 노동정책 고용 임금 동향',     label: 'Google 뉴스(경총)' },
      { q: '한국노동연구원 정책 보고서 분석 동향',    label: 'Google 뉴스(KLI)' },
    ],
  },

  hr: {
    label: 'HR·인사관리·노무실무',
    kw: [
      '채용','인사','복리후생','유연근무','재택근무','워크라이프',
      '직무','역량','승진','연봉','조직문화','인재','리더십',
      'MZ세대','번아웃','몰입','성과관리','다양성',
      '취업규칙','복무규정','노무','이레이버',
      '온보딩','이직','직원','구성원',
    ],
    google: [
      { q: 'HR 인사관리 채용 조직문화 성과관리',        label: 'Google 뉴스(HR)' },
      { q: '노무 실무 취업규칙 복무규정 직원관리',       label: 'Google 뉴스(노무실무)' },
    ],
  },
};

// ══════════════════════════════════════════════════════════
//  유틸리티
// ══════════════════════════════════════════════════════════

function isRecent(isoDate) {
  if (!isoDate) return false;
  const diff = Date.now() - new Date(isoDate).getTime();
  // 60일 이내 기사 포함 (-12h ~ +1440h = 60days)
  // LaborToday만 사용하므로 충분한 범위 필요
  return diff >= -(12 * 3600000) && diff <= 1440 * 3600000;
}

// 한글 포함 여부 (외국어 기사 필터)
function isKorean(text) { return /[가-힣]/.test(text); }

// 매일노동뉴스 기사 → 카테고리 라우팅 (우선순위: cases > gov > law > hr)
function categorize(title) {
  for (const [cat, { kw }] of Object.entries(SOURCES)) {
    if (kw.some(k => title.includes(k))) return cat;
  }
  return null;
}

// 전체 버킷 통합 중복 제거 (제목 앞 40자 기준)
function globalDedup(buckets) {
  const seen = new Set();
  for (const cat of Object.keys(buckets)) {
    buckets[cat] = buckets[cat].filter(item => {
      const key = item.title.slice(0, 40).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

// ══════════════════════════════════════════════════════════
//  RSS 파싱
// ══════════════════════════════════════════════════════════

function parseRSS(xml, label) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = block.match(
        new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i')
      );
      return r ? r[1].trim() : '';
    };
    const clean = s => s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ').trim();

    const rawTitle = clean(get('title'));
    if (!rawTitle || rawTitle.length < 4) continue;
    if (!isKorean(rawTitle)) continue;   // 외국어 제외

    const parts  = rawTitle.split(' - ');
    const title  = parts.length > 1 ? parts.slice(0, -1).join(' - ') : rawTitle;
    const link   = clean(get('link') || get('guid'));
    const desc   = clean(get('description')).slice(0, 350);
    const pubStr = get('pubDate');

    let date = '', isoDate = '';
    if (pubStr) {
      try {
        const d = new Date(pubStr);
        isoDate = d.toISOString();
        date = d.toLocaleDateString('ko-KR', {
          timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric',
        });
      } catch (_) {}
    }
    items.push({ title, url: link, desc, date, isoDate, sourceLabel: label });
  }
  return items;
}

// ══════════════════════════════════════════════════════════
//  RSS 수집
// ══════════════════════════════════════════════════════════

async function fetchFeed(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HRDailyBot/5.0)',
        'Accept': 'application/rss+xml, application/xml, */*',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`  ⚠ HTTP ${res.status} [${label}]`); return []; }
    return parseRSS(await res.text(), label);
  } catch (e) {
    clearTimeout(timer);
    console.warn(`  ⚠ [${label}] ${e.message}`);
    return [];
  }
}

function gnewsUrl(q) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;
}

// ══════════════════════════════════════════════════════════
//  Gemini AI 요약 (무료, gemini-2.0-flash)
// ══════════════════════════════════════════════════════════

async function summarize(article, catId) {
  if (!GEMINI_API_KEY) {
    // API 키 없음 → 기본값 생성
    return {
      main: article.desc || '',
      implication: 'HR·노무 트렌드 관점에서 주시 필요',
    };
  }

  const prompt =
`당신은 HR·노무 전문가입니다. 아래 기사를 분석하여 순수 JSON만 출력하세요. 설명 없이 JSON만.

카테고리: ${SOURCES[catId].label}
제목: ${article.title}
내용: ${article.desc || '(없음)'}

【형식 규칙 — 반드시 준수】
- main       : 기사의 핵심 사실·경과·판결 내용을 1~2문장으로 정확하게 설명
- implication: 【HR·노무 실무자 관점】 법적·정책적 위험 + 채용·보상·운영 정책 조정 필요성을 1~2문장으로 구체적으로 기술

{"main":"핵심 사실 1~2문장","implication":"HR 실무 위험·대응 방향 1~2문장"}`;

  // ──────── Gemini 재시도 2회 ────────
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 600, temperature: 0.3 },
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      let jsonStr = '';
      const cb = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (cb) jsonStr = cb[1].trim();
      else { const rw = text.match(/\{[\s\S]*\}/); if (rw) jsonStr = rw[0]; }
      if (!jsonStr) throw new Error('JSON 추출 실패');

      const j = JSON.parse(jsonStr);
      return {
        main:        (j.main        || article.desc || '').trim(),
        implication: (j.implication || '').trim(),
      };
    } catch (e) {
      clearTimeout(timer);
      console.warn(`  ⚠ 시도 ${attempt + 1}/2 실패: ${e.message}`);
      if (attempt < 1) await new Promise(r => setTimeout(r, 500));
    }
  }

  // ──────── 재시도 2회 실패 → 기본값 생성 ────────
  console.warn('  ⚠ Gemini 완전 실패, 기본 요약으로 대체');
  return {
    main: article.desc || '',
    implication: 'HR·노무 트렌드 관점에서 주시 필요',
  };
}

// ══════════════════════════════════════════════════════════
//  메인
// ══════════════════════════════════════════════════════════

async function main() {
  const nowKST = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'long',
    day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit',
  });
  console.log(`\n🚀 HR 데일리 수집 시작 (${nowKST})`);
  console.log(`📡 소스: 매일노동뉴스 RSS만 사용 (최근 60일)`);
  console.log(`🤖 Gemini AI: ${GEMINI_API_KEY ? '활성화' : '비활성화 (GEMINI_API_KEY 미설정)'}\n`);

  const buckets = { law: [], cases: [], hr: [], gov: [] };

  // ── Step 1: 매일노동뉴스 RSS → 키워드 카테고리 분류
  console.log('📰 [매일노동뉴스] 수집 중...');
  const ltItems = await fetchFeed(LABORTODAY_RSS, '매일노동뉴스');
  let ltCount = 0;
  for (const item of ltItems) {
    if (!isRecent(item.isoDate)) continue;
    const cat = categorize(item.title);
    if (cat) { buckets[cat].push(item); ltCount++; }
  }
  console.log(`   → ${ltCount}건 분류\n`);

  // ── Step 2: 전체 중복 제거 → 카테고리별 최신순 상위 5건 (Google News 제외)
  globalDedup(buckets);
  const selected = {};
  for (const [cat, items] of Object.entries(buckets)) {
    // 최신순 정렬 후 상위 5건 선택
    const sorted = items.sort((a, b) => new Date(b.isoDate || 0) - new Date(a.isoDate || 0));
    selected[cat] = sorted.slice(0, MAX_PER_CATEGORY);
    console.log(`\n✅ [${SOURCES[cat].label}] ${selected[cat].length}건 선택`);
  }

  // ── Step 3: Gemini AI 요약 (주요내용·시사점)
  if (GEMINI_API_KEY) {
    console.log('\n🤖 Gemini AI 요약 생성 중...');
    for (const [cat, items] of Object.entries(selected)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        process.stdout.write(
          `   [${SOURCES[cat].label}] ${i + 1}/${items.length} "${item.title.slice(0, 28)}..." `
        );
        items[i] = { ...item, ...await summarize(item, cat) };
        console.log('✅');
        await new Promise(r => setTimeout(r, 500)); // rate limit
      }
    }
  }

  // ── Step 4: data.json 저장
  const data = {
    updated: new Date().toISOString(),   // ISO 형식으로 저장 (브라우저 파싱 가능)
    updatedKST: nowKST,                  // 사람이 읽는 용도
    aiSummary: !!GEMINI_API_KEY,
    sources: '매일노동뉴스 RSS (LaborToday)',
    ...selected,
  };
  writeFileSync('data.json', JSON.stringify(data, null, 2), 'utf-8');
  console.log(`\n🎉 data.json 저장 완료 (${nowKST})\n`);
}

main().catch(e => { console.error('❌ 오류:', e); process.exit(1); });
