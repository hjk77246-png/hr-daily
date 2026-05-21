#!/usr/bin/env node
// update-news.mjs — HR Daily News Updater
// GitHub Actions에서 매일 실행 → Google 뉴스 RSS 수집 → data.json 갱신

import { writeFileSync } from 'fs';

// ── 카테고리별 RSS 피드 ──────────────────────────────────────
const FEEDS = {
  law: [
    { url: 'https://news.google.com/rss/search?q=%EB%85%B8%EB%8F%99%EB%B2%95+%EA%B0%9C%EC%A0%95+%EC%9E%85%EB%B2%95&hl=ko&gl=KR&ceid=KR:ko',            region: '국내' },
    { url: 'https://news.google.com/rss/search?q=%EA%B7%BC%EB%A1%9C%EA%B8%B0%EC%A4%80%EB%B2%95+%EC%B5%9C%EC%A0%80%EC%9E%84%EA%B8%88+%EA%B0%9C%EC%A0%95&hl=ko&gl=KR&ceid=KR:ko', region: '국내' },
    { url: 'https://news.google.com/rss/search?q=labor+law+reform+employment+act+2026&hl=en&gl=US&ceid=US:en',                                              region: '글로벌' },
  ],
  cases: [
    { url: 'https://news.google.com/rss/search?q=%EB%8C%80%EB%B2%95%EC%9B%90+%EB%85%B8%EB%8F%99+%ED%8C%90%EA%B2%B0+%ED%95%B4%EA%B3%A0&hl=ko&gl=KR&ceid=KR:ko', region: '국내' },
    { url: 'https://news.google.com/rss/search?q=%EB%85%B8%EB%8F%99%EC%9C%84%EC%9B%90%ED%9A%8C+%ED%8C%90%EC%A0%95+%ED%8C%90%EB%A1%80&hl=ko&gl=KR&ceid=KR:ko',    region: '국내' },
    { url: 'https://news.google.com/rss/search?q=%ED%96%89%EC%A0%95%EB%B2%95%EC%9B%90+%EA%B3%A0%EC%9A%A9+%EC%B7%A8%EC%86%8C+%ED%8C%90%EA%B2%B0&hl=ko&gl=KR&ceid=KR:ko', region: '국내' },
    { url: 'https://news.google.com/rss/search?q=employment+court+ruling+wrongful+termination+labor&hl=en&gl=US&ceid=US:en',                                  region: '글로벌' },
  ],
  hr: [
    { url: 'https://news.google.com/rss/search?q=HR+%EC%9D%B8%EC%82%AC%EA%B4%80%EB%A6%AC+%EC%A1%B0%EC%A7%81%EB%AC%B8%ED%99%94&hl=ko&gl=KR&ceid=KR:ko',               region: '국내' },
    { url: 'https://news.google.com/rss/search?q=%EC%9C%A0%EC%97%B0%EA%B7%BC%EB%AC%B4+%EC%9B%B0%EB%B9%99+%EB%B3%B5%EB%A6%AC%ED%9B%84%EC%83%9D+%EC%9D%B8%EC%9E%AC&hl=ko&gl=KR&ceid=KR:ko', region: '국내' },
    { url: 'https://news.google.com/rss/search?q=HR+trends+workforce+talent+management+2026&hl=en&gl=US&ceid=US:en',                                           region: '글로벌' },
    { url: 'https://news.google.com/rss/search?q=remote+work+AI+workplace+employee+engagement&hl=en&gl=US&ceid=US:en',                                         region: '글로벌' },
  ],
  gov: [
    { url: 'https://news.google.com/rss/search?q=%EA%B3%A0%EC%9A%A9%EB%85%B8%EB%8F%99%EB%B6%80+%EC%A7%80%EC%B9%A8+%EA%B0%80%EC%9D%B4%EB%93%9C%EB%9D%BC%EC%9D%B8&hl=ko&gl=KR&ceid=KR:ko',    region: '국내' },
    { url: 'https://news.google.com/rss/search?q=%EA%B3%A0%EC%9A%A9%EB%85%B8%EB%8F%99%EB%B6%80+%ED%96%89%EC%A0%95%ED%95%B4%EC%84%9D+%EB%B3%B4%EB%8F%84%EC%9E%90%EB%A3%8C&hl=ko&gl=KR&ceid=KR:ko', region: '국내' },
  ],
};

// ── 36시간 이내 기사인지 확인 ──────────────────────────────
function isRecent(isoDate) {
  if (!isoDate) return false;
  const diff = Date.now() - new Date(isoDate).getTime();
  return diff >= 0 && diff <= 36 * 60 * 60 * 1000;
}

// ── RSS XML 파싱 ──────────────────────────────────────────
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

    // "제목 - 언론사" 분리
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
        isoDate  = d.toISOString();
        date = d.toLocaleDateString('ko-KR', {
          timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric'
        });
      } catch(_) {}
    }
    items.push({ title, url: link, desc, date, isoDate, source });
  }
  return items;
}

// ── 피드 가져오기 ─────────────────────────────────────────
async function fetchFeed(url, region) {
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
    if (!res.ok) { console.warn(`  ⚠ HTTP ${res.status}: ${url.slice(0, 60)}`); return []; }
    const text = await res.text();

    return parseRSS(text)
      .filter(item => isRecent(item.isoDate))   // ← 오늘 기사만
      .slice(0, 5)
      .map(item => ({ ...item, region }));
  } catch(e) {
    clearTimeout(timer);
    console.warn(`  ⚠ 피드 오류: ${e.message}`);
    return [];
  }
}

// ── 중복 제거 ──────────────────────────────────────────────
function deduplicate(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.title.slice(0, 40).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── 메인 ──────────────────────────────────────────────────
async function main() {
  const nowKST = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'long', hour: '2-digit', minute: '2-digit',
  });
  console.log(`\n🚀 HR 데일리 뉴스 수집 시작 (${nowKST})\n`);

  const result = {};
  const labels = { law: '노동법 개정/입법', cases: '판례', hr: 'HR 트렌드', gov: '고용부 해석' };

  for (const [cat, feeds] of Object.entries(FEEDS)) {
    console.log(`📂 [${labels[cat]}] 수집 중...`);
    const bucket = [];
    for (const { url, region } of feeds) {
      const items = await fetchFeed(url, region);
      bucket.push(...items);
      await new Promise(r => setTimeout(r, 800));
    }
    result[cat] = deduplicate(bucket).slice(0, 6);
    console.log(`   → 오늘 기사 ${result[cat].length}건`);
  }

  const data = { updated: nowKST, ...result };
  writeFileSync('data.json', JSON.stringify(data, null, 2), 'utf-8');
  console.log(`\n✅ data.json 업데이트 완료 (${nowKST})\n`);
}

main().catch(e => { console.error('❌ 오류:', e); process.exit(1); });
