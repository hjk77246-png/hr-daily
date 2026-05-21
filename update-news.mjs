#!/usr/bin/env node
// update-news.mjs — HR Daily News Updater
// Google 뉴스 RSS에서 HR/노무 관련 최신 뉴스를 수집하고 data.json을 업데이트합니다.

import { writeFileSync } from 'fs';

// ── 카테고리별 검색 피드 ──────────────────────────────────────
const FEEDS = {
  law: [
    { url: 'https://news.google.com/rss/search?q=%EB%85%B8%EB%8F%99%EB%B2%95+%EA%B0%9C%EC%A0%95+%EC%9E%85%EB%B2%95&hl=ko&gl=KR&ceid=KR:ko', region: '국내' },
    { url: 'https://news.google.com/rss/search?q=%EA%B7%BC%EB%A1%9C%EA%B8%B0%EC%A4%80%EB%B2%95+%EC%B5%9C%EC%A0%80%EC%9E%84%EA%B8%88+%EA%B0%9C%EC%A0%95&hl=ko&gl=KR&ceid=KR:ko', region: '국내' },
    { url: 'https://news.google.com/rss/search?q=labor+law+reform+employment+act&hl=en&gl=US&ceid=US:en', region: '글로벌' },
  ],
  cases: [
    { url: 'https://news.google.com/rss/search?q=%EB%8C%80%EB%B2%95%EC%9B%90+%EB%85%B8%EB%8F%99+%ED%8C%90%EA%B2%B0+%ED%95%B4%EA%B3%A0&hl=ko&gl=KR&ceid=KR:ko', region: '국내' },
    { url: 'https://news.google.com/rss/search?q=%EB%85%B8%EB%8F%99%EC%9C%84%EC%9B%90%ED%9A%8C+%ED%8C%90%EC%A0%95+%ED%8C%90%EB%A1%80&hl=ko&gl=KR&ceid=KR:ko', region: '국내' },
    { url: 'https://news.google.com/rss/search?q=%ED%96%89%EC%A0%95%EB%B2%95%EC%9B%90+%EA%B3%A0%EC%9A%A9+%EC%B7%A8%EC%86%8C+%ED%8C%90%EA%B2%B0&hl=ko&gl=KR&ceid=KR:ko', region: '국내' },
    { url: 'https://news.google.com/rss/search?q=employment+court+ruling+wrongful+termination&hl=en&gl=US&ceid=US:en', region: '글로벌' },
  ],
  hr: [
    { url: 'https://news.google.com/rss/search?q=HR+%EC%9D%B8%EC%82%AC%EA%B4%80%EB%A6%AC+%EC%A1%B0%EC%A7%81%EB%AC%B8%ED%99%94&hl=ko&gl=KR&ceid=KR:ko', region: '국내' },
    { url: 'https://news.google.com/rss/search?q=%EC%9C%A0%EC%97%B0%EA%B7%BC%EB%AC%B4+%EC%9B%B0%EB%B9%99+%EB%B3%B5%EB%A6%AC%ED%9B%84%EC%83%9D+%EC%9D%B8%EC%9E%AC&hl=ko&gl=KR&ceid=KR:ko', region: '국내' },
    { url: 'https://news.google.com/rss/search?q=HR+trends+workforce+talent+management+2026&hl=en&gl=US&ceid=US:en', region: '글로벌' },
    { url: 'https://news.google.com/rss/search?q=remote+work+AI+workplace+employee+engagement&hl=en&gl=US&ceid=US:en', region: '글로벌' },
  ],
  gov: [
    { url: 'https://news.google.com/rss/search?q=%EA%B3%A0%EC%9A%A9%EB%85%B8%EB%8F%99%EB%B6%80+%EC%A7%80%EC%B9%A8+%EA%B0%80%EC%9D%B4%EB%93%9C%EB%9D%BC%EC%9D%B8+%EC%8B%9C%ED%96%89&hl=ko&gl=KR&ceid=KR:ko', region: '국내' },
    { url: 'https://news.google.com/rss/search?q=%EA%B3%A0%EC%9A%A9%EB%85%B8%EB%8F%99%EB%B6%80+%ED%96%89%EC%A0%95%ED%95%B4%EC%84%9D+%EB%B3%B4%EB%8F%84%EC%9E%90%EB%A3%8C&hl=ko&gl=KR&ceid=KR:ko', region: '국내' },
  ],
};

// ── RSS 파싱 (외부 라이브러리 없이 동작) ─────────────────────
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };

    const clean = (s) =>
      s.replace(/<[^>]+>/g, '')
       .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

    const title = clean(get('title'));
    if (!title || title.length < 5) continue;

    // 소스 추출 (<source> 태그 또는 제목 뒤 ' - 출처' 형식)
    const srcTag = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    const sourceName = srcTag ? clean(srcTag[1]) : '';

    const rawLink = clean(get('link') || get('guid'));
    const desc = clean(get('description')).slice(0, 200);

    const pubDate = get('pubDate');
    let date = '';
    try {
      if (pubDate) {
        date = new Date(pubDate).toLocaleDateString('ko-KR', {
          year: 'numeric', month: 'long', day: 'numeric'
        });
      }
    } catch (_) {}

    // 제목에서 ' - 언론사' 부분 분리
    const titleParts = title.split(' - ');
    const cleanTitle = titleParts.length > 1 ? titleParts.slice(0, -1).join(' - ') : title;
    const source = sourceName || (titleParts.length > 1 ? titleParts[titleParts.length - 1] : '');

    items.push({ title: cleanTitle, url: rawLink, desc, date, source });
  }
  return items;
}

// ── 피드 가져오기 ─────────────────────────────────────────────
async function fetchFeed(url, region) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HRDailyBot/1.0; +https://hjk77246-png.github.io/hr-daily)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) { console.warn(`  ⚠ HTTP ${res.status}: ${url.slice(0, 60)}`); return []; }
    const text = await res.text();
    return parseRSS(text).slice(0, 5).map(item => ({ ...item, region, isNew: true }));
  } catch (e) {
    console.warn(`  ⚠ 피드 오류: ${e.message}`);
    return [];
  }
}

// ── 중복 제거 ──────────────────────────────────────────────────
function deduplicate(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.title.slice(0, 40).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── 메인 ──────────────────────────────────────────────────────
async function main() {
  console.log('\n🚀 HR 데일리 뉴스 수집 시작\n');

  const result = {};

  for (const [category, feeds] of Object.entries(FEEDS)) {
    const label = { law: '노동법 개정/입법', cases: '판례', hr: 'HR 트렌드', gov: '고용부 해석' }[category];
    console.log(`📂 [${label}] 수집 중...`);

    const allItems = [];
    for (const { url, region } of feeds) {
      const items = await fetchFeed(url, region);
      allItems.push(...items);
      await new Promise(r => setTimeout(r, 800)); // 요청 간격
    }

    result[category] = deduplicate(allItems).slice(0, 6);
    console.log(`   → ${result[category].length}건 수집 완료`);
  }

  // 한국 시간(KST) 기준 업데이트 시각
  const updatedAt = new Date().toLocaleString('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: 'long', day: 'numeric',
    weekday: 'long', hour: '2-digit', minute: '2-digit',
  });

  const data = { updated: updatedAt, ...result };

  writeFileSync('data.json', JSON.stringify(data, null, 2), 'utf-8');
  console.log(`\n✅ data.json 업데이트 완료 (${updatedAt})\n`);
}

main().catch(e => { console.error('❌ 오류:', e); process.exit(1); });
