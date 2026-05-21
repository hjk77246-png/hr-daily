#!/usr/bin/env node
// update-news.mjs — HR Daily News Updater v3
// 전문 사이트 RSS 수집 → Claude AI로 배경/주요내용/시사점 요약 → data.json 저장

import { writeFileSync } from 'fs';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MAX_PER_CATEGORY  = 5;

// ══════════════════════════════════════════════════════════
//  데이터 소스
// ══════════════════════════════════════════════════════════

const LABORTODAY_RSS = 'http://www.labortoday.co.kr/rss/allArticle.xml';

const CAT_KEYWORDS = [
  {
    cat: 'cases',
    kw: ['판결','판례','대법원','고등법원','지방법원','행정법원','노동위원회',
         '판정','부당해고','부당노동행위','근로자지위확인','심판','소송','선고',
         '원고','피고','상고','파기환송','확정','취소 판결'],
  },
  {
    cat: 'gov',
    kw: ['고용노동부','노동부','행정해석','가이드라인','지침','고시','공고','보도자료',
         '근로감독','노동청','행정예고','행정조치','지원사업','지원금','지원대책',
         '일자리','직업훈련','국민취업','고용정책','장관','차관'],
  },
  {
    cat: 'law',
    kw: ['개정','입법','법안','제정','법률안','시행령','시행규칙','최저임금법',
         '근로기준법','산안법','고평법','파견법','비정규직','보호법','노동조합법',
         '최저임금','주52시간','탄력근로','선택근로','연장근로','조례','국회','위원회'],
  },
  {
    cat: 'hr',
    kw: ['채용','인사','복리후생','유연근무','재택근무','워크라이프','직무',
         '역량','승진','연봉','조직문화','인재','리더십','구성원','직원',
         '온보딩','이직','MZ세대','번아웃','몰입','성과관리','다양성'],
  },
];

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
    { url: 'https://www.hrdive.com/feeds/news/',  region: '글로벌', label: 'HR Dive' },
    { url: 'https://www.hrmorning.com/feed/',      region: '글로벌', label: 'HR Morning' },
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

function isRecent(isoDate) {
  if (!isoDate) return false;
  const diff = Date.now() - new Date(isoDate).getTime();
  return diff >= -(12 * 60 * 60 * 1000) && diff <= 36 * 60 * 60 * 1000;
}

function categorize(title) {
  for (const { cat, kw } of CAT_KEYWORDS) {
    if (kw.some(k => title.includes(k))) return cat;
  }
  return null;
}

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
//  RSS 파싱
// ══════════════════════════════════════════════════════════

