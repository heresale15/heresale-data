#!/usr/bin/env node
// 여긴할인 데이터 점검기: node tools/check-data.js
// 출처·확인일·재확인 기한·할인율 범위·중복을 검사하고, 문제가 있으면 목록을 보여 줌 (종료 코드 1).
const fs = require('fs');
const path = require('path');
const file = process.argv[2] || path.join(__dirname, '..', 'data', 'benefits.json');
const D = JSON.parse(fs.readFileSync(file, 'utf8'));
const today = process.argv[3] || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const errors = [], warns = [];
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const isUrl = (s) => /^https:\/\/[^\s]+$/.test(s || '');

function checkCommon(kind, x, needRate) {
  const tag = `${kind} ${x.id || '?'} (${x.name || ''})`;
  if (!x.id) errors.push(`${tag}: id 없음`);
  if (!isUrl(x.src)) errors.push(`${tag}: 출처(src) 주소 없음`);
  if (!isDate(x.checked)) errors.push(`${tag}: 확인일(checked) 없음`);
  if (!isDate(x.reviewBy)) errors.push(`${tag}: 재확인 기한(reviewBy) 없음`);
  else if (x.reviewBy < today) warns.push(`${tag}: 재확인 기한 지남 (${x.reviewBy}) → 앱에서 '확인 기한 지남'으로 표시되고 계산에서 빠짐`);
  if (isDate(x.checked) && x.checked > today) errors.push(`${tag}: 확인일이 미래 (${x.checked})`);
  if (needRate && x.rate != null && !(x.rate > 0 && x.rate <= 50)) errors.push(`${tag}: 할인율 이상 (${x.rate})`);
  if (x.cap != null && !(typeof x.cap === 'number' && x.cap >= 0)) // 0 = 한도 없음
    errors.push(`${tag}: 한도 이상 (${x.cap})`);
}

const seen = new Set();
(D.cards || []).forEach(c => {
  if (seen.has(c.id)) errors.push(`카드 ${c.id}: id 중복`); seen.add(c.id);
  checkCommon('카드', c);
  // 적립·마일리지형이나 '매장 할인 없음'이 설명에 적힌 카드는 규칙이 없어도 정상
  if (!Array.isArray(c.rules) || !c.rules.length) {
    if (c.kind === 'discount' && !/매장 할인 없음/.test(c.minSpend || '')) errors.push(`카드 ${c.id}: 할인 규칙 없음`);
  }
  (c.rules || []).forEach((r, i) => {
    if (!(r.rate > 0 && r.rate <= 70) && !(r.perL > 0) && !(r.amount > 0) && !(r.won > 0)) warns.push(`카드 ${c.id} 규칙${i + 1}: 할인율/금액 확인 필요 (${JSON.stringify(r).slice(0, 80)})`);
    if (!r.all && !(r.brands && r.brands.length) && !(r.cats && r.cats.length)) errors.push(`카드 ${c.id} 규칙${i + 1}: 적용 매장(brands/cats) 없음`);
  });
});
(D.localCurrencies || []).forEach(l => {
  if (l.rate != null) checkCommon('지역화폐', l, true);
  if (!Array.isArray(l.regions) || !l.regions.length) errors.push(`지역화폐 ${l.id}: 지역 없음`);
});
Object.entries(D.carriers || {}).forEach(([id, c]) => checkCommon('통신사', { id, ...c }));
let evCount = 0;
Object.entries(D.events || {}).forEach(([brand, list]) => (list || []).forEach((e, i) => {
  evCount++;
  if (e.type === 'tip') { if (!isDate(e.checked)) errors.push(`행사 ${brand}#${i + 1}: 확인일 없음`); }  // 이용 요령(출처 불필요)
  else checkCommon('행사', { id: `${brand}#${i + 1}`, name: e.title, ...e });
  if (e.end && e.end < today) warns.push(`행사 ${brand}#${i + 1}: 종료됨 (${e.end}) → 앱에서 자동으로 숨김`);
}));

// 프랜차이즈 기간 이벤트 (data/promos.json)
const promoFile = path.join(path.dirname(file), 'promos.json');
let promoCount = 0, promoLive = 0;
if (fs.existsSync(promoFile)) {
  const P = JSON.parse(fs.readFileSync(promoFile, 'utf8'));
  const ids = new Set();
  (P.promos || []).forEach(p => {
    promoCount++;
    const tag = `이벤트 ${p.id || '?'} (${p.title || ''})`;
    if (!p.id) errors.push(`${tag}: id 없음`); else if (ids.has(p.id)) errors.push(`${tag}: id 중복`); ids.add(p.id);
    if (!Array.isArray(p.brands) || !p.brands.length) errors.push(`${tag}: 브랜드 없음`);
    if (!isUrl(p.src)) errors.push(`${tag}: 출처(src) 없음`);
    if (!isDate(p.checked)) errors.push(`${tag}: 확인일 없음`);
    if (!p.title || !p.cond || !p.howTo) errors.push(`${tag}: 제목·조건·이용 방법 중 빈 칸`);
    if (p.recur) {
      if (!isDate(p.reviewBy)) errors.push(`${tag}: 매달 행사는 재확인 기한(reviewBy) 필요`);
      else if (p.reviewBy < today) warns.push(`${tag}: 재확인 기한 지남 → 앱에서 숨김`);
      if (!['monthDay', 'weekdayNth'].includes(p.recur.type)) errors.push(`${tag}: 반복 방식 이상`);
    } else {
      if (!isDate(p.end)) errors.push(`${tag}: 종료일(end) 없음`);
      if (p.start && !isDate(p.start)) errors.push(`${tag}: 시작일 형식 이상`);
      if (p.start && p.end && p.start > p.end) errors.push(`${tag}: 시작일이 종료일보다 늦음`);
      if (p.end && p.end < today) warns.push(`${tag}: 종료됨 (${p.end}) → 앱에서 자동으로 숨김, 다음 점검 때 지워도 됨`);
      else promoLive++;
    }
  });
}
console.log(`점검일 ${today} · 카드 ${(D.cards || []).length} · 지역화폐 ${(D.localCurrencies || []).length} · 통신사 ${Object.keys(D.carriers || {}).length} · 행사 ${evCount} · 프랜차이즈 이벤트 ${promoCount}(진행·예정 ${promoLive})`);
console.log(`오류 ${errors.length}건 · 주의 ${warns.length}건`);
errors.forEach(e => console.log('  ❌ ' + e));
warns.forEach(w => console.log('  ⚠️ ' + w));
process.exit(errors.length ? 1 : 0);
