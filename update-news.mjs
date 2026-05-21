#!/usr/bin/env node
// update-news.mjs — HR Daily News Updater v2
// 검증된 전문 사이트에서 HR/노무 뉴스를 수집해 data.json을 갱신합니다.

import { writeFileSync } from 'fs';

// ══════════════════════════════════════════════════════════
//  데이터 소스 정의
//  · 매일노동뉴스: 한국 유일 노동 전문지 (키워드로 카테고리 분류)
//  · HR Dive / HR Morning: 글로벌 HR 전문 미디어
//  · Google News RSS: 카테고리별 보조 소스
// ══════════════════════════════════════════════════════════

/** 매일노동뉴스 RSS (전체 기사 → 키워드로 카테고리 배분) */
const LABORTODAY_RSS = 'http://www.labortoday.co.kr/rss/allArticle.xml';

/** 카테고리 키워드 (앞 항목일수록 우선순위 높음) */
const CAT_KEYWORDS = [
  {
    cat: 'cases',
    kw: ['판결','판례','대법원','고등법원','지방법원','행정법원','노동위원회',
         '판정','부당해고','부당노동행위','근로자지위확인','심판','소송','선고',
         '원고','피고','상고','파기환송','확정','무죄','유죄'],
  },
  {
    cat: 'gov',
    kw: ['고용노동부','노동부','행정해석','가이드라인','지침','고시','공고','보도자료',
         '근로감독','지방노동청','행정예고','행정조치','장관','차관','정책 발표',
         '지원사업','지원금','지원대책','고용정책','직업훈련','국민취업','일자리'],
  },
  {
    cat: 'law',
    kw: ['개정','입법','법안','제정','법률안','시행령','시행규칙','최저임금법',
         '근로기준법','산안법','고평법','파견법','조례','국회','위원회',
         '비정규직','보호법','노동조합법','고용보험법','산재보험','근로계약',
         '최저임금','주52시간','연장근로','탄력근로','선택근로'],
  },
  {
    cat: 'hr',
    kw: ['채용','인사','복리후생','유연근무','재택근무','워크라이프','직무',
         '역량','승진','연봉','조직문화','인재','리더십','구성원','직원',
         '온보딩','오프보딩','퇴직','이직','MZ세대','번아웃','몰입'],
  },
];

/** 카테고리별 전용 추가 소스 */
const EXTRA_FEEDS = {
  law: [
    { url: 'https://news.google.com/rss/search?q=%EB%85%B8%EB%8F%99%EB%B2%95+%EA%B0%9C%EC%A0%95+%EC%9E%85%EB%B2%95+%EB%B2%95%EC%95%88&hl=ko&gl=KR&ceid=KR:ko', region: '국내', label: 'Google 뉴스' },
    { url: 'https://news.google.com/rss/search?q=labor+law+reform+employment+legislation+2026&hl=en&gl=US&ceid=US:en', region: '글로벌', label: 'Google News' },
  ],
  cases: [
    { url: 'https://news.google.com/rss/search?q=%EB%8C%80%EB%B2%95%EC%9B%90+%EB%85%B8%EB%8F%99+%ED%8C%90%EA%B2%B0+%EB%B6%80%EB%8B%B9%ED%95%B4%EA%B3%A0&hl=ko&gl=KR&ceid=KR:ko', region: '국내', label: 'Google 뉴스' },
    { url: 'https://news.google.com/rss/search?q=employment+court+ruling+labor+wrongful+termination&hl=en&gl=US&ceid=US:en', region: '글로벌', label: 'Google News' },
  ],
  hr: [
    { url: 'https://www.hrdive.com/feeds/news/',   region: '글로벌', label: 'HR Dive' },
    { url: 'https://www.hrmorning.com/feed/',       region: '글로벌', label: 'HR Morning' },
    { url: 'https://news.google.com/rss/search?q=HR+%EC%9D%B8%EC%82%AC%EA%B4%80%EB%A6%AC+%EC%A1%B0%EC%A7%81%EB%AC%B8%ED%99%94+%EC%B1%84%EC%9A%A9&hl=ko&gl=KR&ceid=KR:ko', region: '국내', label: 'Google 뉴스' },
  ],
  gov: [
    { url: 'https://news.google.com/rss/search?q=%EA%B3%A0%EC%9A%A9%EB%85%B8%EB%8F%99%EB%B6%80+%ED%96%89%EC%A0%95%ED%95%B4%EC%84%9D+%EC%A7%80%EC%B9%A8+%EA%B0%80%EC%9D%B4%EB%93%9C%EB%9D%BC%EC%9D%B8&hl=ko&gl=KR&ceid=KR:ko', region: '국내', label: 'Google 뉴스' },
    { url: 'https://news.google.com/rss/search?q=%EA%B3%A0%EC%9A%A9%EB%85%B8%EB%8F%99%EB%B6%80+%EB%B3%B4%EB%8F%84%EC%9E%90%EB%A3%8C+%EC%8B%9C%ED%96%89&hl=ko&gl=KR&ceid=KR:ko', region: '국내', label: 'Google 뉴스' },
  ],
};