function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
      return r ? r[1].trim() : '';
    };
    const clean = s => s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/&quot;/g,'"').replace(/&#39;/g,"'")
      .replace(/\s+/g,' ').trim();

    const rawTitle = clean(get('title'));
    if (!rawTitle || rawTitle.length < 4) continue;

    const parts  = rawTitle.split(' - ');
    const title  = parts.length > 1 ? parts.slice(0,-1).join(' - ') : rawTitle;
    const source = parts.length > 1 ? parts[parts.length-1] : '';
    const link   = clean(get('link') || get('guid'));
    const desc   = clean(get('description')).slice(0, 300);
    const pubStr = get('pubDate');

    let date = '', isoDate = '';
    if (pubStr) {
      try {
        const d = new Date(pubStr);
        isoDate = d.toISOString();
        date = d.toLocaleDateString('ko-KR', { timeZone:'Asia/Seoul', year:'numeric', month:'long', day:'numeric' });
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
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HRDailyBot/3.0)', 'Accept': 'application/rss+xml, application/xml, */*' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { console.warn(`  ⚠ HTTP ${res.status} [${label}]`); return []; }
    const text = await res.text();
    return parseRSS(text).map(item => ({ ...item, region, sourceLabel: label }));
  } catch(e) {
    clearTimeout(timer);
    console.warn(`  ⚠ [${label}] ${e.message}`);
    return [];
  }
}

// ══════════════════════════════════════════════════════════
//  Claude AI 요약 (배경 / 주요내용 / 시사점)
// ══════════════════════════════════════════════════════════

const CAT_LABEL = {
  law:   '노동법 개정·입법 동향',
  cases: '대법원·행정법원 판례',
  hr:    'HR 트렌드·인사관리',
  gov:   '고용부 행정해석·가이드',
};

async function summarize(article, category) {
  /* API 키 없으면 스킵 */
  if (!ANTHROPIC_API_KEY) {
    return { background: '', main: article.desc || '', implication: '' };
  }

  const prompt = `당신은 HR·노무 전문가입니다.
아래 기사를 분석하여 한국 HR/노무 실무자에게 유용한 요약을 제공하세요.

카테고리: ${CAT_LABEL[category]}
지역: ${article.region}
출처: ${article.sourceLabel || article.source || ''}
제목: ${article.title}
내용: ${article.desc || '(제공 없음)'}

JSON 형식으로 한국어로 응답하세요. 각 항목 1~2문장:
{
  "background":  "배경 — 이 이슈가 등장한 맥락과 이유",
  "main":        "주요내용 — 기사의 핵심 사실·내용",
  "implication": "시사점 — HR/노무 실무자가 주목해야 할 점"
}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const err = await res.text();
      console.warn(`  ⚠ Claude API ${res.status}:`, err.slice(0, 120));
      return { background: '', main: article.desc || '', implication: '' };
    }

    const data  = await res.json();
    const text  = data.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) return { background: '', main: article.desc || '', implication: '' };

    const json = JSON.parse(match[0]);
    return {
      background:  (json.background  || '').trim(),
      main:        (json.main        || article.desc || '').trim(),
      implication: (json.implication || '').trim(),
    };
  } catch(e) {
    clearTimeout(timer);
    console.warn('  ⚠ 요약 오류:', e.message);
    return { background: '', main: article.desc || '', implication: '' };
  }
}

// ══════════════════════════════════════════════════════════
//  메인
// ══════════════════════════════════════════════════════════

async function main() {
  const nowKST = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'long',
    day: 'numeric', weekday: 'long', hour: '2-digit', minute: '2-digit',
  });
  console.log(`\n🚀 HR 데일리 수집 시작 (${nowKST})\n`);
  console.log(`🤖 Claude 요약: ${ANTHROPIC_API_KEY ? '활성화' : '비활성화 (ANTHROPIC_API_KEY 미설정)'}\n`);

  const buckets = { law: [], cases: [], hr: [], gov: [] };

  /* ── 1) 매일노동뉴스 수집 & 키워드 분류 ── */
  console.log('📰 [매일노동뉴스] 수집 중...');
  const ltItems = await fetchFeed(LABORTODAY_RSS, '국내', '매일노동뉴스');
  let ltCount = 0;
  for (const item of ltItems) {
    if (!isRecent(item.isoDate)) continue;
    const cat = categorize(item.title);
    if (cat) { buckets[cat].push(item); ltCount++; }
  }
  console.log(`   → ${ltCount}건 분류\n`);
  await new Promise(r => setTimeout(r, 800));

  /* ── 2) 카테고리별 추가 소스 ── */
  for (const [cat, feeds] of Object.entries(EXTRA_FEEDS)) {
    console.log(`📂 [${CAT_LABEL[cat]}] 추가 수집...`);
    for (const { url, region, label } of feeds) {
      const items = await fetchFeed(url, region, label);
      const recent = items.filter(i => isRecent(i.isoDate));
      buckets[cat].push(...recent);
      console.log(`   [${label}] ${recent.length}건`);
      await new Promise(r => setTimeout(r, 600));
    }
  }

  /* ── 3) 중복 제거 & 상위 5건 선택 ── */
  const selected = {};
  for (const [cat, items] of Object.entries(buckets)) {
    selected[cat] = dedup(items).slice(0, MAX_PER_CATEGORY);
    console.log(`\n✅ [${CAT_LABEL[cat]}] ${selected[cat].length}건 선택`);
  }

  /* ── 4) Claude AI 요약 ── */
  if (ANTHROPIC_API_KEY) {
    console.log('\n🤖 Claude AI 요약 생성 중...');
    for (const [cat, items] of Object.entries(selected)) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        process.stdout.write(`   [${CAT_LABEL[cat]}] ${i+1}/${items.length} "${item.title.slice(0,30)}..." `);
        const summary = await summarize(item, cat);
        items[i] = { ...item, ...summary };
        console.log('✅');
        await new Promise(r => setTimeout(r, 300)); // API rate limit 대응
      }
    }
  }

  /* ── 5) data.json 저장 ── */
  const data = {
    updated: nowKST,
    aiSummary: !!ANTHROPIC_API_KEY,
    sources: {
      korean: '매일노동뉴스, Google 뉴스',
      global: 'HR Dive, HR Morning, Google News',
    },
    ...selected,
  };
  writeFileSync('data.json', JSON.stringify(data, null, 2), 'utf-8');
  console.log(`\n🎉 data.json 저장 완료 (${nowKST})\n`);
}

main().catch(e => { console.error('❌ 오류:', e); process.exit(1); });