// ══════════════════════════════════════════════════════════
//  유틸리티
// ══════════════════════════════════════════════════════════

/** 36시간 이내 기사인지 확인 */
function isRecent(isoDate) {
  if (!isoDate) return false;
  const diff = Date.now() - new Date(isoDate).getTime();
  return diff >= 0 && diff <= 36 * 60 * 60 * 1000;
}

/** 매일노동뉴스 기사를 키워드로 카테고리 분류 */
function categorizeByKeyword(title) {
  for (const { cat, kw } of CAT_KEYWORDS) {
    if (kw.some(k => title.includes(k))) return cat;
  }
  return null; // 해당 없으면 제외
}

// ══════════════════════════════════════════════════════════
//  RSS 파싱 (외부 패키지 불필요)
// ══════════════════════════════════════════════════════════
function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = block.match(new RegExp(
        `<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'
      ));
      return r ? r[1].trim() : '';
    };
    const clean = s => s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/&quot;/g,'"').replace(/&#39;/g,"'")
      .replace(/\s+/g,' ').trim();

    const rawTitle = clean(get('title'));
    if (!rawTitle || rawTitle.length < 4) continue;

    // "기사 제목 - 언론사" 분리
    const parts  = rawTitle.split(' - ');
    const title  = parts.length > 1 ? parts.slice(0, -1).join(' - ') : rawTitle;
    const source = parts.length > 1 ? parts[parts.length - 1] : '';

    const link = clean(get('link') || get('guid'));
    const desc = clean(get('description')).slice(0, 200);
    const pubStr = get('pubDate');
    let date = '', isoDate = '';
    if (pubStr) {
      try {
        const d = new Date(pubStr);
        isoDate = d.toISOString();
        date = d.toLocaleDateString('ko-KR', {
          timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric'
        });
      } catch(_) {}
    }
    items.push({ title, url: link, desc, date, isoDate, source });
  }
  return items;
}

// ══════════════════════════════════════════════════════════
//  RSS 수집
// ══════════════════════════════════════════════════════════
async function fetchFeed(url, region, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HRDailyBot/2.0; +https://hjk77246-png.github.io/hr-daily)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`  ⚠ HTTP ${res.status} [${label}]`); return []; }
    const text = await res.text();
    return parseRSS(text).map(item => ({ ...item, region, sourceLabel: label || region }));
  } catch(e) {
    clearTimeout(timer);
    console.warn(`  ⚠ 오류 [${label}]: ${e.message}`);
    return [];
  }
}

/** 중복 제거 (제목 앞 40자 기준) */
function dedup(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.title.slice(0, 40).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ══════════════════════════════════════════════════════════
//  메인
// ══════════════════════════════════════════════════════════
async function main() {
  const nowKST = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'long', hour: '2-digit', minute: '2-digit',
  });
  console.log(`\n🚀 HR 데일리 뉴스 수집 시작 (${nowKST})\n`);

  const buckets = { law: [], cases: [], hr: [], gov: [] };

  // ── 1) 매일노동뉴스 수집 → 키워드 분류 ──────────────
  console.log('📰 [매일노동뉴스] 수집 중...');
  const laborItems = await fetchFeed(LABORTODAY_RSS, '국내', '매일노동뉴스');
  let ltTotal = 0;
  for (const item of laborItems) {
    if (!isRecent(item.isoDate)) continue;
    const cat = categorizeByKeyword(item.title);
    if (cat) { buckets[cat].push(item); ltTotal++; }
  }
  console.log(`   → 오늘 기사 ${ltTotal}건 분류 완료`);

  await new Promise(r => setTimeout(r, 800));

  // ── 2) 카테고리별 추가 소스 수집 ─────────────────────
  const labels = { law: '노동법 개정/입법', cases: '판례', hr: 'HR 트렌드', gov: '고용부 해석' };
  for (const [cat, feeds] of Object.entries(EXTRA_FEEDS)) {
    console.log(`📂 [${labels[cat]}] 추가 소스 수집 중...`);
    for (const { url, region, label } of feeds) {
      const items = await fetchFeed(url, region, label);
      const recent = items.filter(i => isRecent(i.isoDate));
      buckets[cat].push(...recent);
      console.log(`   [${label}] → ${recent.length}건`);
      await new Promise(r => setTimeout(r, 600));
    }
  }

  // ── 3) 카테고리별 중복 제거 & 최대 6건 ───────────────
  const result = {};
  for (const [cat, items] of Object.entries(buckets)) {
    result[cat] = dedup(items).slice(0, 6);
    console.log(`✅ [${labels[cat]}] 최종 ${result[cat].length}건`);
  }

  // ── 4) data.json 저장 ────────────────────────────────
  const data = {
    updated: nowKST,
    sources: {
      korean: '매일노동뉴스, Google 뉴스',
      global: 'HR Dive, HR Morning, Google News',
    },
    ...result,
  };
  writeFileSync('data.json', JSON.stringify(data, null, 2), 'utf-8');
  console.log(`\n🎉 data.json 업데이트 완료 (${nowKST})\n`);
}

main().catch(e => { console.error('❌ 오류:', e); process.exit(1); });
