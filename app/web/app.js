/* 여긴할인 v15 — 앱 로직
 * 데이터: /data/benefits.json (확인 기한 reviewBy가 지난 항목은 자동으로 계산에서 제외)
 * 매장: 카카오 로컬 API (영역을 나눠 45개 제한 없이 전부 수집) → 실패 시 오픈스트리트맵
 */
'use strict';

// =====================================================================
// 0. 설정 — 배포 전에 여기만 고치면 됩니다
// =====================================================================
const CONFIG = {
  kakaoRestKey: '', // v35부터 비움: 카카오 검색은 여긴할인 서버(apiBase)가 대신 함 (키는 서버 비밀값 KAKAO_REST_KEY)
  supabaseUrl: '',            // v38: 안 씀(제보는 Cloudflare 서버 /api/report로)
  supabaseKey: '',            // publishable(anon) 키만. 비워 두면 제보는 이메일로 안내
  contactEmail: 'heresale15@gmail.com',           // 제보 받을 이메일 (선택)
  // Cloudflare Web Analytics 토큰 (쿠키 없이 방문 수만 집계). 대시보드 > Analytics & Logs > Web Analytics > Add a site 에서 받은 token
  cfAnalyticsToken: '0880a3754dd54525af2e4e933c9cc6c9',
  dataUrl: '/data/benefits.json',
  // 앱(안드로이드·아이폰)에서는 이 주소의 최신 혜택 데이터를 먼저 받고, 실패하면 앱에 들어 있는 데이터를 씀
  remoteBase: 'https://heresale.hsy015.workers.dev',
  // 여긴할인 서버(Cloudflare Worker, worker/worker.js) 주소. 넣으면 카카오 검색을 서버가 대신 하고(키 숨김) 익명 통계를 받음.
  // 비워 두면 예전처럼 앱이 카카오를 직접 부름. 예: 'https://heresale-api.hsy015.workers.dev'
  apiBase: 'https://heresale-api.hsy015.workers.dev',
  promosUrl: '',
  // 자동 업데이트 자료 저장소 (GitHub). 예약 작업이 여기에 benefits.json·promos.json·points.json 을 올리면
  // 업로드·배포 없이 앱이 최신 자료를 씀. 앱에 든 자료와 비교해 더 새 것(meta.version·checkedAt)을 고름. 비워 두면 앱에 든 자료만 씀
  dataRepo: 'heresale15/heresale-data',   // GitHub 아이디/저장소
  // 카카오 지도 JavaScript 키 (카카오 개발자센터 > 내 애플리케이션 > 앱 키 > JavaScript 키). 비워 두면 오픈스트리트맵 지도를 씀
  // 카카오 개발자센터 [플랫폼 > Web]에 https://heresale.hsy015.workers.dev 와 https://localhost(앱) 를 등록해야 지도가 열림
  kcBase: 'https://heresale-kc.hsy015.workers.dev/kc',   // v39: 지역화폐 가맹점 파일 전용 사이트(앱 코드 자동 배포와 분리). 실패하면 앱 안 /data/merchants/kc
  kakaoJsKey: 'e01cdaed9c25c85c77cad56ab7c95af3',   // 공개용 키(등록한 도메인에서만 동작)   // 비워 두면 앱에 든 data/promos.json 사용. 나중에 매주 자동 갱신 주소를 넣으면 업로드 없이 바뀜
  maxKakaoRequests: 160,      // 위치 1번 검색에 쓰는 최대 호출 수
  cacheMinutes: 20,
  // 카드 발급 안내. affiliate:false(기본) = 카드 정보 페이지로만 연결, 수수료 없음.
  // 발급 수수료(CPA)를 받으려면 카드사 제휴모집인 계약 또는 금융상품판매대리·중개업 등록 후 true로 바꾸고
  // affiliateUrls에 카드 id별 링크를 넣으세요. 광고 표시와 여신금융협회 심의필 번호(adReviewNo)가 함께 노출됩니다.
  cardPromo: { affiliate: false, affiliateUrls: {}, adReviewNo: '' }
};

// =====================================================================
// 1. 공통 도구
// =====================================================================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const won = (n) => Math.round(Number(n) || 0).toLocaleString('ko-KR') + '원';
const pct = (r) => (Math.round((Number(r) || 0) * 10) / 10) + '%';
const dist = (m) => { const d = Number(m) || 0; return d >= 1000 ? (d / 1000).toFixed(1) + 'km' : Math.round(d) + 'm'; };
// ---- 카드 포인트 사용처 (할인이 아니라 모아 둔 포인트를 결제 금액 일부로 쓰는 곳) ----
function ptProgramOn(p) {
  if ((p.cards || []).some(id => S.owned.has(id))) return true;
  if (store.get('hs_pt_' + p.id, false)) return true;   // 목록에 없는 카드(예: 현대카드MM)를 쓰는 사람이 직접 켬
  return false;
}
function pointUseFor(st) {
  const today = todayStr(), dow = String(new Date().getDay());
  for (const p of (POINTS.programs || [])) {
    if (!ptProgramOn(p)) continue;
    const m = (p.merchants || {})[st.brand];
    if (!m || !(m.rate > 0 && m.rate <= 100)) continue;
    if ((m.reviewBy && m.reviewBy < today) || (m.end && m.end < today) || (m.start && m.start > today)) continue;
    const rate = (m.days && m.days[dow]) || m.rate;
    return { p, m, rate, maxRate: Math.max(m.rate, ...Object.values(m.days || {})) };
  }
  return null;
}
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, t = (x) => x * Math.PI / 180;
  const a = Math.sin(t(lat2 - lat1) / 2) ** 2 + Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin(t(lon2 - lon1) / 2) ** 2;
  return Math.round(2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), 2800);
}
async function fetchT(url, opt = {}, ms = 6000) {
  const c = new AbortController(); const id = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opt, signal: c.signal }); } finally { clearTimeout(id); }
}

// =====================================================================
// 2. 업종·브랜드
// =====================================================================
const CATS = [
  { id: 'all', label: '전체' },
  { id: 'cvs', label: '편의점', emoji: '🏪', color: '#2563eb' },
  { id: 'cafe', label: '카페', emoji: '☕', color: '#8a5a2b' },
  { id: 'mart', label: '대형마트', emoji: '🛒', color: '#d97706' },
  { id: 'super', label: '슈퍼', emoji: '🧺', color: '#b45309' },
  { id: 'drugstore', label: 'H&B·생활', emoji: '🛍️', color: '#db2777' },
  { id: 'bakery', label: '베이커리', emoji: '🥐', color: '#9333ea' },
  { id: 'dining', label: '외식', emoji: '🍔', color: '#dc2626' },
  { id: 'culture', label: '영화·서점', emoji: '🎬', color: '#4f46e5' },
  { id: 'fuel', label: '주유', emoji: '⛽', color: '#0d9488' },
  { id: 'beauty', label: '헤어·뷰티', emoji: '💇', color: '#0891b2' },
  { id: 'life', label: '약국·생활', emoji: '🧾', color: '#65a30d' }
];
const catOf = (id) => CATS.find(c => c.id === id) || { id: 'etc', label: '기타', emoji: '📍', color: '#64748b' };

// [브랜드, 업종, 찾을 문자열(소문자, 공백 제거 기준)] — 위에서부터 먼저 맞는 것 사용
const BRANDS = [
  ['이마트24', 'cvs', ['이마트24', 'emart24']], ['GS25', 'cvs', ['gs25', '지에스25']], ['세븐일레븐', 'cvs', ['세븐일레븐', '7-eleven', '7eleven']],
  ['미니스톱', 'cvs', ['미니스톱']], ['씨스페이스', 'cvs', ['씨스페이스']], ['스토리웨이', 'cvs', ['스토리웨이']],
  ['노브랜드버거', 'dining', ['노브랜드버거']],
  ['이마트 에브리데이', 'super', ['이마트에브리데이']], ['홈플러스 익스프레스', 'super', ['홈플러스익스프레스']],
  ['노브랜드', 'super', ['노브랜드']], ['GS더프레시', 'super', ['gs더프레시', 'gs수퍼']], ['롯데슈퍼', 'super', ['롯데슈퍼']],
  ['탑마트', 'super', ['탑마트']], ['메가마트', 'super', ['메가마트']], ['하나로마트', 'super', ['하나로마트', '하나로클럽']],
  ['이마트', 'mart', ['이마트', '트레이더스']], ['롯데마트', 'mart', ['롯데마트']], ['홈플러스', 'mart', ['홈플러스']], ['코스트코', 'mart', ['코스트코', 'costco']],
  ['메가박스', 'culture', ['메가박스']], ['CGV', 'culture', ['cgv']], ['롯데시네마', 'culture', ['롯데시네마']],
  ['교보문고', 'culture', ['교보문고']], ['영풍문고', 'culture', ['영풍문고']], ['알라딘 중고서점', 'culture', ['알라딘중고']],
  ['스타벅스', 'cafe', ['스타벅스', 'starbucks']], ['투썸플레이스', 'cafe', ['투썸']], ['메가MGC커피', 'cafe', ['메가커피', '메가mgc', '메가엠지씨']],
  ['컴포즈커피', 'cafe', ['컴포즈커피']], ['빽다방', 'cafe', ['빽다방']], ['이디야커피', 'cafe', ['이디야']], ['더벤티', 'cafe', ['더벤티']],
  ['텐퍼센트커피', 'cafe', ['텐퍼센트']], ['하삼동커피', 'cafe', ['하삼동']], ['매머드커피', 'cafe', ['매머드커피', '매머드익스프레스']],
  ['폴바셋', 'cafe', ['폴바셋']], ['할리스', 'cafe', ['할리스']], ['파스쿠찌', 'cafe', ['파스쿠찌']], ['커피빈', 'cafe', ['커피빈']],
  ['엔제리너스', 'cafe', ['엔제리너스']], ['탐앤탐스', 'cafe', ['탐앤탐스']], ['공차', 'cafe', ['공차']], ['카페베네', 'cafe', ['카페베네']],
  ['올리브영', 'drugstore', ['올리브영']], ['다이소', 'drugstore', ['다이소']], ['무신사스탠다드', 'drugstore', ['무신사스탠다드']],
  ['ABC마트', 'drugstore', ['abc마트']], ['아트박스', 'drugstore', ['아트박스']], ['모던하우스', 'drugstore', ['모던하우스']], ['시코르', 'drugstore', ['시코르']],
  ['파리바게뜨', 'bakery', ['파리바게뜨', '파리바게트']], ['뚜레쥬르', 'bakery', ['뚜레쥬르']], ['배스킨라빈스', 'bakery', ['배스킨라빈스', '베스킨라빈스']],
  ['던킨', 'bakery', ['던킨']], ['크리스피크림', 'bakery', ['크리스피크림']], ['설빙', 'bakery', ['설빙']], ['성심당', 'bakery', ['성심당']],
  ['맥도날드', 'dining', ['맥도날드']], ['버거킹', 'dining', ['버거킹']], ['롯데리아', 'dining', ['롯데리아']], ['맘스터치', 'dining', ['맘스터치']],
  ['KFC', 'dining', ['kfc']], ['프랭크버거', 'dining', ['프랭크버거']], ['서브웨이', 'dining', ['서브웨이', '써브웨이']], ['이삭토스트', 'dining', ['이삭토스트']],
  ['아웃백스테이크하우스', 'dining', ['아웃백']], ['빕스', 'dining', ['빕스']], ['애슐리퀸즈', 'dining', ['애슐리']], ['도미노피자', 'dining', ['도미노피자']],
  ['피자헛', 'dining', ['피자헛']], ['파파존스', 'dining', ['파파존스']], ['교촌치킨', 'dining', ['교촌치킨']], ['bhc치킨', 'dining', ['bhc']],
  ['BBQ치킨', 'dining', ['bbq', '비비큐']], ['굽네치킨', 'dining', ['굽네치킨']],
  ['라그릴리아', 'dining', ['라그릴리아']], ['본죽', 'dining', ['본죽']], ['팀홀튼', 'cafe', ['팀홀튼', 'timhortons']],
  ['SK에너지', 'fuel', ['sk에너지', 'sk주유소', 'sk네트웍스']], ['GS칼텍스', 'fuel', ['gs칼텍스']], ['S-OIL', 'fuel', ['s-oil', '에쓰오일', 's오일']],
  ['HD현대오일뱅크', 'fuel', ['현대오일뱅크', '오일뱅크']], ['알뜰주유소', 'fuel', ['알뜰주유소']]
];
// 카카오 키워드로 따로 찾을 브랜드 (카테고리 검색에 안 잡히는 업종)
const KEYWORD_GROUPS = {
  drugstore: ['올리브영', '다이소', '무신사스탠다드', 'ABC마트', '아트박스', '모던하우스', '시코르'],
  bakery: ['파리바게뜨', '뚜레쥬르', '배스킨라빈스', '던킨', '크리스피크림', '설빙', '성심당'],
  dining: ['맥도날드', '버거킹', '롯데리아', '맘스터치', 'KFC', '노브랜드버거', '프랭크버거', '서브웨이', '이삭토스트', '아웃백', '빕스', '애슐리', '도미노피자', '피자헛', '파파존스', '교촌치킨', 'bhc', 'BBQ', '굽네치킨'],
  culture: ['CGV', '롯데시네마', '메가박스', '교보문고', '영풍문고', '알라딘 중고서점']
};
const CATEGORY_CODES = { cvs: 'CS2', cafe: 'CE7', mart: 'MT1', fuel: 'OL7' };

// 브랜드 판정: 매장 이름이 브랜드로 '시작'하거나, 카카오 업종 분류의 마지막 칸이 그 브랜드일 때만 인정
// (예전에는 이름 어디든 들어 있으면 인정해서 '역전할머니맥주 강남역CGV점'·'CGV 주차장'이 영화관으로 나왔음)
function matchBrand(text, catText) {
  const n = String(text || '').toLowerCase().replace(/\s+/g, '');
  const last = String(catText || '').split('>').pop().toLowerCase().replace(/\s+/g, '');
  if (((n.startsWith('cu') && !/^cu[a-z]/.test(n)) || n.startsWith('씨유') || last === 'cu')) return { brand: 'CU', category: 'cvs' };
  for (const [brand, category, keys] of BRANDS) {
    if (keys.some(k => n.startsWith(k) || (last && last.includes(k)))) return { brand, category };
  }
  return null;
}
// 매장이 아닌 곳(주차장·ATM·은행·병원·학원·철학원 등)은 목록에서 뺌
const NOT_STORE = /주차장|ATM|자동화기기|은행|금융|증권|보험|철학|운세|점집|부동산|병원|의원|치과|한의원|교회|성당|사찰|학원|교습|숙박|모텔|호텔|관리사무소|공공기관|행정/;

// =====================================================================
// 3. 혜택 데이터 (외부 JSON) + 확인 기한 자동 만료
// =====================================================================
let DATA = { cards: [], carriers: {}, events: {}, storeRules: {}, meta: {}, localCurrencies: [] };
let CATALOG = [];   // 혜택 미확인 실제 카드 이름 목록
let LOGOS = {};
let POINTS = { programs: [] };   // 카드 포인트를 매장에서 쓰는 곳 (data/points.json, 예: 현대카드 M포인트)
let PROMOS = [];   // 프랜차이즈 기간 이벤트 (data/promos.json)     // 브랜드 → 공식 로고 이미지 (허락받은 파일만)
const isExpired = (item) => !!(item && item.reviewBy && todayStr() > item.reviewBy);

async function loadJSON(url) {
  if (NATIVE.on && CONFIG.remoteBase) {
    try {
      const r = await fetchT(CONFIG.remoteBase + url, { cache: 'no-cache' }, 6000);
      if (r.ok) return await r.json();
    } catch (e) {}
  }
  const r = await fetchT(url, { cache: 'no-cache' }, 8000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
// 프랜차이즈 이벤트: CONFIG.promosUrl(매주 자동 갱신 주소)이 있으면 먼저, 없거나 실패하면 앱에 든 파일
// 자동 업데이트 자료: jsDelivr(빠른 CDN) → GitHub 원본 순서로 받아 보고, 앱에 든 자료보다 새것이면 그걸 씀
const metaStamp = (j) => { const m = (j && j.meta) || {}; return [m.version, m.checkedAt].filter(Boolean).map(String).sort().pop() || ''; };   // 둘 중 더 늦은 날짜
async function loadFresh(name, ok) {
  const local = loadJSON('/data/' + name).catch(() => null);
  if (!CONFIG.dataRepo) return local;
  const [user, repo] = CONFIG.dataRepo.split('/');
  const urls = [`https://cdn.jsdelivr.net/gh/${user}/${repo}@main/${name}`, `https://raw.githubusercontent.com/${user}/${repo}/main/${name}`];
  let remote = null;
  for (const u of urls) {
    try { const r = await fetchT(u, { cache: 'no-cache' }, 5000); if (r.ok) { const j = await r.json(); if (ok(j)) { remote = j; break; } } } catch (e) {}
  }
  const l = await local;
  if (!remote) return l;
  if (!l) return remote;
  const pick = metaStamp(remote) >= metaStamp(l) ? remote : l;
  S.dataFrom = S.dataFrom || {}; S.dataFrom[name] = pick === remote ? 'remote' : 'local';
  return pick;
}
async function loadPromos() {
  if (CONFIG.dataRepo) return loadFresh('promos.json', j => j && Array.isArray(j.promos));
  if (CONFIG.promosUrl) {
    try { const r = await fetchT(CONFIG.promosUrl, { cache: 'no-cache' }, 6000); if (r.ok) { const j = await r.json(); if (j && Array.isArray(j.promos)) return j; } } catch (e) {}
  }
  return loadJSON('/data/promos.json');
}
const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const mdLabel = (s) => { const [y, m, d] = s.split('-').map(Number); return `${m}/${d}(${WD[new Date(y, m - 1, d).getDay()]})`; };
function recurHit(r, d) {
  if (r.type === 'monthDay') return d.getDate() === r.day;
  if (r.type === 'weekdayNth') {
    if (d.getDay() !== r.weekday) return false;
    const nth = Math.ceil(d.getDate() / 7), last = d.getDate() + 7 > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    return (r.nth || []).some(n => n === nth || (n === -1 && last));
  }
  return false;
}
// 이 이벤트가 오늘 진행 중인지, 아니면 언제 열리는지. 끝났거나 너무 먼 미래면 null
function promoNext(p, now = new Date()) {
  const t = ymdOf(now);
  if (p.reviewBy && t > p.reviewBy) return null;
  if (p.end && t > p.end) return null;
  if (!p.recur) {
    if (p.start && t < p.start) { const days = Math.round((new Date(p.start) - new Date(t)) / 864e5); return days <= 7 ? { date: p.start, today: false, days } : null; }
    return { date: t, today: true, days: 0, left: p.end ? Math.round((new Date(p.end) - new Date(t)) / 864e5) : null };
  }
  for (let i = 0; i < 45; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i), s = ymdOf(d);
    if (p.end && s > p.end) break;
    if (recurHit(p.recur, d)) return { date: s, today: i === 0, days: i };
  }
  return null;
}
function promoWhen(p, n) {
  const time = p.timeLabel ? ` · ${p.timeLabel}` : '';
  if (p.recur) return (n.today ? '오늘!' : n.days === 1 ? `내일 ${mdLabel(n.date)}` : `다음: ${mdLabel(n.date)}`) + time;
  if (!n.today) return `${mdLabel(n.date)}부터${p.end ? ` ~${mdLabel(p.end)}` : ''}` + time;
  return (p.end ? (n.left === 0 ? '오늘까지!' : n.left <= 3 ? `D-${n.left} (~${mdLabel(p.end)})` : `~${mdLabel(p.end)}까지`) : '진행 중') + time;
}
function promosFor(brand) {
  if (!brand) return [];
  return PROMOS.filter(p => p.brands.includes(brand)).map(p => ({ p, n: promoNext(p) })).filter(x => x.n)
    .sort((a, b) => (b.n.today - a.n.today) || a.n.days - b.n.days);
}
const hotPromo = (brand) => promosFor(brand).some(x => x.n.today);
// 매장 화면·공유·⭐ 알림이 함께 쓰는 '이 매장 혜택' 목록: 기간 이벤트(진행 중·예정) + 상시 혜택·팁
function storeEvents(brand) {
  const pr = promosFor(brand).map(({ p, n }) => ({ title: p.title, badge: n.today ? `🔥 ${p.badge}` : p.badge, est: p.est, condition: `${promoWhen(p, n)} · ${p.cond}`,
    howTo: p.howTo, src: p.src, checked: p.checked, type: n.today ? 'promo' : 'soon', when: promoWhen(p, n), carrier: p.carrier }));
  return pr.concat(((DATA.events || {})[brand] || []).filter(e => !isExpired(e)));
}
async function loadData() {
  const [d, c, l, pr, po] = await Promise.allSettled([
    CONFIG.dataRepo ? loadFresh('benefits.json', j => j && Array.isArray(j.cards) && j.cards.length > 10 && j.carriers) : loadJSON(CONFIG.dataUrl),
    loadJSON('/data/cards_catalog.json'), loadJSON('/data/logos.json'), loadPromos(),
    loadFresh('points.json', j => j && Array.isArray(j.programs))]);
  if (d.status === 'fulfilled' && !d.value) d.status = 'rejected';
  if (po.status === 'fulfilled' && Array.isArray(po.value.programs)) POINTS = po.value;
  if (pr.status === 'fulfilled') PROMOS = (pr.value.promos || []).filter(x => x && x.src && Array.isArray(x.brands));
  if (d.status === 'fulfilled') DATA = d.value; else toast('혜택 정보를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
  if (c.status === 'fulfilled') {
    const verifiedNames = new Set((DATA.cards || []).map(x => x.name.replace(/\s/g, '')));
    CATALOG = (c.value.cards || []).filter(x => !verifiedNames.has(x.name.replace(/\s/g, '')));
  }
  if (l.status === 'fulfilled') LOGOS = Object.fromEntries(Object.entries(l.value).filter(([k]) => !k.startsWith('_')));
  S.dataLoadedAt = Date.now();
  const fixed = selfCheckData();
  if (fixed) { try { console.warn('[여긴할인] 자료 자동 점검: 이상한 항목', fixed, '개를 계산에서 뺐어요'); } catch (e) {} track('datafix', fixed); }
}
// 자료 자동 점검: 잘못 들어간 숫자·형식이 있어도 앱이 틀린 금액을 보여 주지 않도록, 앱이 켜질 때마다 스스로 걸러 냄
function selfCheckData() {
  let n = 0;
  const okNum = (v, lo, hi) => typeof v === 'number' && isFinite(v) && v > lo && v <= hi;
  (DATA.cards || []).forEach(c => {
    const before = (c.rules || []).length;
    c.rules = (c.rules || []).filter(r => r && (Array.isArray(r.brands) && r.brands.length || Array.isArray(r.cats) && r.cats.length || r.all)
      && (okNum(r.rate, 0, 80) || okNum(r.amount, 0, 100000)));
    n += before - c.rules.length;
    if (c.cap !== null && c.cap !== undefined && !(typeof c.cap === 'number' && c.cap >= 0)) { c.cap = null; n++; }
  });
  (DATA.localCurrencies || []).forEach(lc => { if (lc.rate !== null && lc.rate !== undefined && !okNum(lc.rate, 0, 50)) { lc.rate = null; n++; } });
  Object.values(DATA.carriers || {}).forEach(c => Object.entries(c.brands || {}).forEach(([b, v]) => { if (!v || !okNum(v.rate, 0, 50)) { delete c.brands[b]; n++; } }));
  const before = PROMOS.length;
  PROMOS = PROMOS.filter(x => /^https:\/\//.test(x.src || '') && (x.end || x.recur));
  n += before - PROMOS.length;
  return n;
}
// 앱을 오래 켜 둔 채 다시 열면(6시간 이상) 최신 자료를 조용히 다시 받아 옴 → 고친 자료가 바로 반영
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !S.dataLoadedAt || Date.now() - S.dataLoadedAt < 6 * 3600e3) return;
  loadData().then(() => renderAll()).catch(() => {});
});

// =====================================================================
// 4. 상태
// =====================================================================
const OLD_IDS = { card_taptapo: 'samsung_taptap_o', card_mrlife: 'shinhan_mrlife', card_mywesh: 'kb_my_wesh', card_zero2: 'hyundai_zero2',
  card_zero3: 'hyundai_zero3', card_nori2: 'kb_nori2_kbpay', card_lotte_loca: 'lotte_likit_12', cg_kb_cheongchun: 'kb_cheongchun_toktok',
  cg_nh_bazi: 'nh_allbareun_flex', cg_woori_d4: 'woori_d4_2', cg_hyundai_z_work: 'hyundai_z_work2', cg_hyundai_m: 'hyundai_m',
  cg_new_samsung_id_select: 'samsung_id_select_all', cg_woori_shopping: 'woori_shopping_plus', cg_woori_cookie_check: 'woori_cookie_check', card_mg_better: 'mg_better_check' };

const S = {
  tab: 'list', prevTab: 'list',
  cat: 'all',
  center: null,            // {lat, lng, label}
  stores: [], loading: false, source: '', truncated: false, searchLabel: '', errorMsg: '',
  selectedId: null,
  amount: store.get('hs_amount', 10000),
  radius: store.get('hs_radius', 1000),
  carriers: store.get('hs_carriers', []),
  ctier: store.get('hs_ctier', {}),     // v38: 통신사 등급 {SKT:'GOLD'}
  cmode: store.get('hs_cmode', {}),     // v38: SKT 할인형/적립형
  exclAmt: 0,                           // v38: 멤버십 할인 제외 상품 금액(매장마다 새로)
  owned: new Set(store.get('hs_owned', []).map(id => OLD_IDS[id] || id)),
  custom: store.get('hs_custom', []),
  reported: store.get('hs_reported', {}),
  locals: store.get('hs_locals', {}),      // { 지역화폐id: { on: true, rate: 사용자 입력값|null } }
  ledger: store.get('hs_ledger', []),      // 결제 기록 (이 기기에만 저장)
  walletIssuer: '전체', walletType: '전체',
  extra: { key: '', done: {} },
  dbOnly: false,                            // 가맹점만 보기: false 또는 'dongbaek'·'onnuri'…
  verified: store.get('hs_verified', {}),
  favs: store.get('hs_favs', {}),            // ⭐ 자주 가는 곳 { 매장id: {id,name,brand,category,address,jibun,lat,lng,url,t,sig} }
  favNews: store.get('hs_favnews', []),      // 자주 가는 곳 새 소식 [{id,name,msg,t,read}]
  favOnly: false, promoOnly: false,   // 내가 직접 써 본 결과 { 매장id: { 지역화폐id: { ok, t } } } (이 기기에만)
  onboarded: store.get('hs_onboarded', false),
  notify: store.get('hs_notify', false),   // 월말 한도·실적 알림 (앱에서만)
  cardConds: store.get('hs_cardconds', {}), // 카드별로 내가 지키는 조건 { 카드id: ['KB Pay', 'A팩'] }
  capFix: store.get('hs_capfix', {}),
  prevOk: store.get('hs_prevok', {}),       // 카드별 '지난달 실적 채웠어요/못 채웠어요' { 카드id: {month, ok} } (이번 달만 유효)
  big: store.get('hs_big', false),
  pays: store.get('hs_pays', []),           // 내가 쓰는 간편결제 (KB Pay·네이버페이…) → 그 결제수단 조건 할인을 자동으로 계산          // 큰 글씨·쉬운 화면       // 사용자가 고친 이번 달 실제 남은 한도 { 카드id: {month, left, ts} }
  age: store.get('hs_age', ''),             // 카드 발급 나이 조건 거르기: '' | 'u18' | '18_29' | '30p'
  sort: store.get('hs_sort', 'dist'), saveOnly: false,
  localSuggest: [], doneCats: new Set(),
  me: null                 // 실제 GPS 위치
};
// v14에서 직접 입력한 카드 옮기기
(function migrateCustom() {
  const old = store.get('heresale_custom_cards', null);
  if (!old || !Array.isArray(old) || S.custom.length) return;
  S.custom = old.filter(c => c && c.benefit && c.benefit.cats).map(c => ({
    id: c.id, issuer: c.issuer, type: c.type, name: c.name, custom: true, cap: c.benefit.cap || null,
    rules: Object.entries(c.benefit.cats).filter(([, v]) => v > 0).map(([k, v]) => ({ cats: [k], rate: v }))
  }));
  S.custom.forEach(c => S.owned.add(c.id));
  saveWallet();
})();
function saveWallet() {
  store.set('hs_locals', S.locals);
  store.set('hs_ledger', S.ledger.slice(-500));
  store.set('hs_owned', Array.from(S.owned));
  store.set('hs_custom', S.custom);
  store.set('hs_carriers', S.carriers); store.set('hs_ctier', S.ctier); store.set('hs_cmode', S.cmode);
  store.set('hs_pays', S.pays); store.set('hs_cardconds', S.cardConds); store.set('hs_capfix', S.capFix); store.set('hs_prevok', S.prevOk);
}
const allCards = () => [...S.custom, ...(DATA.cards || [])];
const ownedCards = () => allCards().filter(c => S.owned.has(c.id));

// =====================================================================
// 5. 할인 계산
// =====================================================================
function timeOk(when, now) {
  if (!when) return true;
  if (when.hours) {
    const [s, e] = when.hours, h = now.getHours();
    if (!(s < e ? (h >= s && h < e) : (h >= s || h < e))) return false;
  }
  if (when.days && !when.days.includes(now.getDay())) return false;
  if (when.dates && !when.dates.includes(now.getDate())) return false;
  return true;
}
const monthKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
function monthStats(id, mk = monthKey()) {
  let spend = 0, disc = 0, n = 0;
  S.ledger.forEach(e => { if (e.method === id && e.month === mk) { spend += e.amount; disc += e.disc; n++; } });
  return { spend, disc, n };
}
// 혜택 종류: 현금성(할인·캐시백)과 적립(포인트·마일리지·별)을 나눔. 적립은 현금 절약액에 더하지 않음
const POINT_KINDS = ['point', 'mileage', 'star'];
const isCashCard = (c) => !POINT_KINDS.includes(c.kind);
const KIND_LABEL = { discount: '카드 할인 (나중에 카드값에서 빠져요)', cashback: '카드 캐시백 (나중에 돈으로 돌려줘요)', point: '포인트 적립', mileage: '마일리지 적립', star: '별 적립' };
// 카드 혜택 조건: via(간편결제 필수)·opt(옵션·팩 선택). 사용자가 '이렇게 써요'로 확인한 것만 확정 계산
const ruleConds = (r) => [r.via, r.opt].filter(Boolean);
const condsOf = (card) => [...new Set((card.rules || []).flatMap(ruleConds))];
const PAYS = ['KB Pay', '네이버페이', '카카오페이', '토스페이', '삼성페이', '페이코', 'SOL페이', 'NH Pay', '모니모페이', '사이렌오더'];
// via 조건(예: 'KB Pay', '네이버페이·카카오페이·페이코', '간편결제')이 내가 고른 간편결제와 맞는지
const payMatch = (via) => !!via && S.pays.length > 0 && (via === '간편결제' ? true : via.split(/[·,/]/).some(t => S.pays.includes(t.trim())));
const condOk = (card, r, opts = {}) => opts.allConds || ruleConds(r).every(k => (S.cardConds[card.id] || []).includes(k) || (k === r.via && payMatch(k)));
// 받침에 따라 '로/으로' (동백전으로, 카드로, KB Pay로)
function ro(w) { const c = String(w || '').trim().slice(-1).charCodeAt(0); if (c >= 0xAC00 && c <= 0xD7A3) { const j = (c - 0xAC00) % 28; return j === 0 || j === 8 ? '로' : '으로'; } return '로'; }
const condText = (k) => /pay|페이|간편결제|사이렌오더/i.test(k) ? `${k}${ro(k)} 결제` : `${k} 선택`;
function ruleUsed(cardId, idx, mk = monthKey()) {
  return S.ledger.reduce((a, e) => a + (e.method === cardId && e.month === mk && e.rule === idx ? (e.disc || 0) : 0), 0);
}
// 카드 전체 월 한도 기준 남은 한도 (앱 기록 기준 추정 · 사용자가 실제 값을 고쳤으면 그 값 우선)
function cardRemaining(card) {
  if (!(card.cap > 0)) return null;
  const fix = S.capFix[card.id];
  if (fix && fix.month === monthKey()) return Math.max(0, fix.left - S.ledger.reduce((a, e) => a + (e.method === card.id && e.ts > fix.ts ? (e.disc || 0) : 0), 0));
  return Math.max(0, card.cap - monthStats(card.id).disc);
}
// 전월실적: 내가 이번 달에 '채웠어요/못 채웠어요'를 눌렀으면 그 값, 아니면 지난달 결제 기록이 기준 이상이면 충족, 둘 다 없으면 모름(null)
function prevState(card) {
  if (!card.prevMin) return true;
  const m = S.prevOk[card.id];
  if (m && m.month === monthKey()) return m.ok;
  const d = new Date(), prev = monthStats(card.id, monthKey(new Date(d.getFullYear(), d.getMonth() - 1, 1)));
  if (prev.spend >= card.prevMin) return 'ledger';
  return null;
}
function cardDiscount(card, st, amount, now = new Date(), opts = {}) {
  if (isExpired(card)) return { expired: true, disc: 0 };
  if (!opts.ignoreUsed && prevState(card) === false) return { prevFail: true, disc: 0 };
  const rule0 = (DATA.storeRules || {})[st.brand];
  if (rule0 && rule0.acceptIssuers && !rule0.acceptIssuers.includes(card.issuer)) return { excluded: rule0.note, disc: 0 };
  const cardRem = opts.ignoreUsed ? (card.cap > 0 ? card.cap : null) : cardRemaining(card);
  let best = null, cond = null;
  (card.rules || []).forEach((r, idx) => {
    const hit = r.all || (r.brands && r.brands.includes(st.brand)) || (r.cats && r.cats.includes(st.category));
    if (!hit || !timeOk(r.when, now)) return;
    if (r.min && amount < r.min) return;
    let d = r.amount ? Math.min(r.amount, amount) : Math.floor(amount * (r.rate || 0) / 100);
    // 한도: 이 혜택(영역)의 월 한도와 카드 전체 월 한도를 둘 다 적용
    const lims = [];
    if (typeof r.cap === 'number' && r.cap > 0) lims.push(Math.max(0, r.cap - (opts.ignoreUsed ? 0 : ruleUsed(card.id, idx))));
    if (cardRem !== null) lims.push(cardRem);
    const cap = lims.length ? Math.min(...lims) : (card.cap === 0 || r.cap === 0 ? 0 : undefined);
    if (cap !== undefined && (cap > 0 || lims.length)) d = Math.min(d, cap);
    d = Math.max(0, Math.min(d, amount));
    const x = { disc: d, rule: r, idx, cap, capReached: lims.length > 0 && cap === 0, capKnown: lims.length > 0 || card.cap === 0 || r.cap === 0 };
    if (!condOk(card, r, opts)) { if (d > 0 && (!cond || d > cond.disc)) cond = { disc: d, need: ruleConds(r).filter(k => !(S.cardConds[card.id] || []).includes(k) && !(k === r.via && payMatch(k))), rule: r }; return; }
    if (!best || d > best.disc) best = x;
  });
  const out = best || { disc: 0 };
  if (cond && cond.disc > out.disc) out.cond = cond;
  return out;
}
// 발급 나이 조건 (데이터의 age 또는 설명의 '만 18~29세')
function cardAge(c) {
  if (c.age) return c.age;
  const m = String(c.minSpend || '').match(/만\s*(\d+)\s*~\s*(\d+)세/); return m ? { min: +m[1], max: +m[2] } : null;
}
const cardWho = (c) => { const a = cardAge(c); return a ? `만 ${a.min}~${a.max}세만 발급` : /청소년/.test(c.minSpend || '') ? '청소년 전용' : ''; };
const AGE_BANDS = { u18: [0, 17], '18_29': [18, 29], '30p': [30, 120] };
function ageOk(c) {
  const b = AGE_BANDS[S.age]; if (!b) return true;
  const a = cardAge(c); if (a) return !(a.max < b[0] || a.min > b[1]);
  if (/청소년/.test(c.minSpend || '')) return S.age === 'u18';
  return true;
}
// 출처 신뢰도: 카드사·금융그룹 공식 페이지인지, 비교사이트·기사 같은 2차 자료인지
const OFFICIAL_HOSTS = /(^|\.)(kbcard\.com|kbthink\.com|shinhancard\.com|samsungcard\.com|hyundaicard\.com|lottecard\.co\.kr|wooricard\.com|hanacard\.co\.kr|nonghyup\.com|nhcard\.co\.kr|bccard\.com|ibk\.co\.kr|kfcc\.co\.kr|epostbank\.go\.kr|tossbank\.com|kbanknow\.com|kbank\.co\.kr|go\.kr)$/;
function srcTrust(x) {
  if (!x || !x.src) return x && x.custom ? 'mine' : 'none';
  try { return OFFICIAL_HOSTS.test(new URL(x.src).hostname) ? 'official' : 'secondary'; } catch (e) { return 'secondary'; }
}
const trustBadge = (x) => { const t = srcTrust(x); return t === 'official' ? '<span class="tb ok">공식 자료 확인</span>' : t === 'secondary' ? '<span class="tb warn">2차 자료 · 카드사 확인 권장</span>' : t === 'mine' ? '<span class="tb">내가 입력</span>' : ''; };
const ISSUER_HOME = { 'KB국민카드': 'https://card.kbcard.com', '신한카드': 'https://www.shinhancard.com', '현대카드': 'https://www.hyundaicard.com', '우리카드': 'https://pc.wooricard.com',
  '삼성카드': 'https://www.samsungcard.com', 'NH농협카드': 'https://card.nonghyup.com', '롯데카드': 'https://www.lottecard.co.kr', '하나카드': 'https://www.hanacard.co.kr',
  'IBK기업은행': 'https://www.ibk.co.kr', 'MG새마을금고': 'https://www.kfcc.co.kr', '우체국': 'https://www.epostbank.go.kr', '토스뱅크': 'https://www.tossbank.com', '케이뱅크': 'https://www.kbanknow.com' };
// 발급 안내에는 월 한도가 확인된 혜택만 씀 (한도를 모르면 할인액이 부풀려질 수 있음)
const capKnown = (card, rule) => (rule && typeof rule.cap === 'number') || typeof card.cap === 'number';
const ruleLabel = (r) => r.amount ? `${won(r.amount)} 정액` : pct(r.rate);

const REGION_ALIAS = [['서울', '서울'], ['부산', '부산'], ['대구', '대구'], ['인천', '인천'], ['광주', '광주'], ['대전', '대전'], ['울산', '울산'], ['세종', '세종'], ['경기', '경기'],
  ['강원', '강원'], ['충청북', '충북'], ['충북', '충북'], ['충청남', '충남'], ['충남', '충남'], ['전라북', '전북'], ['전북', '전북'], ['전라남', '전남'], ['전남', '전남'],
  ['경상북', '경북'], ['경북', '경북'], ['경상남', '경남'], ['경남', '경남'], ['제주', '제주']];
// 2026년 7월 광주광역시+전라남도 → 전남광주통합특별시. 카카오 주소가 "전남광주통합특별시 서구 …"로 올 수 있어
// 광주 5개 구는 '광주', 나머지 시·군은 '전남'으로 나눔 (광주 지역화폐와 전남 지역화폐가 따로라서)
const GJ_GU = ['동구', '서구', '남구', '북구', '광산구'];
function regionShort(text) {
  const t = String(text || '').trim(); if (!t) return '';
  const toks = t.split(/\s+/); const first = toks[0];
  if (/^전남광주/.test(first)) return GJ_GU.includes(toks[1]) ? '광주' : '전남';
  const hit = REGION_ALIAS.find(([k]) => first.startsWith(k)) || REGION_ALIAS.find(([k]) => t.startsWith(k));
  return hit ? hit[1] : '';
}

// 시·군 단위 지역 키 (예: "경기 수원시"). 수원페이·용인와이페이처럼 시·군 지역화폐 판단용
function cityKey(text) {
  const toks = String(text || '').trim().split(/\s+/); const sido = regionShort(text); if (!sido) return '';
  const t = toks.slice(1, 3).find(x => /^[가-힣]+(?:시|군|구)$/.test(x) && !/^(?:광역시|특별시|특별자치시|특별자치도)$/.test(x));
  return t ? `${sido} ${t}` : '';
}
const regionKeysOf = (text) => [regionShort(text), cityKey(text)].filter(Boolean);
const lcHere = (lc, keys) => lc.regions.includes('*') || lc.regions.some(r => keys.includes(r));

// =====================================================================
// 지역화폐·온누리상품권 가맹점 (공공데이터 → tools/build-merchants.js로 만든 시·군·구별 색인)
// 색인이 없는 종류(아직 자료를 안 넣은 경우)는 조용히 건너뜀 → '가맹점일 때' 조건부 계산
// =====================================================================
const MERCH_SETS = {
  dongbaek: { base: '/data/dongbaek', label: '동백전', region: '부산' },
  onnuri: { base: '/data/merchants/onnuri', label: '온누리', type: 'name' },   // 원본에 주소가 없어 이름+소속 시장으로 확인
  incheon_eum: { base: '/data/merchants/incheon_eum', label: '인천e음', region: '인천' }
};
const MERCH = {};
Object.keys(MERCH_SETS).forEach(id => { MERCH[id] = { index: undefined, gu: {}, loading: {}, failed: {} }; });
const DONGBAEK = MERCH.dongbaek;
const SGG_SKIP = /^(?:광역시|특별시|특별자치시|특별자치도)$/;
// 매장 주소 → 색인의 시·군·구 키 (예: 동백전 "사하구", 온누리 "부산 사하구")
function merchGu(id, addr) {
  const ix = MERCH[id] && MERCH[id].index; if (!ix) return '';
  const t = String(addr || '').trim().split(/\s+/);
  const sido = regionShort(addr); if (!sido) return '';
  if (ix.type === 'name') { const k = (sido === '광주' || sido === '전남') ? '전남광주' : sido; return ix.gus[k] ? k : ''; }
  const region = ix.region || MERCH_SETS[id].region || '';
  if (region && region !== sido) return '';
  for (const x of t.slice(1, 3)) {
    if (SGG_SKIP.test(x)) continue;
    const k = region ? x : `${sido} ${x}`;
    if (ix.gus[k]) return k;
  }
  return ix.gus[sido] ? sido : '';
}
const dbGuOf = (addr) => merchGu('dongbaek', addr);
function dbAddrKeys(addr) {   // tools/build-merchants.js의 addrKeys와 같은 규칙
  const a = String(addr || '').replace(/\(.*?\)/g, ' ').replace(/,.*$/, '').replace(/\s+/g, ' ').trim();
  const keys = [];
  const road = a.match(/([가-힣A-Za-z0-9.]+(?:로|길))\s*(\d+(?:-\d+)?)/);
  if (road) keys.push('R:' + road[1] + ':' + road[2]);
  const jibun = a.match(/([가-힣0-9]+(?:동|가|리|읍|면))\s+(?:산\s*)?(\d+(?:-\d+)?)(?!\S*(?:로|길))/);
  if (jibun && !road) keys.push('J:' + jibun[1] + ':' + jibun[2]);
  return keys;
}
const dbNorm = (n) => String(n || '').toLowerCase().replace(/\(주\)|㈜|주식회사|\(유\)|유한회사/g, '').replace(/[\s·.,\-_()\[\]{}'"&/]+/g, '');
// 카카오 매장명(예: "CU 해운대우동점")과 가맹점 등록명(예: "씨유해운대우동점")을 비교
const DB_ALIAS = [['cu', '씨유'], ['gs25', '지에스25'], ['gs25', '지에스'], ['mgc', '엠지씨'], ['이마트24', '이마트24'], ['kfc', '케이에프씨'], ['bbq', '비비큐'], ['bhc', '비에이치씨']];
function nameLike(rawName, reg) {
  const full = dbNorm(rawName);
  if (!full || !reg) return false;
  if (reg.includes(full) || (full.includes(reg) && reg.length >= 2)) return true;
  const toks = String(rawName).trim().split(/\s+/);
  const brand = dbNorm(toks.length > 1 ? toks.slice(0, -1).join('') : toks[0]);
  const vars = new Set([brand]);
  DB_ALIAS.forEach(([en, ko]) => { if (brand.includes(en)) vars.add(brand.replace(en, ko)); });
  return [...vars].some(v => v.length >= 2 && reg.includes(v));
}
// 매장이 있는 지역의 가맹점 파일만 받아 옴 (동백전 구 1곳 ≈ 250KB)
// ---- 한국조폐공사 지역사랑상품권 가맹점 (위도·경도·사업자 상태 포함) → 위치 칸(0.02도) 단위로 받아 옴 ----
const KC = { index: undefined, t: {}, loading: {}, failed: {}, gen: 0, gu: {} };
function kcTilesFor(st) {
  const n = (KC.index && KC.index.tile) || 50, out = new Set();
  for (const dy of [-0.0012, 0, 0.0012]) for (const dx of [-0.0015, 0, 0.0015]) out.add(`${Math.floor((st.lat + dy) * n)}_${Math.floor((st.lng + dx) * n)}`);
  return [...out];
}
async function ensureKC(stores) {
  if (KC.index === undefined) {
    KC.index = null;
    for (const base of [CONFIG.kcBase, '/data/merchants/kc'].filter(Boolean)) {
      try { KC.index = await loadJSON(base + '/index.json'); KC.base = base; KC.has = new Set(KC.index.tiles || []); break; } catch (e) {}
    }
    if (KC.index && KC.index.type === 'gu') KC.has = new Set();
    if (!KC.index) { if (PROXY_READY) await PROXY_READY; if (KC_API !== null) { KC.index = { tile: 50, complete: false, basis: '', live: true }; KC.has = new Set(); } }
  }
  if (!KC.index) return false;
  if (KC.index.live) return ensureKCLive(stores);
  if (KC.index.type === 'gu') {
    // 시·군·구 파일 방식 (전국 약 250개 파일 중 매장이 있는 곳만 받음)
    if (!KC.gu) KC.gu = {};
    const need = new Set();
    stores.forEach(st => { const g = kcStoreGu(st); if (g && !KC.gu[g]) need.add(g); });
    if (!need.size) return false;
    await Promise.all([...need].map(async g => {
      KC.gu[g] = 'loading';
      try {
        const j = await loadJSON(KC.base + '/g/' + KC.index.gus[g]);
        Object.entries(j.t || {}).forEach(([k, rows]) => { KC.t[k] = (KC.t[k] || []).concat(rows); KC.has.add(k); });
        KC.gu[g] = true;
      } catch (e) { KC.gu[g] = 'failed'; }
    }));
    KC.gen = (KC.gen || 0) + 1;
    return true;
  }
  const need = new Set(); stores.forEach(st => { if (st.lat) kcTilesFor(st).forEach(k => { if (KC.has.has(k) && !KC.t[k] && !KC.loading[k] && !KC.failed[k]) need.add(k); }); });
  if (!need.size) return false;
  await Promise.all([...need].map(async k => { KC.loading[k] = true; try { KC.t[k] = await loadJSON(KC.base + '/t/' + k + '.json'); } catch (e) { KC.failed[k] = true; } KC.loading[k] = false; }));
  KC.gen = (KC.gen || 0) + 1;
  return true;
}
// 서버 실시간 모드: 매장 근처 지점(약 550m 간격)의 법정동 코드를 카카오로 알아낸 뒤, 그 동네 가맹점을 서버에서 받아 위치 칸에 넣음
const KC_EMD = { grid: {}, emd: {}, loading: {} };
async function ensureKCLive(stores) {
  const G = 200;   // 1도를 200칸 → 0.005도
  const c = S.center || stores[0];
  const cells = [...new Set(stores.filter(st => st.lat).map(st => `${Math.round(st.lat * G)}_${Math.round(st.lng * G)}`))]
    .filter(k => KC_EMD.grid[k] === undefined)
    .map(k => { const [a, b] = k.split('_').map(Number); return { k, lat: a / G, lng: b / G }; })
    .sort((p, q) => kcDist(c.lat, c.lng, p.lat, p.lng) - kcDist(c.lat, c.lng, q.lat, q.lng)).slice(0, 16);
  const budget = makeBudget(cells.length);
  await Promise.all(cells.map(async p => {
    KC_EMD.grid[p.k] = null;
    try {
      const r = await kakaoApi('geo/coord2regioncode', { x: p.lng, y: p.lat }, budget);
      const b = (r.documents || []).find(d => d.region_type === 'B');
      if (b && b.code) KC_EMD.grid[p.k] = String(b.code).slice(0, 8);
    } catch (e) { delete KC_EMD.grid[p.k]; }
  }));
  const need = [...new Set(Object.values(KC_EMD.grid).filter(Boolean))].filter(e => !KC_EMD.emd[e] && !KC_EMD.loading[e]);
  if (!need.length) return false;
  const n = KC.index.tile;
  await Promise.all(need.map(async emd => {
    KC_EMD.loading[emd] = true;
    try {
      const r = await fetchT(`${KC_API}/api/kc?emd=${emd}`, {}, 15000); if (!r.ok) throw new Error('kc'); const j = await r.json();
      (j.rows || []).forEach(row => { const k = `${Math.floor(row[1] / 1e5 * n)}_${Math.floor(row[2] / 1e5 * n)}`; (KC.t[k] || (KC.t[k] = [])).push(row); KC.has.add(k); });
      if (j.at) KC.index.basis = j.at;   // 실시간 조회라 '받은 날'을 기준일로 표시
      KC_EMD.emd[emd] = true;
    } catch (e) {}
    KC_EMD.loading[emd] = false;
  }));
  KC.gen = (KC.gen || 0) + 1;
  return true;
}
function kcDist(a, b, c, d) { const x = (d - b) * Math.cos(a * Math.PI / 180) * 111320, y = (c - a) * 111320; return Math.sqrt(x * x + y * y); }
// 결과: member(80m 안에 같은 이름) / closed(같은 이름인데 폐업·해지) / likely(300m 안에 같은 이름) / building(30m 안에 다른 가맹점만) / none / unknown
function kcStatus(st) {
  if (!KC.index || !st.lat) return 'unknown';
  if (st._kc && st._kc.gen === KC.gen) return st._kc.v;      // 같은 자료로 계산한 결과는 다시 쓰기
  const v = kcStatusCalc(st); st._kc = { gen: KC.gen, v }; return v;
}
// 주소 → 시·군·구 열쇠 (tools/build-kc.js와 같은 규칙). 예: "서울 구로구", "경기 성남시 분당구", "세종"
function kcGuKey(addr) {
  const sido = regionShort(addr); if (!sido) return '';
  const rest = String(addr || '').trim().split(/\s+/).slice(1).filter(x => !SGG_SKIP.test(x));
  const a = rest[0] || '';
  if (/(시|군|구)$/.test(a)) { const b = rest[1] || ''; return /시$/.test(a) && /구$/.test(b) ? `${sido} ${a} ${b}` : `${sido} ${a}`; }
  return sido;
}
function kcStoreGu(st) {
  const g = (KC.index && KC.index.gus) || {};
  for (const a of [st.address, st.jibun]) {
    const k = kcGuKey(a); if (k && g[k]) return k;
    const k2 = k.split(' ').slice(0, 2).join(' '); if (k2 && g[k2]) return k2;   // "경기 성남시 분당구" 대신 "경기 성남시"로 묶인 경우
  }
  return '';
}
// v38: 모든 매장을 본사가 직영하는 브랜드 → 지역화폐 가맹점 아님 (공공데이터의 비슷한 이름보다 우선)
// 스타벅스: 스타벅스코리아 '전 매장 직영' 공식 안내 · 서울시: 대기업·중견기업 직영점은 서울사랑상품권 가맹 제한
const DIRECT_ONLY = new Set(['스타벅스']);
let EXCL_BRANDS = null;
const exclBrand = (b) => { if (!EXCL_BRANDS) { EXCL_BRANDS = new Set(); localList().forEach(l => (l.excludeBrands || []).forEach(x => EXCL_BRANDS.add(x))); } return EXCL_BRANDS.has(b); };
function kcStatusCalc(st) {
  if (KC.index.type === 'gu') { const g = kcStoreGu(st); if (!g || KC.gu[g] !== true) return 'unknown'; }
  const tiles = kcTilesFor(st).filter(k => KC.has.has(k));
  if (tiles.some(k => !KC.t[k])) return 'unknown';
  let best = null, near30 = false;
  const la0 = st.lat * 1e5, ln0 = st.lng * 1e5;
  for (const k of tiles) for (const [n, la, ln, f] of KC.t[k]) {
    if (Math.abs(la - la0) > 300 || Math.abs(ln - ln0) > 380) continue;   // 약 300m 밖은 바로 건너뜀
    const dist = kcDist(st.lat, st.lng, la / 1e5, ln / 1e5); if (dist > 300) continue;
    if (dist <= 30 && !(f & 1)) near30 = true;
    if (!nameLike(st.name, n)) continue;
    if (st.brand && exclBrand(st.brand) && !n.includes(dbNorm(st.name))) continue;   // 대기업 브랜드는 지점명까지 같을 때만 인정
    const s = dist <= 80 ? ((f & 1) ? 'closed' : 'member') : ((f & 1) ? null : 'likely');
    const rank = { member: 3, likely: 2, closed: 1 };
    if (s && (!best || rank[s] > rank[best])) best = s;
  }
  if (best) return best;
  if (!KC.index.complete) return 'unknown';   // 일부 자료뿐이면 "없음"이라고 하지 않음
  return near30 ? 'building' : 'none';
}
// 상품권별 상태: 각 상품권 자료 + 조폐공사 지역사랑상품권 자료(온누리 제외)를 합침
const RANK = { member: 6, likely: 5, building: 4, paper: 3, closed: 2, none: 1, unknown: 0 };
function baseStatus(id, st) {
  const a = MERCH_SETS[id] ? merchStatus(id, st) : 'unknown';
  if (id === 'onnuri') return a;
  const k = kcStatus(st);
  if (k === 'closed' && a !== 'member') return 'closed';
  return (RANK[k] || 0) > (RANK[a] || 0) ? k : a;
}
const statusBasis = (id) => {
  const a = merchBasis(id), k = KC.index && KC.index.basis ? KC.index.basis.replace(/-/g, '.') : '';
  return id === 'onnuri' ? a : (a && k ? `${a}·${k}` : (a || k));
};
async function ensureMerchants(stores) {
  if (!stores || !stores.length) return;
  let changed = await ensureKC(stores).catch(() => false);
  await Promise.all(Object.keys(MERCH_SETS).map(async id => {
    const M = MERCH[id], def = MERCH_SETS[id];
    if (def.region && !stores.some(st => regionShort(st.address || st.jibun) === def.region)) return;
    if (M.index === undefined) {
      M.index = null;
      try { M.index = await loadJSON(def.base + '/index.json'); changed = true; } catch (e) {}
    }
    if (!M.index) return;
    const need = new Set(stores.map(st => merchGu(id, st.address) || merchGu(id, st.jibun)).filter(g => g && !M.gu[g] && !M.loading[g] && !M.failed[g]));
    await Promise.all([...need].map(async g => {
      M.loading[g] = true;
      try { M.gu[g] = await loadJSON(def.base + '/' + M.index.gus[g].file); changed = true; } catch (e) { M.failed[g] = true; }
      M.loading[g] = false;
    }));
  }));
  if (changed) renderAll();
}
const ensureDongbaek = ensureMerchants;
// 결과: member(이름까지 일치) / likely(그 주소의 가맹점이 1곳) / building(같은 건물에 가맹점 여러 곳) / none(목록에 없음) / unknown(자료 없음)
// ---- 온누리: 시·도 + 가게 이름으로 찾고, 소속 시장이 매장 근처(700m)에 있는지 카카오로 확인 ----
const MKT_NEAR = {};      // "시장명|위도,경도" → true/false/'loading'
let mktCalls = 0;
function marketNear(mkt, st) {
  const k = `${mkt}|${st.lat.toFixed(3)},${st.lng.toFixed(3)}`;
  if (k in MKT_NEAR) return MKT_NEAR[k];
  if (!kakaoOn() || mktCalls >= 40) return undefined;   // 한 번 실행에 최대 40회
  MKT_NEAR[k] = 'loading'; mktCalls++;
  const q = mkt.replace(/\(.*?\)/g, ' ').replace(/상인회|상점가|골목형|상권활성화|구역/g, ' ').replace(/\s+/g, ' ').trim() || mkt;
  kakaoApi('search/keyword', { query: q, x: st.lng, y: st.lat, radius: 700, size: 5 }, makeBudget(1))
    .then(r => { MKT_NEAR[k] = (r.documents || []).length > 0; })
    .catch(() => { MKT_NEAR[k] = undefined; delete MKT_NEAR[k]; })
    .finally(() => { clearTimeout(marketNear.t); marketNear.t = setTimeout(renderAll, 150); });
  return 'loading';
}
function nameStatus(M, gu, st) {
  const g = M.gu[gu]; if (!g || !g.n) return 'unknown';
  const full = dbNorm(st.name); if (full.length < 2) return 'unknown';
  let cand = g.n[full], exact = !!cand;
  DB_ALIAS.forEach(([en, ko]) => { if (!cand && full.includes(en) && g.n[full.replace(en, ko)]) { cand = g.n[full.replace(en, ko)]; exact = true; } });
  // "가게명 지점명" → "가게명": 동네 가게만 (프랜차이즈는 지점마다 가맹 여부가 달라 전체 이름이 같아야 인정)
  if (!cand && !matchBrand(st.name)) {
    const toks = String(st.name).trim().split(/\s+/);
    const base = toks.length > 1 && /점$/.test(toks[toks.length - 1]) ? dbNorm(toks.slice(0, -1).join('')) : '';   // 마지막 말이 "○○점"일 때만
    if (base.length >= 2 && g.n[base]) cand = g.n[base];
  }
  if (!cand) return 'none';
  const digital = cand.filter(v => v >= 0);
  const use = digital.length ? digital : cand.map(v => -v - 1);
  const near = use.map(i => marketNear(g.m[i], st));
  st._onnuriMkt = g.m[use[near.indexOf(true)] ?? use[0]];
  if (near.includes(true)) return digital.length ? 'member' : 'paper';
  if (near.length && near.every(x => x === false)) return 'building';   // 같은 이름이지만 그 시장이 근처에 없음 → 다른 가게일 수 있음
  if (!exact && use.length > 1) return 'building';                        // 지점명을 뺀 이름이 여러 시장에 있음 → 확인 필요
  return digital.length ? 'likely' : 'paper';
}
function merchStatus(id, st) {
  const M = MERCH[id]; if (!M || !M.index) return 'unknown';
  if (M.index.type === 'name') { const gu = merchGu(id, st.address) || merchGu(id, st.jibun); return gu ? nameStatus(M, gu, st) : 'unknown'; }
  const gu = merchGu(id, st.address) || merchGu(id, st.jibun);
  if (!gu) return 'unknown';
  const m = M.gu[gu]; if (!m) return 'unknown';
  const keys = [...dbAddrKeys(st.address), ...dbAddrKeys(st.jibun)];
  if (!keys.length) return 'unknown';
  const names = [...new Set(keys.flatMap(k => m[k] || []))];
  if (names.some(n => nameLike(st.name, n))) return 'member';
  // 번지 없이 길·동 이름만 등록된 가맹점: 가게 이름 전체가 같을 때만 인정
  const full = dbNorm(st.name);
  const road = String(st.address || '').match(/\s([가-힣A-Za-z0-9.]+(?:로|길))\s+\d/);
  const dong = String(st.jibun || '').match(/\s([가-힣0-9]+(?:동|가|리))\s+(?:산\s*)?\d/);
  const loose = [road && m['S:' + road[1]], dong && m['D:' + dong[1].replace(/\d+동$/, '동')]].filter(Boolean).flat();
  if (full.length >= 2 && loose.some(n => n === full || (n.length >= 3 && (n.includes(full) || full.includes(n))))) return 'member';
  if (!names.length) return 'none';
  return names.length === 1 ? 'likely' : 'building';
}
const dongbaekStatus = (st) => merchStatus('dongbaek', st);
const merchBasis = (id) => { const ix = MERCH[id] && MERCH[id].index; return ix && ix.basis ? ix.basis.replace(/-/g, '.') : ''; };
const dbBasis = () => merchBasis('dongbaek');
// 내가 이 매장에서 써 본 결과 (있으면 공공데이터보다 우선)
const myCheck = (st, id) => ((S.verified[st.id] || {})[id]) || null;
// 사용 가능 여부: mine_ok / mine_no / member / likely / building / none / unknown
function payStatus(id, st) {
  const v = myCheck(st, id); if (v) return v.ok ? 'mine_ok' : 'mine_no';
  return baseStatus(id, st);
}
const payOk = (d) => d === 'mine_ok' || d === 'member';
const lcLabel = (id) => MERCH_SETS[id] ? MERCH_SETS[id].label : ((localList().find(l => l.id === id) || {}).name || id).replace(/\s*\(.*\)$/, '');
// 지금 목록에서 가맹점 자료로 확인할 수 있는 종류들 (자료가 있고 매장이 그 지역에 있을 때)
function merchAvailable() {
  const ids = Object.keys(MERCH_SETS).filter(id => MERCH[id].index && S.stores.some(st => merchGu(id, st.address) || merchGu(id, st.jibun)));
  // 조폐공사 자료로 가맹점이 확인된 매장이 있으면 그 지역 지역화폐도 표시·필터 대상
  if (KC.index) S.stores.forEach(st => { if (kcStatus(st) === 'member') payCandidates(st).forEach(lc => { if (lc.id !== 'onnuri' && !ids.includes(lc.id)) ids.push(lc.id); }); });
  // 자료가 없어도 내가 '됐어요'로 확인한 매장이 목록에 있으면 그 상품권도 표시·필터 대상
  S.stores.forEach(st => Object.entries(S.verified[st.id] || {}).forEach(([id, v]) => { if (v.ok && !ids.includes(id)) ids.push(id); }));
  return ids;
}

// 지역화폐·온누리: 매장이 가맹점인지 알 수 없으므로 '가맹점일 때' 조건부로 계산
function localRate(lc) {
  const set = S.locals[lc.id] || {};
  if (set.rate > 0) return { rate: set.rate, user: true };
  if (lc.rate > 0 && !isExpired(lc)) return { rate: lc.rate, user: false };
  return null;
}
function localDiscount(lc, st, amount) {
  const set = S.locals[lc.id]; if (!set || !set.on) return null;
  const rr = localRate(lc); if (!rr) return { disc: 0, needRate: true };
  let keys = regionKeysOf(st.address); if (!keys.length) keys = regionKeysOf(st.jibun); if (!keys.length) keys = currentRegionKeys();
  if (!lcHere(lc, keys)) return { disc: 0, outOfRegion: !!keys.length, unknownRegion: !keys.length };
  const mine = myCheck(st, lc.id);
  if (DIRECT_ONLY.has(st.brand) && !(mine && mine.ok) && lc.id !== 'onnuri') return { disc: 0, notMerchant: true, direct: true };
  const db = mine ? (mine.ok ? 'member' : 'none') : baseStatus(lc.id, st);
  // 가맹점 공공데이터에 이름까지 있으면 그 자료를 따름 (예: 가맹점으로 등록된 다이소 매장)
  if (db !== 'member' && ((lc.excludeCats || []).includes(st.category) || (lc.excludeBrands || []).includes(st.brand))) return { disc: 0, notMerchant: true };
  if (mine && !mine.ok) return { disc: 0, rate: rr.rate, mineNo: true };
  if (db === 'paper') return { disc: 0, rate: rr.rate, paperOnly: true };
  if (db === 'closed') return { disc: 0, rate: rr.rate, closed: true };
  if (db === 'none') return { disc: 0, rate: rr.rate, notInList: true };
  let d = Math.floor(amount * rr.rate / 100);
  if (lc.cap > 0) d = Math.min(d, Math.max(0, lc.cap - monthStats(lc.id).disc));
  const confirmed = db === 'member' || !!(mine && mine.ok);
  // 공식 목록에 이름까지 맞거나 내가 써 본 매장만 확정 계산. 주소만 같거나 확인 전이면 참고값으로만 보여 줌
  if (!confirmed) return { disc: 0, potential: d, rate: rr.rate, userRate: rr.user, conditional: true, db };
  return { disc: d, rate: rr.rate, userRate: rr.user, conditional: false, db, mine: !!(mine && mine.ok) };
}
const localList = () => (DATA.localCurrencies || []);
// 할인율이 없거나 수시로 바뀌는 지역화폐: 메모 첫 문장을 짧게 보여 줌
const lcShortNote = (lc) => { const n = String(lc.note || '').split(' · ')[0]; return n ? (n.length > 46 ? n.slice(0, 45) + '…' : n) : '할인율은 내 지갑에서 입력'; };

// v38: 통신사 멤버십 — 등급·할인형/적립형·1,000원 단위·하루 1회를 계산에 반영
// 자료: brands[브랜드] = { unit:'per1000'(1,000원당 원) | 'pct'(%), tiers:{등급:값|null}, daily:1, accrual:true }
const CAR_TIERS = { SKT: ['VIP', 'GOLD', 'SILVER'], KT: ['VVIP', 'VIP', 'GOLD', 'SILVER', 'WHITE', '일반'], LGU: ['VVIP', 'VIP', '우수'] };
const sameDay = (ts) => { const a = new Date(ts), b = new Date(); return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); };
function carrierUsedToday(code, brand) { return S.ledger.some(e => e.brand === brand && sameDay(e.ts) && (e.carrierUsed === code || (!e.carrierUsed && e.carrierDisc > 0))); }
function carrierBenefit(code, c, b, st, base) {
  const out = { code, name: c.name, desc: b.desc, disc: 0, accrue: 0, tier: '', note: '' };
  const tier = (S.ctier || {})[code] || '';
  const unit = b.unit || 'pct';
  let v;
  if (b.tiers) {
    if (tier) { v = b.tiers[tier]; out.tier = `${tier} 등급`; if (v == null) { out.note = `${tier} 등급 혜택은 아직 확인 못 했어요`; return out; } }
    else { const vals = (CAR_TIERS[code] || Object.keys(b.tiers)).map(t => b.tiers[t]); if (vals.some(x => x == null)) { out.note = '내 등급을 고르면 계산돼요 (등급마다 달라요)'; out.needTier = true; return out; } v = Math.min(...vals); out.tier = '등급 모름 · 가장 낮은 등급 기준'; out.needTier = true; }
  } else { v = unit === 'per1000' ? b.rate * 10 : b.rate; out.tier = c.tierNote || ''; }
  out.unit = unit; out.val = v;
  const d = unit === 'per1000' ? Math.floor(Math.max(0, base) / 1000) * v : Math.floor(Math.max(0, base) * v / 100);
  out.calcTxt = unit === 'per1000' ? `${won(Math.floor(Math.max(0, base) / 1000) * 1000)} × 1,000원당 ${v}원${base % 1000 ? ' (1,000원 미만 제외)' : ''}` : `${won(Math.max(0, base))} × ${v}%`;
  if (b.daily && carrierUsedToday(code, st.brand)) { out.note = '오늘 이미 썼어요 (하루 1회)'; out.usedToday = true; return out; }
  if (code === 'SKT' && (S.cmode || {}).SKT === 'accrual') {
    if (b.accrual) { out.accrue = d; out.note = `적립형: ${d.toLocaleString()}P 적립 (현장 할인 아님)`; }
    else out.note = '적립형 회원은 이 매장 혜택 방식을 T멤버십 앱에서 확인하세요';
    return out;
  }
  out.disc = d; return out;
}
function calc(st, amount, opt = {}) {
  const now = new Date();
  let car = null;
  const excl = Math.min(amount, Math.max(0, opt.excl !== undefined ? opt.excl : 0));
  for (const code of S.carriers) {
    const c = DATA.carriers && DATA.carriers[code];
    if (!c || isExpired(c)) continue;
    const b = c.brands && c.brands[st.brand];
    if (b) {
      const x = carrierBenefit(code, c, b, st, amount - excl);
      x.excl = excl;
      const sc = (y) => y.disc * 10 + (y.accrue || 0);
      if (!car || sc(x) > sc(car)) car = x;
    }
  }
  const carrierNotes = S.carriers.map(code => {
    const c = DATA.carriers && DATA.carriers[code];
    return c && c.notes && c.notes[st.brand] ? `${c.name}: ${c.notes[st.brand]}` : null;
  }).filter(Boolean);
  const after = amount - (car ? car.disc : 0);
  const per = ownedCards().map(card => ({ m: { id: card.id, name: card.name, kind: 'card', card }, ...cardDiscount(card, st, after, now) }));
  if (!opt.cardsOnly) localList().forEach(lc => {
    if (opt.confirmedLocal && !payOk(payStatus(lc.id, st))) return;
    const r = localDiscount(lc, st, after);
    if (r) per.push({ m: { id: lc.id, name: lc.name, kind: 'local', lc }, ...r });
  });
  const usable = per.filter(x => !x.expired && !x.excluded);
  usable.sort((a, b) => b.disc - a.disc);
  const isCash = (x) => x.m.kind === 'local' || isCashCard(x.m.card);
  // 현금성 혜택(할인·캐시백) 중 가장 큰 것 하나 + 통신사 현장할인. 포인트 적립은 따로
  const cashList = usable.filter(isCash);
  const best = cashList[0] && cashList[0].disc > 0 ? cashList[0] : null;
  const ptList = usable.filter(x => !isCash(x) && x.disc > 0);
  const pt = ptList[0] || null;
  const total = Math.min(amount, (car ? car.disc : 0) + (best ? best.disc : 0));
  // 조건을 확인하면 더 받을 수 있는 혜택 (가맹점 확인 필요·간편결제·옵션)
  const hints = [];
  usable.forEach(x => {
    if (x.m.kind === 'local' && x.potential > (best ? best.disc : 0)) hints.push({ kind: 'local', x, disc: x.potential });
    if (x.cond && x.cond.disc > (best ? best.disc : 0) && isCash(x)) hints.push({ kind: 'cond', x, disc: x.cond.disc });
  });
  hints.sort((a, b) => b.disc - a.disc);
  // 모든 가맹점 1~2% 같은 기본 혜택만 있으면 '진짜 할인'과 구분해 작게 보여 줌
  const basic = !!(best && best.rule && best.rule.all && !best.rule.amount && (best.rule.rate || 0) <= 2 && !car);
  return {
    car, carrierNotes, best, pt, hints, per, total, final: amount - total, pay: amount - (car ? car.disc : 0), basic,
    rate: amount > 0 ? Math.round(total / amount * 1000) / 10 : 0,
    excluded: per.find(x => x.excluded) ? per.find(x => x.excluded).excluded : '',
    expiredCount: per.filter(x => x.expired).length
  };
}
const methodLabel = (x) => {
  if (x.m.kind === 'local') return x.needRate ? '할인율을 입력해야 계산돼요' : x.outOfRegion ? '이 지역에서는 못 써요' : x.unknownRegion ? '매장 지역을 몰라 계산 못 했어요' : x.notMerchant ? '이 매장은 보통 가맹점이 아니에요' : x.mineNo ? '내가 안 된다고 표시한 매장' : x.paperOnly ? '종이 온누리상품권만 받는 매장' : x.closed ? '폐업·해지 신고된 가맹점' : x.notInList ? `${esc(MERCH_SETS[x.m.id] ? MERCH_SETS[x.m.id].label : '')} 가맹점 목록에 없어요${merchBasis(x.m.id) ? ` (${merchBasis(x.m.id)} 기준)` : ''}` : x.potential !== undefined ? `${pct(x.rate)} · ${x.db === 'likely' ? '근처 가맹점 목록에 비슷한 이름이 있지만 이 매장인지 확인 필요' : x.db === 'building' ? '같은 건물에 가맹점 있음 · 확인 필요' : '가맹점 정보 미확인'} · 확인되면 -${won(x.potential)} (계산에는 안 넣음)`
    : `${pct(x.rate)}${x.userRate ? ' (내가 입력)' : ''} · ${x.mine ? '✓ 내가 써 본 매장' : '✓ 공식 가맹점 목록 확인'}`;
  if (x.expired) return '확인 기한 지남 · 계산 제외';
  if (x.excluded) return '이 매장 결제 불가';
  if (x.capReached) return '이번 달 할인 한도를 다 썼어요';
  if (x.prevFail) return `지난달 실적(${won(x.m.card.prevMin)}) 못 채움으로 표시 · 이번 달 할인 없음`;
  const kindT = x.m.card && !isCashCard(x.m.card) ? ' · 적립(현금 절약에 안 더함)' : '';
  const condT = x.cond ? ` · ${x.cond.need.map(condText).join('·')}하면 -${won(x.cond.disc)}` : '';
  return (x.rule ? ruleLabel(x.rule) + (x.rule.via ? ` (${x.rule.via})` : '') + (x.rule.note ? ' · ' + x.rule.note : '') + kindT : '조건 확인된 할인 없음') + condT
    + (x.rule && x.m.card && x.m.card.prevMin ? (prevState(x.m.card) ? ' · ✓ 전월실적 충족' : ` · 지난달 이 카드로 ${won(x.m.card.prevMin)} 이상 썼을 때 (확인 전)`) : '');
};

// =====================================================================
// 6. 매장 검색 — 카카오 (영역 분할로 전부 수집)
// =====================================================================
class KakaoError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function makeBudget(n) { return { left: n, used: 0, truncated: false }; }
// ---- 서버(Cloudflare Worker) 프록시: 있으면 카카오 키를 화면 코드에 두지 않고 서버가 대신 호출 ----
// 서버에 /api/health 가 {ok:true,kakao:true} 로 답하면 그 서버를 쓰고, 없으면 예전처럼 직접 호출
let PROXY = null, PROXY_PENDING = true;
let SERVER = null, KC_API = null;   // 여긴할인 서버 주소(통계·제보) / 조폐공사 가맹점 실시간 조회가 켜진 서버
const apiBase = () => CONFIG.apiBase ? CONFIG.apiBase.replace(/\/$/, '') : null;
let PROXY_READY = null, PROXY_RETRY = null;
const probeProxy = async (wait) => {
  try {
    const base = apiBase(); if (base === null) return null;
    const r = await fetchT(`${base}/api/health`, { cache: 'no-store' }, wait || (CONFIG.kakaoRestKey ? 2500 : 4000));
    if (!r.ok || !/json/.test(r.headers.get('content-type') || '')) return null;
    const j = await r.json();
    if (j && j.ok) { SERVER = base; if (j.kakao) PROXY = base; if (j.kclive) KC_API = base; }   // kclive: 서버에서 가맹점 실시간 조회가 되는 경우만 (공공데이터포털 방화벽이 클라우드 서버를 막아 기본은 꺼 둠)
  } catch (e) {}
  finally { PROXY_PENDING = false; }
  return PROXY;
};
let PROXY_DEAD = false;   // 서버에 두 번 연결해 봐도 안 될 때만 true → 그때는 오픈스트리트맵으로
const kakaoOn = () => !!(CONFIG.kakaoRestKey || PROXY !== null || PROXY_PENDING || (apiBase() && !PROXY_DEAD));
// 익명 사용 통계: 기기·위치·개인 정보 없이 '무엇을 눌렀는지'만 센다. 서버가 있을 때만, 끄기 가능
function track(ev, val) {
  try {
    if (SERVER === null || !store.get('hs_statsOk', false)) return;   // v38: 동의한 사람만(기본 꺼짐)
    const body = JSON.stringify({ e: String(ev).slice(0, 24), v: val === undefined ? '' : String(val).slice(0, 24), a: NATIVE && NATIVE.on ? 'app' : 'web' });
    const url = `${SERVER}/api/event`;
    if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
    else fetch(url, { method: 'POST', body, keepalive: true }).catch(() => {});
  } catch (e) {}
}
async function kakaoApi(path, params, budget) {
  if (PROXY_PENDING && PROXY_READY) await PROXY_READY;
  if (!CONFIG.kakaoRestKey && PROXY === null && apiBase() && !PROXY_DEAD) {
    // 처음 확인 때 인터넷이 느려서 서버를 못 찾았으면 한 번 더 (최대 6초)
    if (!PROXY_RETRY) PROXY_RETRY = probeProxy(6000);
    await PROXY_RETRY;
    if (PROXY === null) PROXY_DEAD = true;
  }
  if (!CONFIG.kakaoRestKey && PROXY === null) throw new KakaoError(0, 'no-key');
  if (budget.left <= 0) { budget.truncated = true; throw new KakaoError(-1, 'budget'); }
  budget.left--; budget.used++;
  const qs = new URLSearchParams(params).toString();
  // 일시적인 실패(연결 끊김·429 사용량 몰림·5xx)는 0.4초→1.2초 간격으로 2번 더 시도. 키 오류(401·403)는 바로 실패
  for (let i = 0; ; i++) {
    let r = null, err = null;
    try {
      r = PROXY !== null ? await fetchT(`${PROXY}/api/local/${path}?${qs}`, {}, 6000)
        : await fetchT(`https://dapi.kakao.com/v2/local/${path}.json?${qs}`, { headers: { Authorization: `KakaoAK ${CONFIG.kakaoRestKey}` } }, 6000);
    }
    catch (e) { err = new KakaoError(0, 'network'); }
    if (r && r.ok) return r.json();
    if (!err) err = new KakaoError(r.status, 'http');
    const retry = err.status === 0 || err.status === 429 || err.status >= 500;
    if (!retry || i >= 2) throw err;
    await new Promise(res => setTimeout(res, 400 * Math.pow(3, i) + Math.random() * 200));
  }
}
// 동시에 너무 많이 부르지 않게
function limiter(n) {
  let active = 0; const q = [];
  const next = () => { if (active >= n || !q.length) return; active++; const { fn, res, rej } = q.shift(); fn().then(res, rej).finally(() => { active--; next(); }); };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}
const limit = limiter(6);

function bbox(lat, lng, r) {
  const dLat = r / 111320, dLng = r / (111320 * Math.cos(lat * Math.PI / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}
function docToStore(doc, center, forced) {
  if (NOT_STORE.test(doc.category_name || '')) return null;
  const meta = matchBrand(doc.place_name, doc.category_name) || forced;
  if (!meta) return null;
  const lat = parseFloat(doc.y), lng = parseFloat(doc.x);
  return {
    id: 'k' + doc.id, name: doc.place_name, brand: meta.brand, category: meta.category,
    address: doc.road_address_name || doc.address_name || '', jibun: doc.address_name || '', lat, lng,
    distance: center ? haversine(center.lat, center.lng, lat, lng) : (doc.distance ? +doc.distance : 0),
    url: doc.place_url || '', phone: doc.phone || ''
  };
}
// 사용자가 이름으로 콕 집어 찾은 가게: 업종 목록에 없더라도 매장으로 보여 줌 (지하철역·주차장·은행·학교 등은 제외)
const NON_SHOP_CODES = new Set(['SW8', 'PK6', 'BK9', 'PO3', 'SC4', 'AG2', 'AT4', 'AD5', 'PS3']);
function storeFromDoc(doc, center) {
  if (!doc || NON_SHOP_CODES.has(doc.category_group_code)) return null;
  const code = doc.category_group_code, cn = doc.category_name || '';
  if (!code && /^(교통|지역|행정|금융)/.test(cn)) return null;
  const cat = code === 'CS2' ? 'cvs' : code === 'CE7' ? 'cafe' : code === 'MT1' ? 'super' : code === 'OL7' ? 'fuel'
    : code === 'FD6' ? (FB_FN.dining(doc) || 'cafe') : FB_FN.beauty(doc) || 'life';
  const meta = matchBrand(doc.place_name, cn) || { brand: doc.place_name.split(' ')[0], category: cat };
  const lat = parseFloat(doc.y), lng = parseFloat(doc.x);
  return { id: 'k' + doc.id, name: doc.place_name, brand: meta.brand, category: meta.category,
    address: doc.road_address_name || doc.address_name || '', jibun: doc.address_name || '', lat, lng,
    distance: center ? haversine(center.lat, center.lng, lat, lng) : 0, url: doc.place_url || '', phone: doc.phone || '' };
}
// 업종을 정하는 규칙 (보류 작업을 저장할 수 있게 함수 대신 이름으로 넘김)
const FB_FN = {
  dining: doc => { const cn = doc.category_name || ''; if (/카페|커피/.test(cn)) return null; return /제과|베이커리|디저트|도넛|떡/.test(cn) ? 'bakery' : 'dining'; },
  beauty: doc => /미용|헤어|네일|뷰티|피부|왁싱|속눈썹/.test(`${doc.category_name || ''} ${doc.place_name}`) ? 'beauty' : null,
  life: doc => { const cn = doc.category_name || ''; if (/^음식점/.test(cn)) return FB_FN.dining(doc); if (/카페|커피/.test(cn)) return null; return 'life'; }
};
const fbResolve = (fb, doc) => typeof fb === 'string' && fb.startsWith('fn:') ? FB_FN[fb.slice(3)](doc) : fb;
// 다시 시도해도 되는 오류(호출 한도·연결 끊김·사용량 몰림)인지
const softErr = e => e && (e.status === -1 || e.status === 0 || e.status === 429 || e.status >= 500);
// 카테고리 검색: 결과가 45개(카카오 최대)를 넘으면 영역을 4등분해서 다시 찾는다.
// 호출 한도가 모자라거나 일부가 실패하면 그 영역을 '보류 목록'(budget.pending)에 남겨 두었다가 이어서 찾는다 → 빠지는 가게가 없게
async function kakaoCategoryAll(code, center, radius, budget, fallbackCat, query, rects) {
  const out = new Map();
  const api = query ? 'search/keyword' : 'search/category';
  if (!budget.pending) budget.pending = [];
  const hold = (rect, depth) => { budget.pending.push({ kind: 'rect', code, query: query || null, fb: fallbackCat, center: { lat: center.lat, lng: center.lng }, radius, rect, depth }); budget.truncated = true; };
  async function run(rect, depth) {
    const base = query ? { query, rect: rect.join(','), x: center.lng, y: center.lat, size: 15 } : { category_group_code: code, rect: rect.join(','), size: 15 };
    let first;
    try { first = await limit(() => kakaoApi(api, { ...base, page: 1 }, budget)); }
    catch (e) { if (depth > 0 && softErr(e) || e.status === -1) { hold(rect, depth); return; } throw e; }
    const total = first.meta ? first.meta.total_count : 0;
    if (total > 45 && depth < 9) {
      if (budget.left >= 4) {
        const [x1, y1, x2, y2] = rect, mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        await Promise.all([[x1, y1, mx, my], [mx, y1, x2, my], [x1, my, mx, y2], [mx, my, x2, y2]].map(r => run(r, depth + 1)));
        return;
      }
      hold(rect, depth);   // 이번엔 앞 15곳만 넣고, 나머지는 이어서 찾기
    } else if (total > 45) budget.capped = true;   // 아주 좁은 곳(한 건물)에 45곳 넘게 몰린 경우
    const docs = [...(first.documents || [])];
    const pages = Math.min(3, Math.ceil(Math.min(total, 45) / 15));
    if (!(total > 45 && depth < 9)) {
      let failed = false;
      const more = await Promise.all(Array.from({ length: Math.max(0, pages - 1) }, (_, i) =>
        limit(() => kakaoApi(api, { ...base, page: i + 2 }, budget)).catch(() => { failed = true; return { documents: [] }; })));
      more.forEach(m => docs.push(...(m.documents || [])));
      if (failed) hold(rect, depth);
    }
    docs.forEach(d => { if (!out.has(d.id)) out.set(d.id, d); });
  }
  await Promise.all((rects || [{ rect: bbox(center.lat, center.lng, radius), depth: 0 }]).map(r => run(r.rect, r.depth)));
  const list = [];
  out.forEach(doc => {
    const fc = fbResolve(fallbackCat, doc);
    if (!fc) return;
    const st = docToStore(doc, center, { brand: doc.place_name.split(' ')[0], category: fc });
    if (st && st.distance <= radius) list.push(st);
  });
  return list;
}
async function kakaoBrandKeyword(kw, center, radius, budget) {
  const want = matchBrand(kw);
  const out = [];
  try {
    for (let page = 1; page <= 3; page++) {
      const res = await limit(() => kakaoApi('search/keyword', { query: kw, x: center.lng, y: center.lat, radius: Math.min(radius, 20000), sort: 'distance', size: 15, page }, budget));
      (res.documents || []).forEach(doc => {
        const st = docToStore(doc, center, null);
        if (st && (!want || st.brand === want.brand) && st.distance <= radius) out.push(st);
      });
      if (!res.meta || res.meta.is_end) break;
    }
  } catch (e) {
    if (!softErr(e)) throw e;
    if (!budget.pending) budget.pending = [];
    budget.pending.push({ kind: 'kw', kw, center: { lat: center.lat, lng: center.lng }, radius }); budget.truncated = true;
  }
  return out;
}
async function loadCategoryKakao(cat, center, radius, budget) {
  if (CATEGORY_CODES[cat]) {
    const fb = cat === 'mart' ? 'super' : cat;
    const list = await kakaoCategoryAll(CATEGORY_CODES[cat], center, radius, budget, fb);
    // MT1(마트) 결과는 브랜드 기준으로 대형마트/슈퍼를 나눔
    return list;
  }
  // 반경이 동네 식당 검색 범위(1km) 안이면, 식당·빵집 프랜차이즈는 업종 검색(FD6)에 함께 잡히므로 브랜드별 검색을 생략 → 호출 수 절약
  if ((cat === 'dining' || cat === 'bakery') && radius <= EXTRA_RADIUS) return [];
  const kws = KEYWORD_GROUPS[cat] || [];
  const parts = await Promise.all(kws.map(k => kakaoBrandKeyword(k, center, radius, budget)));
  return parts.flat();
}

// 오픈스트리트맵 대체 검색 (카카오 실패 시) — 정보가 적을 수 있음
async function loadOSM(center, radius) {
  const q = `[out:json][timeout:10];(node["shop"~"convenience|supermarket|department_store|chemist|variety_store|bakery|books|cosmetics"](around:${radius},${center.lat},${center.lng});node["amenity"~"cafe|fast_food|restaurant|fuel|cinema|ice_cream"](around:${radius},${center.lat},${center.lng});way["shop"~"convenience|supermarket"](around:${radius},${center.lat},${center.lng}););out center 400;`;
  const mirrors = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  const els = await Promise.any(mirrors.map(async u => {
    const r = await fetchT(u, { method: 'POST', body: 'data=' + encodeURIComponent(q) }, 12000);
    if (!r.ok) throw new Error('osm');
    const d = await r.json(); return d.elements || [];
  }));
  const out = [];
  els.forEach(el => {
    const t = el.tags || {}; const lat = el.lat || (el.center && el.center.lat), lng = el.lon || (el.center && el.center.lon);
    if (!lat || !lng) return;
    const name = t['name:ko'] || t.name || t.brand || '';
    let meta = matchBrand(t.brand) || matchBrand(t['brand:ko']) || matchBrand(name);
    if (!meta) {
      const fb = t.shop === 'convenience' ? 'cvs' : t.amenity === 'cafe' ? 'cafe' : t.shop === 'supermarket' ? 'super' : t.amenity === 'fuel' ? 'fuel' : null;
      if (!fb || !name) return;
      meta = { brand: name.split(' ')[0], category: fb };
    }
    out.push({ id: 'o' + el.id, name: name || meta.brand, brand: meta.brand, category: meta.category, lat, lng,
      address: [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' '), distance: haversine(center.lat, center.lng, lat, lng), url: '' });
  });
  return out;
}


// 동네 식당·미용실처럼 수가 많은 업종은 해당 칩을 눌렀을 때만 카카오에서 전부 찾아옴 (호출 수 절약)
const EXTRA = {
  dining: {
    label: '동네 식당·빵집',
    run: (c, r, b) => kakaoCategoryAll('FD6', c, r, b, 'fn:dining')
  },
  bakery: { alias: 'dining' },
  beauty: {
    label: '미용실·네일',
    run: async (c, r, b) => {
      const parts = await Promise.all(['미용실', '네일샵'].map(q => kakaoCategoryAll(null, c, r, b, 'fn:beauty', q)));
      return parts.flat();
    }
  },
  life: {
    label: '약국·생활 가게',
    run: async (c, r, b) => {
      const parts = await Promise.all([
        kakaoCategoryAll('PM9', c, r, b, 'life'),
        ...LIFE_KW.map(q => kakaoCategoryAll(null, c, r, b, 'fn:life', q))
      ]);
      return parts.flat();
    }
  }
};
// 지역화폐를 많이 쓰는 생활 가게 (카카오 업종 분류가 따로 없어 이름으로 찾음)
const LIFE_KW = ['안경', '세탁', '꽃집', '정육점', '반찬', '과일', '철물', '문구'];
const EXTRA_RADIUS = 1000;
async function brandBackup(token) {
  if (!S.center || S._brandBackup === token) return; S._brandBackup = token;
  const budget = makeBudget(70);
  const kws = [...KEYWORD_GROUPS.dining, ...KEYWORD_GROUPS.bakery];
  const parts = await Promise.all(kws.map(k => kakaoBrandKeyword(k, S.center, Math.min(S.radius, EXTRA_RADIUS), budget).catch(() => [])));
  if (token !== loadToken) return;
  const ids = new Set(S.stores.map(x => x.id)); let added = 0;
  parts.flat().forEach(st => { if (!ids.has(st.id)) { S.stores.push(st); ids.add(st.id); added++; } });
  if (added) { S.stores.sort((a, b) => a.distance - b.distance); renderAll(); }
}
// 식당·빵집 칩을 직접 누르면 고른 반경 전체(최대 3km)를, 전체 보기에선 1km 안을 찾음
const extraRadius = (key) => key === 'dining' && (S.cat === 'dining' || S.cat === 'bakery') ? Math.min(S.radius, 3000) : Math.min(S.radius, EXTRA_RADIUS);
async function loadExtra(cat) {
  const def = EXTRA[cat] && EXTRA[cat].alias ? EXTRA[EXTRA[cat].alias] : EXTRA[cat];
  const key = EXTRA[cat] && EXTRA[cat].alias ? EXTRA[cat].alias : cat;
  if (!def || !S.center || !kakaoOn()) return;
  const rad = extraRadius(key);
  const ck = `${S.center.lat.toFixed(4)},${S.center.lng.toFixed(4)},${S.radius}`;
  if (S.extra.key !== ck) S.extra = { key: ck, done: {}, rad: {} };
  if (!S.extra.rad) S.extra.rad = {};
  if (S.extra.done[key] && (S.extra.rad[key] || 0) >= rad) return;
  const xk = `hs_xcache_${key}_${ck}_${rad}`;
  const xc = store.get(xk, null);
  if (xc && Date.now() - xc.t < CONFIG.cacheMinutes * 60000) {
    const ids0 = new Set(S.stores.map(x => x.id));
    xc.list.forEach(st => { if (!ids0.has(st.id)) { S.stores.push(st); ids0.add(st.id); } });
    S.stores.sort((a, b) => a.distance - b.distance); S.extra.done[key] = xc.partial ? 'partial' : true; S.extra.rad[key] = rad;
    if (xc.pending && xc.pending.length) addPending(xc.pending.map(p => ({ ...p, tag: key })));
    renderAll(); return;
  }
  S.extra.done[key] = 'loading';
  const token = loadToken;
  setStatus(`주변 ${def.label}을 모두 찾고 있어요…`, '');
  try {
    const budget = makeBudget(rad > EXTRA_RADIUS ? 320 : 200);
    const list = await def.run(S.center, rad, budget);
    if (token !== loadToken) return;
    const ids = new Set(S.stores.map(x => x.id));
    list.forEach(st => { if (!ids.has(st.id)) { S.stores.push(st); ids.add(st.id); } });
    S.stores.sort((a, b) => a.distance - b.distance);
    const pend = (budget.pending || []).map(p => ({ ...p, tag: key }));
    S.extra.done[key] = pend.length || budget.capped ? 'partial' : true; S.extra.rad[key] = rad;
    if (key === 'dining' && pend.length) brandBackup(token);   // 다 찾기 전에도 프랜차이즈는 이름으로 먼저 찾아 빠지지 않게
    try {
      Object.keys(localStorage).filter(k => k.startsWith('hs_xcache_')).forEach(k => { const v = store.get(k, null); if (!v || Date.now() - v.t > CONFIG.cacheMinutes * 60000) localStorage.removeItem(k); });
      store.set(xk, { t: Date.now(), list, partial: S.extra.done[key] === 'partial', pending: pend });
    } catch (e) {}
    if (pend.length) { addPending(pend); runPending(200, token); }   // 빠진 영역은 바로 한 번 더 확인
  } catch (e) {
    S.extra.done[key] = false;
    if (key === 'dining') brandBackup(token);
    // 3초 뒤 한 번 자동으로 다시 시도, 그래도 안 되면 목록 위에 [다시 불러오기] 버튼
    if (!S.extraRetried) { S.extraRetried = true; setTimeout(() => { if (token === loadToken) loadExtra(cat); }, 3000); }
    else S.extraFail = true;
  }
  renderAll();
}

// ---- 더블체크: 처음 검색에서 한도·오류로 못 본 영역을 이어서 찾는다 ----
function addPending(list) {
  const key = p => p.kind === 'kw' ? `kw|${p.kw}` : `r|${p.code}|${p.query}|${p.rect.map(v => v.toFixed(6)).join(',')}`;
  const have = new Set((S.pending || []).map(key));
  S.pending = [...(S.pending || []), ...list.filter(p => !have.has(key(p)))];
}
// 자동 더블체크는 한 동네에 최대 500번까지만(카카오 하루 사용량 보호), 그 뒤는 [빠진 가게 더 찾기] 버튼
const AUTO_PENDING_MAX = 500;
async function runPending(maxCalls, token, manual) {
  if (!S.pending || !S.pending.length || S.pendingRunning || !kakaoOn()) return;
  if (!manual) { const room = AUTO_PENDING_MAX - (S.autoSpent || 0); if (room < 20) { renderAll(); return; } maxCalls = Math.min(maxCalls, room); }
  S.pendingRunning = true; renderAll();
  const todo = S.pending; S.pending = [];
  const budget = makeBudget(maxCalls); budget.pending = [];
  const found = [];
  for (const p of todo) {
    if (budget.left < 4) { budget.pending.push(p); continue; }
    const before = budget.pending.length;
    try {
      const list = p.kind === 'kw' ? await kakaoBrandKeyword(p.kw, p.center, p.radius, budget)
        : await kakaoCategoryAll(p.code, p.center, p.radius, budget, p.fb, p.query, [{ rect: p.rect, depth: p.depth }]);
      found.push(...list);
    } catch (e) { budget.pending.push(p); }
    for (let i = before; i < budget.pending.length; i++) if (!budget.pending[i].tag) budget.pending[i].tag = p.tag;
  }
  S.pendingRunning = false;
  if (!manual) S.autoSpent = (S.autoSpent || 0) + budget.used;
  if (token !== loadToken) return;
  const ids = new Set(S.stores.map(x => x.id)); let added = 0;
  found.forEach(st => { if (!ids.has(st.id)) { S.stores.push(st); ids.add(st.id); added++; } });
  S.stores.sort((a, b) => a.distance - b.distance);
  const fresh = S.pending || [];   // 확인하는 동안 새로 생긴 보류(다른 업종 검색 등)도 잃지 않게
  S.pending = []; addPending(budget.pending); addPending(fresh);
  const left = new Set(S.pending.map(p => p.tag || 'main'));
  Object.keys(S.extra.done || {}).forEach(k => { if (S.extra.done[k] === 'partial' && !left.has(k)) S.extra.done[k] = true; });
  S.truncated = left.has('main');
  S.pendingAdded = (S.pendingAdded || 0) + added;
  if (added) toast(`빠졌던 가게 ${added}곳을 더 찾았어요.`);
  saveMainCache();
  renderAll();
  if (fresh.length) runPending(200, token, manual);   // 아직 한 번도 확인 안 한 영역은 이어서 바로 확인
}
const LOAD_ORDER = ['cvs', 'cafe', 'mart', 'drugstore', 'bakery', 'dining', 'culture', 'fuel'];
// 업종마다 쓸 수 있는 최대 호출 수 (한 업종이 한도를 다 써서 뒤 업종이 통째로 빠지는 일을 막음)
const CAT_CAP = { cvs: 45, cafe: 60, mart: 15, drugstore: 25, bakery: 25, dining: 60, culture: 20, fuel: 20 };
let loadToken = 0;
function saveMainCache() {
  if (!S.center || !S.mainCacheKey || S.source !== '카카오맵' || S.errorMsg || !S.stores.length) return;
  try { store.set(S.mainCacheKey, { t: Date.now(), stores: S.stores, source: S.source, truncated: S.truncated, pending: (S.pending || []).filter(p => (p.tag || 'main') === 'main') }); } catch (e) {}
}
async function loadAround(center, label) {
  const token = ++loadToken;
  S.center = { lat: center.lat, lng: center.lng, label: label || S.center && S.center.label || '' };
  store.set('hs_lastLoc', S.center);
  S.stores = []; S.loading = true; S.truncated = false; S.errorMsg = ''; S.source = ''; S.searchLabel = '';
  S.doneCats = new Set(); S.extraFail = false; S.extraRetried = false;
  S.extra = { key: '', done: {}, rad: {} };   // 목록을 새로 받으면 추가로 찾은 동네 가게도 다시 붙임 (캐시 사용)
  S.pending = []; S.pendingRunning = false; S.pendingAdded = 0; S.autoSpent = 0;
  S.selectedId = null; S.localSuggest = [];   // v38: 이전 지역 상품권 안내를 바로 지움
  renderAll();
  const cacheKey = `hs_cache_${center.lat.toFixed(3)}_${center.lng.toFixed(3)}_${S.radius}`;
  S.mainCacheKey = cacheKey;
  const cached = store.get(cacheKey, null);
  if (cached && Date.now() - cached.t < CONFIG.cacheMinutes * 60000) {
    S.stores = cached.stores; S.source = cached.source; S.truncated = cached.truncated; S.loading = false;
    if (cached.pending && cached.pending.length) addPending(cached.pending);
    renderAll(); autoRegionLocal(); openPending(); loadExtra(extraFor(S.cat));
    if (S.pending.length) runPending(150, token);
    return;
  }
  const total = makeBudget(CONFIG.maxKakaoRequests);
  const seen = new Map();
  const addAll = (list) => list.forEach(s => { if (!seen.has(s.id)) seen.set(s.id, s); });
  let kakaoOk = true; const pend = [];
  if (kakaoOn()) {
    for (const cat of LOAD_ORDER) {
      const budget = makeBudget(Math.max(0, Math.min(CAT_CAP[cat] || 20, total.left)));
      budget.pending = [];
      try {
        addAll(await loadCategoryKakao(cat, S.center, S.radius, budget));
        if (token !== loadToken) return;
        S.doneCats.add(cat);
        S.stores = Array.from(seen.values()).sort((a, b) => a.distance - b.distance);
        S.source = '카카오맵';
        renderAll();
      } catch (e) {
        if (softErr(e) && (seen.size || e.status === -1) && CATEGORY_CODES[cat]) {
          // 이 업종만 잠깐 실패(또는 한도 부족): 통째로 보류해 두었다가 다시 찾음
          budget.pending.push({ kind: 'rect', code: CATEGORY_CODES[cat], query: null, fb: cat === 'mart' ? 'super' : cat, center: { lat: S.center.lat, lng: S.center.lng }, radius: S.radius, rect: bbox(S.center.lat, S.center.lng, S.radius), depth: 0 });
        } else {
          kakaoOk = false;
          S.errorMsg = e.status === 401 || e.status === 403 ? '카카오 키 오류(' + e.status + ')' : e.status === 429 ? '카카오 사용량 초과' : '카카오 연결 실패';
          break;
        }
      }
      total.left -= budget.used;
      pend.push(...(budget.pending || []).map(p => ({ ...p, tag: 'main' })));
      if (budget.capped) total.capped = true;
    }
  } else kakaoOk = false;
  if (!kakaoOk && seen.size === 0) {
    try {
      addAll(await loadOSM(S.center, S.radius));
      S.source = '오픈스트리트맵';
    } catch (e) { S.source = ''; }
  }
  if (token !== loadToken) return;
  addPending(pend);
  S.truncated = pend.length > 0;
  S.stores = Array.from(seen.values()).sort((a, b) => a.distance - b.distance);
  S.loading = false;
  try {
    Object.keys(localStorage).filter(k => k.startsWith('hs_cache_')).forEach(k => {
      const v = store.get(k, null); if (!v || Date.now() - v.t > CONFIG.cacheMinutes * 60000) localStorage.removeItem(k);
    });
  } catch (e) {}
  saveMainCache();
  renderAll();
  autoRegionLocal();
  openPending();
  if (S.pending.length) runPending(150, token);   // 더블체크: 빠진 영역을 바로 한 번 더 찾음
  if (S.source === '카카오맵') loadExtra(extraFor(S.cat));
}
// 전체 보기에서는 동네 식당·빵집(가장 많이 찾는 업종)을 자동으로 함께 찾음
function extraFor(cat) { return EXTRA[cat] ? cat : cat === 'all' ? 'dining' : null; }

// 내 위치(또는 검색한 곳)의 시·도 판단 도우미
function topOf(fn) {
  const cnt = {};
  S.stores.slice(0, 60).forEach(st => { const r = fn(st.address || st.jibun); if (r) cnt[r] = (cnt[r] || 0) + 1; });
  const top = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : '';
}
function currentRegion() { return topOf(regionShort) || S.region1 || ''; }
function currentCity() { return topOf(cityKey) || S.city1 || ''; }
const currentRegionKeys = () => [currentRegion(), currentCity()].filter(Boolean);
// 지금 지역에 맞는 지역화폐 (시·군 전용이 있으면 '그 밖의 시·군' 묶음은 뺌)
function localsForHere() {
  const keys = currentRegionKeys(); if (!keys.length) return [];
  const list = localList().filter(lc => lcHere(lc, keys));
  const hasCity = list.some(lc => lc.regions.some(r => r.includes(' ') && keys.includes(r)));
  return list.filter(lc => !(lc.generic && hasCity));
}
// 안내 문구용 지역 이름: 특별·광역시는 "대구", 도는 "수원시"처럼 시·군
const PROVINCES = ['경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
function placeName() {
  const r = currentRegion(), c = currentCity();
  return PROVINCES.includes(r) && c ? c.replace(/^\S+ /, '') : r;
}
// 내 위치 지역의 지역화폐는 '보유'로 자동 등록하지 않고 '비교할 수 있어요'로 제안만 함
// (가지지 않은 지역화폐 할인을 내 할인처럼 계산하지 않기 위해). 사용자가 [써요]를 누르면 켬
function autoRegionLocal() {
  const keys = currentRegionKeys(); if (!keys.length) { S.localSuggest = []; return; }
  // v27까지 자동으로 켰던 것(직접 고른 적 없는 것)은 끄고 제안으로 바꿈 (한 번만)
  if (!store.get('hs_mig28', false)) {
    Object.entries(S.locals).forEach(([id, v]) => { if (v && v.auto && !v.touched) S.locals[id] = { ...v, on: false, auto: false }; });
    store.set('hs_mig28', true); saveWallet();
  }
  const before = S.localSuggest.join(',');
  // 할인율이 확인되지 않은 지역(예: 전남 순천)도 '갖고 계세요?'를 물어보고, 있으면 할인율을 직접 넣게 함
  S.localSuggest = localsForHere().filter(lc => !lc.regions.includes('*') && !(lc.rate && isExpired(lc))
    && !(S.locals[lc.id] || {}).on && !(S.locals[lc.id] || {}).touched).map(lc => lc.id).slice(0, 1);
  if (S.localSuggest.join(',') !== before) renderAll();
}
function suggestRateSheet(lc) {
  openSheet(`<h3>🪙 ${esc(lc.name)}</h3><p style="font-size:14px">이 지역은 시·군마다, 달마다 할인율이 달라 앱이 아직 모르는 곳이에요. 지역화폐 앱에서 본 <b>이번 달 할인율</b>을 넣으면 바로 계산해요.</p>
    <label class="amt-in"><span>할인율</span><input id="sugRate" type="number" inputmode="decimal" min="0" max="30" step="0.5" placeholder="예: 10"><span>%</span></label>
    <p style="font-size:13px">${esc(lcShortNote(lc))}</p>
    <div class="actions"><button class="btn ghost" type="button" data-close="1">나중에</button><button class="btn green" type="button" data-act="sugsave" data-id="${esc(lc.id)}">저장</button></div>`);
}
function answerSuggest(id, yes) {
  const lc0 = localList().find(l => l.id === id);
  if (yes && lc0 && !lc0.rate) { suggestRateSheet(lc0); return; }
  S.locals[id] = { ...(S.locals[id] || {}), on: !!yes, touched: true, auto: false };
  S.localSuggest = S.localSuggest.filter(x => x !== id);
  saveWallet(); renderAll();
  toast(yes ? `${lcLabel(id)}을(를) 켰어요. 가맹점으로 확인된 매장에서 할인을 계산해요.` : '알겠어요. [내 지갑]에서 언제든 켤 수 있어요.');
}

// 지역 이름
async function regionName(lat, lng) {
  try {
    if (kakaoOn()) {
      const r = await kakaoApi('geo/coord2regioncode', { x: lng, y: lat }, makeBudget(1));
      const h = (r.documents || []).find(d => d.region_type === 'H') || (r.documents || [])[0];
      if (h) { const full = `${h.region_1depth_name} ${h.region_2depth_name || ''}`; S.region1 = regionShort(full); S.city1 = cityKey(full); }
      if (h) return [h.region_2depth_name, h.region_3depth_name].filter(Boolean).join(' ');
    }
  } catch (e) {}
  try {
    const r = await fetchT(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16&accept-language=ko`, {}, 5000);
    const d = await r.json(); const a = d.address || {};
    S.region1 = regionShort([a.province, a.state, a.city].filter(Boolean).join(' '));
    return [a.city_district || a.borough || a.county || a.city, a.quarter || a.suburb || a.neighbourhood].filter(Boolean).join(' ') || '현재 위치';
  } catch (e) { return '현재 위치'; }
}

async function useMyLocation(silent) {
  if (!silent) setListUrl('');
  if (NATIVE.on && NATIVE.P.Geolocation) {
    const G = NATIVE.P.Geolocation;
    try {
      let perm = await G.checkPermissions();
      if (perm.location !== 'granted') {
        if (silent) return;
        perm = await G.requestPermissions({ permissions: ['location', 'coarseLocation'] });
      }
      if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
        toast('위치 권한이 꺼져 있어요. 휴대폰 설정 > 앱 > 여긴할인에서 위치를 허용하거나 동네 이름으로 검색해 주세요.'); return;
      }
      if (!silent) { S.loading = true; setStatus('현재 위치를 확인하고 있어요…', ''); }
      const pos = await G.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      S.me = { lat, lng };
      loadAround({ lat, lng }, await regionName(lat, lng));
    } catch (e) {
      S.loading = false;
      if (!silent) toast('위치를 확인하지 못했어요. 위치(GPS)가 켜져 있는지 확인하거나 동네 이름으로 검색해 주세요.');
      renderAll();
    }
    return;
  }
  if (!navigator.geolocation) { if (!silent) toast('이 기기에서는 위치를 쓸 수 없어요. 동네 이름으로 검색해 주세요.'); return; }
  if (!silent) { S.loading = true; setStatus('현재 위치를 확인하고 있어요…', ''); }
  navigator.geolocation.getCurrentPosition(async pos => {
    const lat = pos.coords.latitude, lng = pos.coords.longitude;
    S.me = { lat, lng };
    const label = await regionName(lat, lng);
    loadAround({ lat, lng }, label);
  }, err => {
    S.loading = false;
    if (!silent) toast(err.code === 1 ? '위치 권한이 꺼져 있어요. 동네·역 이름으로 검색해 주세요.' : '위치를 확인하지 못했어요. 동네·역 이름으로 검색해 주세요.');
    renderAll();
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
}

// v38: 글꼴에 따라 네모(☒)로 깨지던 기호 대신 그림 아이콘
const IX = '<svg class="ic" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const ICHK = '<svg class="ic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const IPEN = '<svg class="ic" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>';
// 추천 지역 칩 좌표 (역·거리 중심점, 주변 매장 찾기용)
const AREAS = { '강남역': [37.4979, 127.0276], '홍대입구역': [37.5571, 126.9245], '서면역': [35.1579, 129.0597], '동성로': [35.8693, 128.5957], '둔산동': [36.3512, 127.3787] };
// 통합 검색: '서면역' 같은 지역 → 그 주변 매장 / 'GS25 사상점' 같은 매장 이름 → 해당 매장들
async function searchQuery(q) {
  q = q.trim(); if (!q) return;
  track('search');
  const back = S.tab === 'map' ? 'map' : 'list';   // 지도에서 검색하면 지도에 그대로 머물고 결과로 이동
  const goTab = () => { setTab(back); if (back === 'map') { MAP.lastCenter = null; MAP.fitNext = true; } };
  $('#q').blur();
  const ref = S.center || S.me || { lat: 37.5665, lng: 126.9780 };
  if (kakaoOn()) {
    try {
      const budget = makeBudget(6);
      const brand = matchBrand(q);
      const sort = brand ? 'distance' : 'accuracy';
      const res = await kakaoApi('search/keyword', { query: q, x: ref.lng, y: ref.lat, size: 15, page: 1, sort }, budget);
      const docs = res.documents || [];
      if (docs.length && brand) {
        // 매장(브랜드) 검색 결과를 그대로 보여 줌 (최대 45곳)
        const all = [...docs];
        for (let p = 2; p <= 3 && res.meta && !res.meta.is_end; p++) {
          const more = await kakaoApi('search/keyword', { query: q, x: ref.lng, y: ref.lat, size: 15, page: p, sort }, budget).catch(() => null);
          if (!more) break; all.push(...(more.documents || [])); if (more.meta && more.meta.is_end) break;
        }
        const base = S.center || { lat: parseFloat(all[0].y), lng: parseFloat(all[0].x) };
        const list = all.map(d => docToStore(d, base, null)).filter(Boolean).sort((a, b) => a.distance - b.distance);
        if (list.length) {
          loadToken++;
          if (!S.center) S.center = { ...base, label: q };
          S.stores = list; S.loading = false; S.source = '카카오맵'; S.truncated = false; S.errorMsg = ''; S.pending = [];
          S.searchLabel = q; S.cat = 'all'; setListUrl(q);
          goTab(); renderAll();
          return;
        }
      }
      // 이름이 정확히 같은 곳(역·동 이름 등)만 바로 이동. 넓은 지역명은 후보를 보여 주고 고르게 함
      const nq = q.replace(/\s/g, '');
      const exact = docs.find(d => d.place_name.replace(/\s/g, '') === nq) || docs.find(d => d.category_group_code === 'SW8' && d.place_name.replace(/\s/g, '').startsWith(nq.replace(/역$/, '') + '역'));
      if (exact) { goTab(); if (storeFromDoc(exact)) S.pendingOpen = { id: 'k' + exact.id, name: exact.place_name, lat: parseFloat(exact.y), lng: parseFloat(exact.x), doc: exact }; loadAround({ lat: parseFloat(exact.y), lng: parseFloat(exact.x) }, exact.place_name); setListUrl(q); return; }
      const ad = await kakaoApi('search/address', { query: q }, budget).catch(() => ({ documents: [] }));
      const cands = [];
      (ad.documents || []).slice(0, 3).forEach(a => cands.push({ name: a.address_name, sub: '동네·주소', x: a.x, y: a.y }));
      docs.slice(0, 6).forEach(d => cands.push({ name: d.place_name, sub: `${String(d.category_name || '').split(' > ').pop()} · ${d.road_address_name || d.address_name || ''}`, x: d.x, y: d.y, doc: d }));
      if (cands.length === 1) { goTab(); if (cands[0].doc && storeFromDoc(cands[0].doc)) S.pendingOpen = { id: 'k' + cands[0].doc.id, name: cands[0].name, lat: +cands[0].y, lng: +cands[0].x, doc: cands[0].doc }; loadAround({ lat: parseFloat(cands[0].y), lng: parseFloat(cands[0].x) }, cands[0].name); setListUrl(q); return; }
      if (cands.length) { S._pickBack = back; S._pickCands = cands; placePickSheet(q, cands); return; }
      toast(`'${q}'을(를) 찾지 못했어요.`); return;
    } catch (e) { /* 아래 대체 검색 */ }
  }
  try {
    const r = await fetchT(`https://nominatim.openstreetmap.org/search?format=json&countrycodes=kr&limit=1&accept-language=ko&q=${encodeURIComponent(q)}`, {}, 6000);
    const d = await r.json();
    if (d[0]) { goTab(); loadAround({ lat: +d[0].lat, lng: +d[0].lon }, q); setListUrl(q); return; }
  } catch (e) {}
  toast(`'${q}'을(를) 찾지 못했어요.`);
}

function placePickSheet(q, cands) {
  openSheet(`<h3>'${esc(q)}' 어디 근처를 볼까요?</h3><p style="font-size:13px">넓은 지역 이름이라 한 곳을 골라 주세요. 그 주변 매장을 찾아요.</p>
    <div class="rows">${cands.map((c, i) => `<button class="rowi" type="button" data-pick="${esc(c.y)},${esc(c.x)}" data-pickname="${esc(c.name)}" data-pickidx="${i}"><div class="bd"><div class="t">${esc(c.name)}</div><div class="d">${esc(c.sub)}</div></div><div class="r">›</div></button>`).join('')}</div>
    <div class="actions"><button class="btn ghost" type="button" data-close="1">닫기</button></div>`);
}

// =====================================================================
// 7. 화면
// =====================================================================
function badge(st, size = '') {
  const c = catOf(st.category);
  const b = String(st.brand || st.name || '');
  const latin = /^[A-Za-z0-9&\-]+/.exec(b);
  const t = latin && latin[0].length <= 5 ? latin[0] : b.replace(/\s/g, '').slice(0, 2);
  const logo = LOGOS[st.brand];
  return `<span class="badge ${size}" style="background:${c.color}" aria-hidden="true">${esc(t)}${logo ? `<img src="${esc(logo)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;
}
function setStatus(text, kind) {
  $('#statusText').textContent = text;
  $('#statusDot').className = 'dot ' + (kind || '');
}
function visibleStores() {
  let list = S.cat === 'all' ? S.stores : S.stores.filter(s => s.category === S.cat);
  if (dbFilterAvailable()) list = list.filter(s => { const d = payStatus(S.dbOnly, s); return payOk(d) || d === 'likely'; });
  return list;
}
// 아직 안 가진 결제수단으로 받을 수 있는 혜택 (목록의 '할인 없음' 대신 보여 줌)
// ① 이 지역 지역화폐가 공식 가맹점 목록에서 확인된 매장 → '동백전 있으면 -1,000원'  ② 통신사를 안 고른 사람 → 'SKT 멤버십이면 -1,000원'
function wouldGet(st, amt = 10000) {
  const out = [];
  let keys = regionKeysOf(st.address); if (!keys.length) keys = currentRegionKeys();
  localList().forEach(lc => {
    if ((S.locals[lc.id] || {}).on || !lc.rate || isExpired(lc) || lc.regions.includes('*') || !lcHere(lc, keys)) return;
    if (payOk(baseStatus(lc.id, st))) out.push({ label: `${lcLabel(lc.id)} 있으면`, disc: Math.floor(amt * lc.rate / 100) });
  });
  if (!S.carriers.length) {
    // 같은 금액을 주는 통신사는 함께 보여 줌 (예: 'SKT·KT 멤버십이면')
    const cs = Object.entries(DATA.carriers || {}).map(([code, c]) => { const b = c.brands && c.brands[st.brand]; return b && !isExpired(c) ? { n: code === 'LGU' ? 'LG U+' : code, disc: Math.floor(amt * b.rate / 100) } : null; }).filter(Boolean);
    const top = Math.max(0, ...cs.map(x => x.disc));
    if (top > 0) out.push({ label: `${cs.filter(x => x.disc === top).map(x => x.n).join('·')} 멤버십이면`, disc: top });
  }
  return out.sort((a, b) => b.disc - a.disc)[0] || null;
}
// 목록·지도·지도 아래 카드가 같은 결과를 쓰도록 모든 필터(업종·가맹점·⭐·이벤트·할인 있는 곳)와 정렬을 한 곳에서 처리
function filteredStores(amt = 10000) {
  let list = visibleStores();
  if (S.favOnly) list = list.filter(x => isFav(x.id));
  if (S.promoOnly) list = list.filter(x => hotPromo(x.brand));
  const R = new Map(list.map(st => [st.id, calc(st, amt)]));
  const real = (id) => { const r = R.get(id); return r.basic ? 0 : r.total; };   // 기본 1~2%는 '진짜 할인'에서 뺌
  if (S.saveOnly) list = list.filter(x => real(x.id) > 0);
  if (S.sort === 'save') list = list.slice().sort((a, b) => (real(b.id) - real(a.id)) || (R.get(b.id).total - R.get(a.id).total) || a.distance - b.distance);
  return { list, R };
}
function filterLabel() {
  const f = [S.cat !== 'all' ? catOf(S.cat).label : '', dbFilterAvailable() ? lcLabel(S.dbOnly) + ' 가맹점' : '', S.favOnly ? '⭐ 자주 가는 곳' : '', S.promoOnly ? '🔥 이벤트 중' : '', S.saveOnly ? '💰 할인 있는 곳' : '', S.searchLabel ? `'${S.searchLabel}' 검색` : ''].filter(Boolean);
  return f.join(' · ');
}
// 고른 상품권의 가맹점 자료가 있고, 목록에 그 지역 매장이 있을 때만 필터 적용
function dbFilterAvailable() { return !!S.dbOnly && merchAvailable().includes(S.dbOnly); }
// 매장 화면: 이 매장을 쓸 수 있는 지역화폐·온누리 (공공데이터 기준). 아직 안 켠 것은 켜라고 안내
// 매장 화면: 이 매장에서 온누리·지역화폐를 쓸 수 있는지 (공공데이터 → 내 확인 → 공식 조회 방법 순서)
const PAY_LOOKUP = {   // 공식 가맹점 조회 방법 (웹 주소가 있는 곳만 링크)
  onnuri: { url: 'https://onnurigift.or.kr', how: '온누리상품권 홈페이지·디지털 온누리 앱 [가맹점 찾기]' },
  seoul_love: { how: '서울페이+ 앱 [가맹점 찾기]' }, dongbaek: { how: '동백전 앱 [가맹점 찾기]' }, incheon_eum: { how: '인천e음 앱 [가맹점 찾기]' },
  suwon_pay: { how: '경기지역화폐 앱 [가맹점 찾기]' }, yongin_pay: { how: '경기지역화폐 앱 [가맹점 찾기]' }, goyang_pay: { how: '경기지역화폐 앱 [가맹점 찾기]' }, lc_4: { how: '경기지역화폐 앱 [가맹점 찾기]' },
  pohang_love: { how: 'iM샵 앱·포항시 포항사랑상품권 홈페이지 [가맹점]' }, gangneung_pay: { how: '강릉페이 앱 [가맹점 찾기]' }, lc_9: { how: '여민전 앱 [가맹점 찾기]' },
  lc_5: { how: '대구로페이 앱 [가맹점 찾기]' }, lc_6: { how: '광주상생카드 앱·광주은행 [가맹점 찾기]' }, lc_7: { how: '온통대전 앱 [가맹점 찾기]' }, lc_8: { how: '울산페이 앱 [결제매장 찾기]' }
};
function payCandidates(st) {
  let keys = regionKeysOf(st.address); if (!keys.length) keys = regionKeysOf(st.jibun); if (!keys.length) keys = currentRegionKeys();
  const list = localList().filter(lc => lcHere(lc, keys));
  const hasCity = list.some(lc => lc.regions.some(r => r.includes(' ') && keys.includes(r)));
  return list.filter(lc => !(lc.generic && hasCity)).sort((a, b) => (a.regions.includes('*') ? 1 : 0) - (b.regions.includes('*') ? 1 : 0));
}
function merchInfo(st) {
  const rows = payCandidates(st).map(lc => {
    const id = lc.id, v = myCheck(st, id), on = (S.locals[id] || {}).on;
    const d = DIRECT_ONLY.has(st.brand) && !(v && v.ok) ? 'direct' : payStatus(id, st);
    const excluded = (lc.excludeCats || []).includes(st.category) || (lc.excludeBrands || []).includes(st.brand);
    const basis = statusBasis(id) ? `${statusBasis(id)} 기준 공공데이터` : '';
    const isName = !!(MERCH[id] && MERCH[id].index && MERCH[id].index.type === 'name');
    const [icon, head, sub] =
      d === 'mine_ok' ? ['✅', '쓸 수 있어요', `내가 ${fmtAgo(v.t)} 직접 써 봤어요`]
      : d === 'mine_no' ? ['🚫', '안 돼요', `내가 ${fmtAgo(v.t)} 안 된다고 표시했어요`]
      : d === 'direct' ? ['🚫', '쓸 수 없어요', '본사가 모든 매장을 직영하는 브랜드예요. 대기업 직영점은 지역화폐 가맹점에서 빠져요']
      : d === 'member' ? ['✅', '가맹점이에요', isName && st._onnuriMkt ? `${st._onnuriMkt} 소속 · ${basis}` : basis]
      : d === 'closed' ? ['⚠️', '폐업·해지 신고된 가맹점이에요', `${basis} · 지금 영업 중인지, 상품권을 받는지 확인하세요`]
      : d === 'paper' ? ['🟡', '종이 상품권만 받아요', `${st._onnuriMkt ? st._onnuriMkt + ' 소속 · ' : ''}${basis} · 디지털은 안 될 수 있어요`]
      : d === 'likely' ? ['🟡', '가맹점일 가능성이 높아요', !isName && kcStatus(st) === 'likely' ? `300m 안에 같은 이름의 가맹점이 있어요 · ${basis}` : isName ? `같은 이름의 가맹점이 있어요${st._onnuriMkt ? ` (${st._onnuriMkt})` : ''} · ${basis}` : `같은 주소의 가맹점 1곳 · ${basis}`]
      : d === 'building' ? ['🟡', isName ? '같은 이름의 다른 가게일 수 있어요' : '같은 건물에 가맹점이 있어요', isName ? `목록의 ${st._onnuriMkt || '소속 시장'}이(가) 근처에 없어요 · ${basis}` : `이 매장인지 확인이 필요해요 · ${basis}`]
      : d === 'none' ? ['❔', isName ? '같은 이름의 가맹점이 목록에 없어요' : '가맹점 목록에 없어요', `${basis} · 그 뒤에 새로 가입했을 수 있어요`]
      : excluded ? ['🚫', '보통 쓸 수 없는 매장이에요', '대형마트·대기업 직영점 등은 사용처에서 빠져요']
      : ['❔', '아직 확인 안 됨', '가맹점 자료가 없어요'];
    const lk = PAY_LOOKUP[id] || {};
    const how = lk.how ? `${lk.url ? `<a href="${esc(lk.url)}" target="_blank" rel="noopener">${esc(lk.how)}</a>` : esc(lk.how)}에서 확인` : '';
    return `<div class="paychk"><div class="pc-top"><span class="pc-ic">${icon}</span><div class="bd"><div class="t">${esc(lc.name)} · ${head}</div>
      <div class="d">${esc(sub)}${lc.rate && !isExpired(lc) ? ` · ${pct(lc.rate)} 할인·캐시백` : ''}</div></div>
      ${on ? '' : `<button type="button" class="toggle" data-local="${esc(id)}" aria-label="${esc(lc.name)} 켜기"></button>`}</div>
      <div class="pc-act"><span class="pc-q">여기서 써 봤나요?</span>
        <button type="button" class="chip ${v && v.ok ? 'on' : ''}" data-vfy="${esc(id)}:1">${ICHK} 됐어요</button>
        <button type="button" class="chip ${v && !v.ok ? 'on' : ''}" data-vfy="${esc(id)}:0">${IX} 안 됐어요</button></div>
      ${how && !payOk(d) ? `<div class="pc-how">${how}</div>` : ''}</div>`;
  }).join('');
  return rows ? `<div class="section"><h3>상품권·지역화폐 쓸 수 있나요?</h3>${rows}
    <p class="hint">'됐어요/안 됐어요'는 이 기기에만 저장되고, 다음부터 목록과 할인 계산에 반영돼요. 매장 앞 가맹점 스티커도 함께 확인하세요.</p></div>` : '';
}
function fmtAgo(t) {
  const d = Math.floor((Date.now() - t) / 86400000);
  return d <= 0 ? '오늘' : d === 1 ? '어제' : d < 30 ? `${d}일 전` : `${new Date(t).getMonth() + 1}월 ${new Date(t).getDate()}일에`;
}
function setVerify(storeId, id, ok) {
  const cur = (S.verified[storeId] || {})[id];
  const m = { ...(S.verified[storeId] || {}) };
  if (cur && cur.ok === ok) delete m[id]; else m[id] = { ok, t: Date.now() };   // 같은 버튼을 다시 누르면 취소
  if (Object.keys(m).length) S.verified[storeId] = m; else delete S.verified[storeId];
  store.set('hs_verified', S.verified);
  renderAll();
  toast(cur && cur.ok === ok ? '표시를 취소했어요.' : ok ? '기록했어요. 이 매장 옆에 ✓ 표시가 붙어요.' : '기록했어요. 이 매장은 계산에서 뺄게요.');
}
// 매장 이름 옆에 붙는 가맹점 표시 (자료로 확인된 것만). 켜 둔 상품권을 앞에
function merchBadges(st) {
  const ids = merchAvailable().sort((a, b) => ((S.locals[b] || {}).on ? 1 : 0) - ((S.locals[a] || {}).on ? 1 : 0));
  return ids.map(id => { const d = payStatus(id, st); const l = lcLabel(id);
    return payOk(d) ? ` · <span class="dbk">${esc(l)}${d === 'mine_ok' ? ' ✓' : ''}</span>` : d === 'likely' ? ` · <span class="dbk">${esc(l)}?</span>` : ''; }).join('')
    + (kcStatus(st) === 'closed' ? ' · <span class="dbk warn">⚠️ 폐업 신고</span>' : '');
}
function renderChips() {
  const counts = {}; S.stores.forEach(s => { counts[s.category] = (counts[s.category] || 0) + 1; });
  const dbChip = merchAvailable().sort((a, b) => ((S.locals[b] || {}).on ? 1 : 0) - ((S.locals[a] || {}).on ? 1 : 0))
    .map(id => `<button type="button" class="chip db ${S.dbOnly === id ? 'on' : ''}" data-merch="${id}">🪙 ${esc(lcLabel(id))} 가맹점만</button>`).join('')
    + (Object.keys(S.favs).length ? `<button type="button" class="chip db ${S.favOnly ? 'on' : ''}" data-act="favonly">⭐ 자주 가는 곳</button>` : '')
    + (S.stores.some(x => hotPromo(x.brand)) ? `<button type="button" class="chip db ${S.promoOnly ? 'on' : ''}" data-act="promoonly">🔥 이벤트 중인 곳</button>` : '')
    + (S.stores.length ? `<button type="button" class="chip db ${S.saveOnly ? 'on' : ''}" data-act="saveonly">💰 할인 있는 곳만</button>` : '');
  // 개수: 찾는 중이면 '…', 일부만 찾았으면 '+' (0곳과 '아직 찾는 중'을 구분)
  const nTxt = (c) => {
    const n = c.id === 'all' ? S.stores.length : (counts[c.id] || 0);
    const ek = EXTRA[c.id] ? (EXTRA[c.id].alias || c.id) : null;
    const ex = ek ? S.extra.done[ek] : undefined;
    const src = c.id === 'super' ? 'mart' : c.id;
    const mainPending = S.loading && (c.id === 'all' || (LOAD_ORDER.includes(src) && !S.doneCats.has(src)));
    if (mainPending || ex === 'loading') return n ? `${n}…` : '…';
    if (ex === 'partial' || (S.truncated && c.id !== 'all')) return `${n}+`;
    return String(n);
  };
  $('#catChips').innerHTML = (S.big ? (S.stores.length ? `<button type="button" class="chip db ${S.saveOnly ? 'on' : ''}" data-act="saveonly">💰 할인 있는 곳만</button>` : '') : dbChip) + CATS.map(c =>
    `<button type="button" class="chip ${S.cat === c.id ? 'on' : ''}" data-cat="${c.id}">${c.emoji ? c.emoji + ' ' : ''}${c.label}${S.stores.length || S.loading ? ` <span class="n">${nTxt(c)}</span>` : ''}</button>`).join('');
}
function renderStatus() {
  if (!S.center && !S.loading) { setStatus('위치를 정하면 주변 매장을 찾아 드려요.', ''); return; }
  if (S.loading) { setStatus(`${S.center ? S.center.label + ' 주변' : ''} 매장을 찾는 중… (${S.stores.length}곳)`, 'warn'); return; }
  if (S.searchLabel) { setStatus(`'${S.searchLabel}' 검색 결과 ${S.stores.length}곳`, 'ok'); return; }
  let t = `${S.center.label} 반경 ${dist(S.radius)} · ${S.stores.length}곳`;
  if (dbFilterAvailable()) t += ` · ${lcLabel(S.dbOnly)} 가맹점 ${visibleStores().length}곳${merchBasis(S.dbOnly) ? ` (${merchBasis(S.dbOnly)} 기준)` : ''}`;
  if (S.source) t += ` · ${S.source}`;
  if (S.errorMsg && S.source === '오픈스트리트맵') t += ` (${S.errorMsg} → 대체 지도 사용, 일부 매장이 빠질 수 있어요)`;
  else if (S.errorMsg && S.source) t += ` · 일부 업종을 못 불러왔어요 (${S.errorMsg})`;
  else if (S.errorMsg) t += ` · 매장을 불러오지 못했어요 (${S.errorMsg})`;
  else if (S.source === '오픈스트리트맵') t += ' (일부 매장이 빠질 수 있어요)';
  if (S.pendingRunning) t += ' · 빠진 가게가 없는지 한 번 더 확인하는 중…';
  else if (S.pending && S.pending.length) t += ' · 가게가 많아 아직 다 못 찾았어요';
  const fl = filterLabel(); if (fl && !S.searchLabel) t += ` · 보는 중: ${fl} ${filteredStores().list.length}곳`;
  setStatus(t, S.errorMsg || (S.pending && S.pending.length) || S.source === '오픈스트리트맵' ? 'warn' : 'ok');
}
function renderList() {
  if (S.stores.length && !S.loading) ensureMerchants(S.stores);
  const el = $('#storeList');
  if (!S.center && !S.loading && !S.stores.length) {
    el.innerHTML = `<div class="empty">
      <div style="font-size:42px">📍</div>
      <h3>어디 근처 매장을 볼까요?</h3>
      <p>내 위치를 쓰거나, 위 검색창에 동네·역 이름을 입력하세요.</p>
      <button class="btn green" type="button" data-act="gps">내 위치로 찾기</button>
      <div class="chips" style="justify-content:center;flex-wrap:wrap;margin-top:14px">
        ${['강남역', '홍대입구역', '서면역', '동성로', '둔산동'].map(a => `<button class="chip" type="button" data-area="${a}">${a}</button>`).join('')}
      </div></div>`;
    return;
  }
  let { list, R } = filteredStores();
  const unread = S.favNews.filter(x => !x.read).length;
  const favHere = S.cat === 'all' && !S.favOnly ? S.stores.filter(x => isFav(x.id)) : [];
  const promoN = PROMOS.filter(p => { const n = promoNext(p); return n && n.today && !(p.carrier && S.carriers.length && !S.carriers.includes(p.carrier)); }).length;
  const sugg = (S.loading ? [] : S.localSuggest).map(id => `<div class="favnews sugg"><span>🪙 ${esc(placeName())}에서는 <b>${esc(lcLabel(id))}</b>도 비교할 수 있어요. 갖고 계세요?</span>
    <span class="sbtn"><button type="button" class="btn sm green" data-lsug="${esc(id)}:1">있어요</button><button type="button" class="btn sm ghost" data-lsug="${esc(id)}:0">없어요</button></span></div>`).join('');
  const sortBar = S.stores.length ? `<div class="sortbar"><span>정렬</span><button type="button" class="${S.sort === 'dist' ? 'on' : ''}" data-sort="dist">가까운 순</button><button type="button" class="${S.sort === 'save' ? 'on' : ''}" data-sort="save">절약액 순 (1만원 결제 기준)</button></div>` : '';
  let startBar = '';
  if (!S.carriers.length && !store.get('hs_carrierNone', false) && !ownedCards().length && S.stores.length && !S.loading) {
    const cnt = (code) => S.stores.filter(st => ((DATA.carriers || {})[code] || {}).brands && DATA.carriers[code].brands[st.brand]).length;
    const n = Math.max(cnt('SKT'), cnt('KT'), cnt('LGU'));
    startBar = `<div class="startbar"><b>👋 통신사만 골라도 이 동네 ${n ? `최대 ${n}곳에서` : ''} 할인 금액이 보여요</b>
      <div class="sbtn">${[['SKT', 'SKT'], ['KT', 'KT'], ['LGU', 'LG U+']].map(([k, l]) => `<button type="button" class="btn sm" data-carrier="${k}">${l} (${cnt(k)}곳)</button>`).join('')}<button type="button" class="btn sm ghost" data-act="onboard">카드도 고르기</button></div></div>`;
  }
  const retryBar = S.extraFail ? `<button class="favnews promo" type="button" data-act="retryextra">🍜 동네 식당 일부를 못 불러왔어요 <span>다시 불러오기 ›</span></button>` : '';
  const moreBar = !S.loading && !S.pendingRunning && S.pending && S.pending.length ? `<button class="favnews promo" type="button" data-act="morestores">🔎 가게가 많은 동네라 아직 다 못 찾았어요 <span>빠진 가게 더 찾기 ›</span></button>` : '';
  // 설정 안내는 한 번에 하나만 (화면 위가 안내로 가득 차지 않게)
  const favBar = startBar + retryBar + moreBar + (startBar ? '' : sugg) + sortBar + (promoN && S.cat === 'all' ? `<button class="favnews promo" type="button" data-act="promos">🔥 지금 진행 중인 프랜차이즈 이벤트 ${promoN}개 <span>모아보기 ›</span></button>` : '') + (unread ? `<button class="favnews" type="button" data-act="favnews">⭐ 자주 가는 곳 새 소식 ${unread}건 <span>보기 ›</span></button>` : '')
    + (favHere.length ? `<div class="favrow"><span>⭐ 자주 가는 곳</span>${favHere.slice(0, 8).map(x => `<button type="button" class="chip" data-store="${esc(x.id)}">${esc(x.name)}</button>`).join('')}</div>` : '');
  if (!list.length) {
    el.innerHTML = favBar + (S.loading ? '<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>'
      : S.saveOnly ? `<div class="empty"><h3>지금 결제수단으로 할인되는 매장이 없어요</h3><p>[내 지갑]에서 카드·통신사를 고르거나, 필터를 꺼 보세요.</p></div>`
      : S.promoOnly ? `<div class="empty"><h3>이 근처에 지금 이벤트 중인 매장이 없어요</h3><p>위 [🔥 모아보기]에서 전국 이벤트를 볼 수 있어요.</p></div>`
      : S.favOnly ? `<div class="empty"><h3>이 근처에 ⭐ 자주 가는 곳이 없어요</h3><p>매장 화면에서 ☆를 누르면 여기에 모여요. 다른 곳의 ⭐는 [내 지갑]에서 볼 수 있어요.</p></div>`
      : S.errorMsg ? `<div class="empty"><h3>매장 검색이 잠깐 안 되고 있어요</h3><p>${esc(S.errorMsg)} · 매장이 없는 게 아니에요. 잠시 후 다시 찾아 주세요.</p><button class="btn green" type="button" data-act="reload">다시 찾기</button></div>`
      : (S.pending || []).some(p => p.fb === S.cat || (S.cat === 'mart' && p.fb === 'super')) ? `<div class="empty"><h3>이 업종은 아직 다 못 불러왔어요</h3><p>매장이 없는 게 아니라 검색이 덜 끝났어요.</p><button class="btn green" type="button" data-act="morestores">이 업종 다시 찾기</button></div>`
      : `<div class="empty"><h3>이 업종 매장이 없어요</h3><p>반경을 넓히거나 다른 업종을 골라 보세요.</p></div>`);
    return;
  }
  el.innerHTML = favBar + list.slice(0, 300).map(st => {
    const r = R.get(st.id);
    const viaLocal = r.best && r.best.m.kind === 'local';
    const hasAny = ownedCards().length || S.carriers.length || localList().some(l => (S.locals[l.id] || {}).on);
    const wg = (r.total === 0 || r.basic) ? wouldGet(st) : null;
    const save = r.total > 0 && !r.basic
      ? `<div class="save"><div class="amt">-${won(r.total)}</div><div class="lbl">${viaLocal ? esc(lcLabel(r.best.m.id)) + ' · ' : ''}1만원 결제 시</div></div>`
      : wg && wg.disc > r.total ? `<div class="save none"><div class="amt q2">-${won(wg.disc)}</div><div class="lbl">${esc(wg.label)}</div></div>`
      : r.basic ? `<div class="save none"><div class="amt basic">기본 ${pct(r.best.rule.rate)}</div><div class="lbl">모든 가게 공통</div></div>`
      : r.hints.length ? `<div class="save none"><div class="amt q">확인 필요</div><div class="lbl">조건 맞으면 -${won(r.hints[0].disc)}</div></div>`
      : r.pt ? `<div class="save none"><div class="amt pt">+${won(r.pt.disc).replace('원', '')}P</div><div class="lbl">적립 예상</div></div>`
      : `<div class="save none"><div class="amt">${hasAny ? '할인 정보 없음' : ''}</div></div>`;
    const pu = pointUseFor(st);
    return `<button class="store" type="button" data-store="${esc(st.id)}">${badge(st)}
      <div class="info"><div class="name">${isFav(st.id) ? '⭐ ' : ''}${esc(st.name)}</div>
      <div class="sub">${dist(st.distance)} · ${esc(catOf(st.category).label)}${hotPromo(st.brand) ? ' · <span class="evk">🔥 이벤트 중</span>' : (DATA.events || {})[st.brand] ? ' · 🎁 매장 혜택' : ''}${merchBadges(st)}${pu ? ` · <span class="ptuse">💳 ${esc(pu.p.name.replace(/^현대카드 /, ''))} ${pu.rate}% 사용</span>` : ''}</div></div>${save}</button>`;
  }).join('') + (list.length > 300 ? `<p class="foot">가까운 300곳만 보여요. 업종을 고르거나 반경을 줄여 보세요.</p>` : '')
    + (S.cat === 'all' && S.source === '카카오맵' ? `<p class="foot">🍜 동네 식당·빵집도 ${EXTRA_RADIUS >= S.radius ? '' : '반경 1km 안에서 '}카카오맵에 등록된 곳을 함께 찾아요${EXTRA_RADIUS >= S.radius ? '' : '([외식] 칩을 누르면 고른 반경 전체)'}. 가게가 많으면 한 번 더 확인해서 빠진 곳을 채워요. 미용실은 [헤어·뷰티], 약국·안경·세탁소·꽃집 등은 [약국·생활]을 누르면 찾아요. 찾는 가게가 목록에 없으면 위 검색창에 가게 이름을 넣어 보세요. 바로 찾아 넣어 드려요.</p>` : '')
    + (!ownedCards().length && !S.carriers.length ? `<p class="foot">💳 [내 지갑]에서 카드·통신사를 고르면 매장별 할인액이 보여요.</p>` : '');
}

function cardInfoUrl(c) {
  const aff = CONFIG.cardPromo.affiliate && CONFIG.cardPromo.affiliateUrls[c.id];
  if (aff) return aff;
  if (srcTrust(c) === 'official') return c.src;
  return ISSUER_HOME[c.issuer] || c.infoUrl || `https://search.naver.com/search.naver?query=${encodeURIComponent(c.issuer + ' ' + c.name)}`;
}
function promoNotice() {
  const p = CONFIG.cardPromo;
  return `<p class="warn">${p.affiliate ? '<b>광고</b> · 이 링크로 카드를 만들면 여긴할인이 카드사로부터 수수료를 받을 수 있어요. ' : '여긴할인은 이 카드와 제휴하지 않았고 비교 정보만 보여드려요. '}`
    + `혜택·조건은 카드사 상품설명서와 약관을 꼭 확인하세요. 상환능력에 비해 신용카드 사용액이 과도할 경우 개인신용평점이 하락할 수 있습니다. 연체 시 연체이자율이 적용되며 계약 해지·기한의 이익 상실 등 불이익이 있을 수 있어요.${p.affiliate && p.adReviewNo ? ' · ' + esc(p.adReviewNo) : ''}</p>`;
}

function renderStore() {
  const st = S.stores.find(s => s.id === S.selectedId);
  const el = $('#viewStore');
  if (!st) { el.innerHTML = ''; return; }
  const amount = Math.max(0, Number(S.amount) || 0);
  const r = calc(st, amount, { excl: S.exclAmt });
  const c = catOf(st.category);
  const naver = `https://map.naver.com/p/search/${encodeURIComponent(st.name)}`;
  const kakaoLink = st.url || `https://map.kakao.com/link/map/${encodeURIComponent(st.name)},${st.lat},${st.lng}`;

  const tierBtns = (code) => `<span class="pq">내 등급: ${(CAR_TIERS[code] || []).map(t => `<button type="button" class="linkbtn ${(S.ctier || {})[code] === t ? 'on' : ''}" data-ctier="${code}:${t}">${t}</button>`).join(' ')}</span>`;
  const step1 = r.car
    ? `<div class="step ${r.car.disc > 0 ? '' : 'off'}"><span class="no">1</span><div class="bd"><div class="t">${esc(r.car.name)} 바코드 먼저</div><div class="d">${r.car.tier ? `<b>${esc(r.car.tier)}</b> · ` : ''}${r.car.calcTxt && r.car.disc > 0 ? esc(r.car.calcTxt) + ' · ' : ''}${r.car.note ? `<b>${esc(r.car.note)}</b> · ` : ''}${esc(r.car.desc)}${r.car.excl ? ` · 제외 상품 ${won(r.car.excl)} 빼고 계산` : ''}${r.car.needTier ? ' · ' + tierBtns(r.car.code) : ''}</div></div><span class="m">${r.car.accrue ? '+' + r.car.accrue.toLocaleString() + 'P' : '-' + won(r.car.disc)}</span></div>`
    : `<div class="step off"><span class="no">1</span><div class="bd"><div class="t">통신사 할인 없음</div><div class="d">${esc(S.carriers.length ? (r.carrierNotes[0] || '선택한 통신사는 이 매장에 상시 할인이 없어요') : '[내 지갑]에서 통신사를 고르면 반영돼요')}</div></div><span class="m">0원</span></div>`;
  let step2;
  if (r.best && r.best.m.kind === 'local') {
    const lc = r.best.m.lc;
    const okTxt = r.best.mine ? '✓ 내가 써 본 매장 (내 확인 기준)' : `✓ 공식 가맹점 목록에서 ${MERCH_SETS[lc.id] && MERCH_SETS[lc.id].type === 'name' ? '이름·소속 시장' : '이름·주소'} 확인${merchBasis(lc.id) ? ` (${esc(merchBasis(lc.id))} 기준)` : ''}`;
    step2 = `<div class="step"><span class="no">2</span><div class="bd"><div class="t">${esc(lcLabel(lc.id))}${ro(lcLabel(lc.id))} 결제</div><div class="d">${pct(r.best.rate)} ${esc(lc.kind === '상품권' ? '할인 구매' : '할인·캐시백')} · ${okTxt}${lc.cap > 0 ? ` · 한 달 최대 ${won(lc.cap)}까지 혜택` : ''}</div></div><span class="m">-${won(r.best.disc)}</span></div>`;
  } else if (r.best) {
    const rl = r.best.rule;
    const capT = r.best.capKnown && r.best.cap > 0 ? ` · 남은 한도 약 ${won(r.best.cap)} (앱 기록 기준 추정)` : r.best.cap === 0 && !r.best.capReached ? ' · 한도 없음' : ' · 한도는 카드사 확인';
    const cd = r.best.m.card;
    step2 = `<div class="step"><span class="no">2</span><div class="bd"><div class="t">${esc(r.best.m.name)}</div><div class="d">${ruleLabel(rl)}${rl.via ? ` · <b>${esc(rl.via)}${ro(rl.via)} 결제</b>` : ''}${rl.opt ? ` · ${esc(rl.opt)}` : ''}${rl.note ? ' · ' + esc(rl.note) : ''}${capT}${cd.prevMin ? (prevState(cd) ? ' · ✓ 전월실적 충족' : ` · 지난달 이 카드로 ${won(cd.prevMin)} 이상 썼을 때 <span class="pq">지난달 그만큼 썼나요? <button type="button" class="linkbtn" data-prev="${esc(cd.id)}:1">채웠어요</button> <button type="button" class="linkbtn" data-prev="${esc(cd.id)}:0">못 채웠어요</button></span>`) : ''}</div></div><span class="m">-${won(r.best.disc)}</span></div>`;
  } else {
    const why = r.excluded || (!ownedCards().length ? '[내 지갑]에서 가진 카드를 등록하세요' : r.per.some(x => x.capReached) ? '이번 달 할인 한도를 다 쓴 카드가 있어요 (결제 기록 기준)' : r.expiredCount ? '카드 정보 확인 기한이 지나 계산에서 뺐어요' : '내 카드 중 이 매장에서 할인되는 카드가 없어요');
    step2 = `<div class="step off"><span class="no">2</span><div class="bd"><div class="t">카드 할인 없음</div><div class="d">${esc(why)}</div></div><span class="m">0원</span></div>`;
  }

  // 내 결제수단별 비교 (카드 + 켜 둔 지역화폐)
  const mine = r.per.slice().sort((a, b) => b.disc - a.disc).map(x => `
    <button class="rowi" type="button" ${x.m.kind === 'local' ? `data-localinfo="${esc(x.m.id)}"` : `data-card="${esc(x.m.id)}"`}><div class="bd"><div class="t">${x.m.kind === 'local' ? '🪙 ' : ''}${esc(x.m.name)}</div>
    <div class="d">${esc(methodLabel(x))}</div></div>
    <div class="r">${x.disc > 0 ? '-' + won(x.disc) : '-'}</div></button>`).join('');

  // 더 아낄 수 있는 카드 (내가 안 가진, 혜택 확인된 카드만)
  const after = amount - (r.car ? r.car.disc : 0);
  const bestNow = r.best ? r.best.disc : 0;
  const better = (DATA.cards || []).filter(cd => !S.owned.has(cd.id) && !isExpired(cd) && isCashCard(cd) && ageOk(cd) && !/종료|중단/.test(cd.status || ''))
    .map(cd => ({ card: cd, ...cardDiscount(cd, st, after, new Date(), { ignoreUsed: true, allConds: true }) }))
    .filter(x => x.disc > bestNow && x.capKnown).sort((a, b) => b.disc - a.disc).slice(0, 3);
  const evs = storeEvents(st.brand);
  const anyMethod = ownedCards().length || localList().some(l => (S.locals[l.id] || {}).on);

  el.innerHTML = `
    <div class="detail-head">
      <button class="back" type="button" data-act="back">‹ 목록으로</button>
      <div class="dh-main">${badge(st, 'lg')}<div style="min-width:0">
        <h2>${esc(st.name)} <button type="button" class="favbtn ${isFav(st.id) ? 'on' : ''}" data-act="fav" aria-label="자주 가는 곳">${isFav(st.id) ? '★' : '☆'}</button></h2>
        <div class="dh-sub">${esc(c.label)} · ${dist(st.distance)}${st.address ? ' · ' + esc(st.address) : ''}</div></div></div>
      <div class="dh-actions">
        <a href="${esc(kakaoLink)}" target="_blank" rel="noopener">카카오맵</a>
        <a href="${esc(naver)}" target="_blank" rel="noopener">네이버 지도</a>
        <button type="button" data-act="showmap">지도</button>
        <button type="button" class="sharemini" data-act="sharestore" aria-label="친구에게 알려주기">📤 공유</button>
      </div>
    </div>
    <div class="section topsum">
        <div class="onetap big1">${(() => { const nm = r.best ? (r.best.m.kind === 'local' ? lcLabel(r.best.m.id) : r.best.m.name) : '아무 카드'; const wg = wouldGet(st, amount);
          if (r.total > 0 && !r.basic) return `👉 <b>${r.car ? esc(r.car.name.replace(/ 멤버십| T멤버십/, '')) + ' 바코드 + ' : ''}${esc(nm)}</b>${ro(nm)} 내면 <b>${won(r.total)}</b> 아껴요`;
          if (wg && wg.disc > r.total) return `👉 지금은 ${r.basic ? `기본 ${won(r.total)}뿐이지만` : '할인이 없지만'} <b>${esc(wg.label)} ${won(wg.disc)}</b> 아낄 수 있어요`;
          if (r.basic) return `👉 <b>${esc(nm)}</b> 기본 혜택 ${pct(r.best.rule.rate)} (${won(r.total)})만 받아요`;
          return r.hints.length ? '👉 조건이 확인된 할인은 아직 없어요. 아래 조건을 확인해 보세요' : '👉 이 매장은 지금 설정으로 할인이 없어요'; })()}</div>
      <h3>얼마 결제하세요?</h3>
      <div class="amounts">
        ${[5000, 10000, 20000, 50000].map(a => `<button type="button" class="chip ${a === amount ? 'on' : ''}" data-amt="${a}">${(a / 10000) >= 1 ? a / 10000 + '만원' : a / 1000 + '천원'}</button>`).join('')}
      </div>
      <label class="amt-in"><span>직접 입력</span><input id="amtInput" type="number" inputmode="numeric" min="0" step="100" value="${amount}" aria-label="결제 금액" /><span>원</span></label>
      ${r.car ? `<label class="amt-in excl"><span>멤버십 제외 상품<br><small>1+1·담배·주류 등</small></span><input id="exclInput" type="number" inputmode="numeric" min="0" step="100" value="${S.exclAmt || ''}" placeholder="0" aria-label="멤버십 할인 제외 상품 금액" /><span>원</span></label>` : ''}
      <div class="result">

        <div class="final"><div><div class="lbl">매장에서 결제할 금액</div><div class="v">${won(r.pay)}</div>${r.car ? `<div class="o2">원래 ${won(amount)} − 멤버십 현장할인 ${won(r.car.disc)}</div>` : ''}</div>${r.total > 0 ? `<span class="pill green">약 ${pct(r.rate)} 절약</span>` : ''}</div>
        <div class="brk">
          ${r.best ? `<div><span>${r.best.m.kind === 'local' ? (r.best.m.lc.kind === '상품권' ? '상품권 할인 구매분 (미리 싸게 산 금액)' : '지역화폐 혜택 (충전할 때 더 주거나 나중에 돌려줘요)') : esc(KIND_LABEL[r.best.m.card.kind] || '카드 혜택')}</span><b>-${won(r.best.disc)}</b></div>` : ''}
          ${r.pt ? `<div class="pt"><span>${esc(KIND_LABEL[r.pt.m.card.kind] || '적립')} · ${esc(r.pt.m.name)}</span><b>+${won(r.pt.disc).replace('원', '')}${r.pt.m.card.kind === 'mileage' ? '마일 상당' : r.pt.m.card.kind === 'star' ? ' 상당' : 'P'}</b></div>` : ''}
          <div class="net"><span>혜택 반영 후 실질 부담</span><b>${won(r.final)}</b></div>
        </div>
        <div class="saved">${r.total > 0 ? `예상 절약 ${won(r.total)}${r.pt ? ' (포인트 적립은 빼고 계산)' : ''}` : r.hints.length ? '조건이 확인된 할인은 없어요 · 아래 조건을 확인하면 받을 수 있어요' : '지금 설정으로는 할인 예상액이 없어요'}</div>
        <div class="steps">${step1}${step2}</div>
        ${r.hints.slice(0, 2).map(h => h.kind === 'local'
          ? `<div class="hintx">🔎 ${esc(lcLabel(h.x.m.id))} 가맹점이면 -${won(h.disc)} · ${h.x.db === 'likely' ? '근처 가맹점 목록에 비슷한 이름이 있지만 이 매장인지 확인이 필요해요 (아래 [가맹점 확인] 참고)' : '가맹점 여부를 아직 확인하지 못했어요'} <button type="button" class="linkbtn" data-vfy="${esc(h.x.m.id)}:1">여기서 써 봤어요</button></div>`
          : `<div class="hintx">💳 ${esc(h.x.m.name)}: ${h.x.cond.need.map(condText).map(esc).join('·')}하면 -${won(h.disc)} ${h.x.cond.need.map(k => `<button type="button" class="linkbtn" data-cond="${esc(h.x.m.id)}|${esc(k)}">${esc(condText(k))}해요</button>`).join(' ')}</div>`).join('')}
        ${amount > 0 ? `<button class="btn green block" type="button" data-act="logpay" style="margin-top:10px">✔ 이렇게 결제했어요 (기록)</button>` : ''}
      </div>
      <p class="foot" style="padding:8px 0 0">매장에서는 위 '결제할 금액'을 내요. 카드 청구할인·캐시백·적립은 결제 후 반영되고, 전월실적·한도·행사상품 제외 조건은 각 사 앱에서 확인하세요. 남은 한도는 이 앱에 기록한 결제만 반영한 추정치예요.</p>
    </div>
    ${merchInfo(st)}
    ${(() => { const pu = pointUseFor(st); if (!pu) return ''; const use = Math.floor(amount * pu.rate / 100);
      return `<div class="section ptsec"><h3>💳 ${esc(pu.p.name)}로 결제할 수 있어요</h3>
        <div class="rowi"><div class="bd"><div class="t">오늘 결제 금액의 최대 <b>${pu.rate}%</b>${pu.maxRate > pu.rate ? ` <span class="muted">(요일에 따라 최대 ${pu.maxRate}%)</span>` : ''}${amount > 0 ? ` · ${won(amount)} 중 최대 <b>${won(use).replace('원', '')}P</b>` : ''}</div>
        <div class="d">${esc(pu.m.note || '')}${pu.m.end ? ` · ${esc(pu.m.end.slice(5).replace('-', '/'))}까지` : ''} · ${pu.m.srcType === '공식' ? '<span class="tb ok">공식 자료 확인</span>' : pu.m.srcType === '보도자료' ? '<span class="tb ok">보도자료 확인</span>' : '<span class="tb warn">2차 자료 · 카드사 확인 권장</span>'} <a href="${esc(pu.m.src)}" target="_blank" rel="noopener">출처</a></div>
        <div class="d">👉 ${esc(pu.p.howTo)}</div>
        <div class="d muted">할인이 아니라 모아 둔 포인트를 쓰는 거라 위 절약액에는 넣지 않았어요. ${esc(pu.p.balanceHint || '')}</div></div></div></div>`; })()}
    ${anyMethod ? `<div class="section"><h3>내 결제수단으로 내면</h3><div class="rows">${mine}</div></div>` : ''}
    ${evs.length ? `<div class="section"><h3>이 매장 이벤트·혜택</h3><div class="rows">${evs.map((e, i) => `
      <button class="rowi" type="button" data-ev="${i}"><div class="bd"><div class="t">${esc(e.title)}</div><div class="d">${esc(e.condition)}</div></div>
      <div class="r"><span class="pill ${e.type === 'tip' ? 'blue' : e.type === 'promo' ? 'red' : 'amber'}">${esc(e.badge)}</span></div></button>`).join('')}</div></div>` : ''}
    ${better.length ? `<details class="section promo newcard"><summary>💡 새 카드를 만들면 이 매장에서 더 아낄 수 있어요 (참고) ${CONFIG.cardPromo.affiliate ? '<span class="adlbl">광고</span>' : ''}</summary>
      <p class="hint">지금 가진 결제수단이 먼저예요. 아래는 카드를 새로 만들고 조건을 모두 지켰을 때 이 매장 한 번 결제 기준이에요.</p>
      <div class="rows">${better.map(x => `
      <div class="rowi"><div class="bd"><div class="t">${esc(x.card.name)} <span class="pill">${esc(x.card.type || '')}</span></div>
        <div class="d">${esc(x.card.issuer)} · ${ruleLabel(x.rule)}${x.rule.via ? ` · <b>${esc(x.rule.via)} 결제 시</b>` : ''}${x.rule.opt ? ` · ${esc(x.rule.opt)}` : ''}${x.rule.note ? ' · ' + esc(x.rule.note) : ''}${x.card.prevMin ? ` · 전월실적 ${won(x.card.prevMin)} 이상` : ''}${cardWho(x.card) ? ` · <b>${esc(cardWho(x.card))}</b>` : ''} · ${trustBadge(x.card)}</div>
        <div class="promo-act"><button type="button" class="linkbtn" data-card="${esc(x.card.id)}">혜택 자세히</button>
        <a class="btn sm" href="${esc(cardInfoUrl(x.card))}" target="_blank" rel="noopener${CONFIG.cardPromo.affiliate ? ' sponsored' : ''}">카드 알아보기</a></div></div>
        <div class="r"><b class="up">${won(x.disc - bestNow)}</b><small>더 할인</small></div></div>`).join('')}</div>
      ${promoNotice()}</details>` : ''}
    <div style="padding:0 12px"><button class="btn ghost block" type="button" data-act="report">🚨 틀린 정보 알려주기</button></div>
    <p class="foot">혜택 기준일 ${esc((DATA.meta || {}).checkedAt || '-')} · 매장 정보 ${esc(S.source || '-')}</p>`;
}

// ---------- 초성 검색 ----------
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const chosung = (str) => Array.from(str).map(ch => { const c = ch.charCodeAt(0) - 0xAC00; return c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch; }).join('');
const norm = (t) => String(t || '').toLowerCase().replace(/[\s·\-_.]/g, '');
const CHO_CACHE = new Map();
// 영문 카드 이름을 한글로도 찾게 (예: "미스터라이프" → Mr.Life, "탭탭" → taptap)
const EN_KO = [['mr.life', '미스터라이프'], ['mrlife', '미스터라이프'], ['taptap', '탭탭'], ['zero', '제로'], ['likit', '라이킷'], ['loca', '로카'], ['deepdream', '딥드림'],
  ['deep', '딥'], ['dream', '드림'], ['nori', '노리'], ['wesh', '위시'], ['green', '그린'], ['alphabet', '알파벳'], ['monimo', '모니모'], ['npay', '네이버페이'],
  ['kbpay', '케이비페이'], ['super', '슈퍼'], ['edition', '에디션'], ['point', '포인트'], ['simpleplan', '심플플랜'], ['every', '에브리'], ['discount', '디스카운트'],
  ['toss', '토스'], ['the', '더'], ['one', '원'], ['check', '체크'], ['travel', '트래블'], ['star', '스타'], ['mile', '마일'], ['platinum', '플래티넘'], ['gold', '골드'],
  ['amex', '아멕스'], ['kbank', '케이뱅크'], ['kakao', '카카오'], ['naver', '네이버'], ['hey', '헤이'], ['young', '영'], ['all', '올'], ['my', '마이'], ['pay', '페이'], ['card', '카드']];
function searchText(text) {
  const n = norm(text); let ko = n;
  EN_KO.forEach(([en, k]) => { if (ko.includes(en)) ko = ko.split(en).join(k); });
  return ko === n ? n : n + '|' + ko;
}
function matchQ(q, text) {
  if (!q) return true;
  const n = searchText(text);
  if (n.includes(q)) return true;
  // 초성 검색: 숫자·영문이 섞여도 됨 (예: "ㄴㄹ2" → 노리2)
  if (!/[ㄱ-ㅎ]/.test(q)) return false;
  let c = CHO_CACHE.get(n); if (c === undefined) { c = chosung(n); CHO_CACHE.set(n, c); }
  return c.includes(q);
}

function cardMonthBox(c) {
  const now = monthStats(c.id);
  const d = new Date(); const prev = monthStats(c.id, monthKey(new Date(d.getFullYear(), d.getMonth() - 1, 1)));
  const remain = c.cap > 0 ? Math.max(0, c.cap - now.disc) : null;
  const pm = c.prevMin || 0;
  const prog = pm ? Math.min(100, Math.round(now.spend / pm * 100)) : 0;
  if (!now.n && !prev.n && !pm) return '';
  return `<div class="mbox">
    <div class="mrow"><span>이번 달 기록</span><b>${won(now.spend)} 결제 · ${won(now.disc)} 할인</b></div>
    ${remain !== null ? `<div class="mrow"><span>남은 월 할인 한도</span><b>${won(remain)} / ${won(c.cap)}</b></div>` : ''}
    ${pm ? `<div class="mrow"><span>다음 달 혜택 조건 (전월실적 ${won(pm)})</span><b>${prog}%</b></div><div class="bar"><i style="width:${prog}%"></i></div>
    <div class="mrow sub"><span>지난달 기록 ${won(prev.spend)}</span><span>${prev.spend >= pm ? '✅ 이번 달 혜택 조건 충족(기록 기준)' : prev.n ? '⚠️ 지난달 기록이 실적에 못 미쳐요' : ''}</span></div>` : ''}
  </div>`;
}

// 통신사 등급·혜택 방식 고르기 (모르면 '모름' → 가장 낮은 등급으로만 계산)
function tierUI() {
  if (!S.carriers.length) return '';
  const app = { SKT: 'T멤버십 앱', KT: 'KT 멤버십(마이케이티) 앱', LGU: 'U+멤버십 앱' };
  return `<div class="tiers">${S.carriers.map(code => `<div class="tierrow"><b>${code === 'LGU' ? 'LG U+' : code} 등급</b><div class="fchips wrap">${(CAR_TIERS[code] || []).map(t => `<button type="button" class="chip ${(S.ctier || {})[code] === t ? 'on' : ''}" data-ctier="${code}:${t}">${t}</button>`).join('')}<button type="button" class="chip ${!(S.ctier || {})[code] ? 'on' : ''}" data-ctier="${code}:">모름</button></div>
    ${code === 'SKT' ? `<div class="fchips wrap"><button type="button" class="chip ${(S.cmode || {}).SKT !== 'accrual' ? 'on' : ''}" data-cmode="SKT:discount">할인형</button><button type="button" class="chip ${(S.cmode || {}).SKT === 'accrual' ? 'on' : ''}" data-cmode="SKT:accrual">적립형</button></div>` : ''}</div>`).join('')}
    <p class="hint">등급은 ${S.carriers.map(c => app[c]).join('·')}에서 볼 수 있어요. 모르면 가장 낮은 등급 기준으로만 계산해요.</p></div>`;
}
function renderWallet(onlyResults) {
  const el = $('#viewWallet');
  const q = norm(S.walletQ || '');
  const carrierBtns = [['KT', 'KT'], ['SKT', 'SKT'], ['LGU', 'LG U+']].map(([k, l]) =>
    `<button type="button" data-carrier="${k}" class="${S.carriers.includes(k) ? 'on' : ''}">${l}</button>`).join('')
    + `<button type="button" data-carrier="NONE" class="${!S.carriers.length && store.get('hs_carrierNone', false) ? 'on' : ''}">없음</button>`;
  const whenTxt = (w) => !w ? '' : w.hours ? ` (${w.hours[0]}~${w.hours[1]}시)` : w.days ? ' (주말)' : w.dates ? ' (지정일)' : '';
  const row = (c, withBox) => {
    const exp = isExpired(c);
    const summary = (c.rules || []).slice(0, 2).map(r => (r.brands ? r.brands.slice(0, 3).join('·') + (r.brands.length > 3 ? ' 등' : '') : r.cats ? r.cats.map(x => catOf(x).label).join('·') : '모든 가맹점') + ' ' + ruleLabel(r) + whenTxt(r.when)).join(' / ');
    return `<div class="cardrow"><div class="bd"><button type="button" class="t tlink" data-card="${esc(c.id)}">${esc(c.name)} ›</button>
      <div class="d">${esc(c.issuer || '')} ${esc(c.type || '')} ${trustBadge(c)}${exp ? ' · ⚠️ 확인 기한 지남' : ''}${cardWho(c) ? ` · ${esc(cardWho(c))}` : ''}<br>${esc(summary)}${condsOf(c).length ? ` · <span class="muted">조건: ${esc(condsOf(c).join(', '))}</span>` : ''}${withBox && c.prevMin ? (() => { const ps = prevState(c); return ` · ${ps === false ? '⚠️ 지난달 실적 미달' : ps ? '✓ 전월실적 충족' : `전월실적 ${won(c.prevMin)} 확인 전`}`; })() : ''}</div>
      ${withBox ? cardMonthBox(c) : ''}${withBox && (condsOf(c).length || c.cap > 0 || c.prevMin) ? `<button type="button" class="btn sm ghost editc" data-card="${esc(c.id)}">✏️ ${[condsOf(c).length ? '결제 조건' : '', c.prevMin ? '지난달 실적' : '', c.cap > 0 ? '남은 한도' : ''].filter(Boolean).join('·')} 고치기</button>` : ''}</div>
      <button type="button" class="toggle ${S.owned.has(c.id) ? 'on' : ''}" data-own="${esc(c.id)}" aria-label="${esc(c.name)} 보유"></button></div>`;
  };
  const catRow = (c) => `<div class="cardrow"><div class="bd"><div class="t">${esc(c.name)}</div>
      <div class="d">${esc(c.issuer)} ${esc(c.type)} · <span class="muted">혜택 확인 전</span> · <a href="${esc(c.infoUrl)}" target="_blank" rel="noopener">혜택 보기</a></div></div>
      <button type="button" class="btn sm ghost" data-catadd="${esc(c.id)}">내 카드로</button></div>`;

  // 카드사·종류 필터
  const pool = [...(DATA.cards || []).map(c => ({ ...c, _v: true })), ...CATALOG];
  const issuers = ['전체', ...Array.from(new Set(pool.map(c => c.issuer))).sort((a, b) => a.localeCompare(b, 'ko'))];
  const okI = (c) => S.walletIssuer === '전체' || c.issuer === S.walletIssuer;
  const okT = (c) => S.walletType === '전체' || (c.type || '').startsWith(S.walletType);
  const okQ = (c) => matchQ(q, c.name + ' ' + c.issuer);
  const verified = (DATA.cards || []).filter(c => !S.owned.has(c.id) && okI(c) && okT(c) && okQ(c));
  const unverified = CATALOG.filter(c => okI(c) && okT(c) && okQ(c));
  const filtering = q || S.walletIssuer !== '전체' || S.walletType !== '전체';

  const owned = ownedCards();
  // 지역화폐·상품권
  const localRow = (lc) => {
    const set = S.locals[lc.id] || {};
    const exp = isExpired(lc);
    return `<div class="cardrow"><div class="bd"><div class="t">🪙 ${esc(lc.name)}</div>
      <div class="d">${lc.regions.includes('*') ? '전국' : esc(lc.regions.join('·'))} · ${lc.rate && !exp ? `기본 ${pct(lc.rate)}${lc.cap ? ` · 한 달 최대 ${won(lc.cap)}까지 혜택` : ''}` : `${esc(lcShortNote(lc))} · 할인율을 넣으면 계산돼요`}${exp ? ' · ⚠️ 확인 기한 지남' : ''}
      <br><span class="muted">${esc(lc.note || '')}</span>${lc.src ? ` · <a href="${esc(lc.src)}" target="_blank" rel="noopener">출처</a>` : ''}</div>
      ${set.on ? `<label class="lrate">내 할인율 <input type="number" inputmode="decimal" min="0" max="30" step="0.5" data-lrate="${esc(lc.id)}" value="${set.rate || ''}" placeholder="${lc.rate && !exp ? lc.rate : '예: 10'}">%</label>` : ''}</div>
      <button type="button" class="toggle ${set.on ? 'on' : ''}" data-local="${esc(lc.id)}" aria-label="${esc(lc.name)} 사용"></button></div>`;
  };
  // 켠 것 + 내 지역 + 온누리만 먼저, 나머지는 접어 둠
  const here = localsForHere();
  const top = localList().filter(lc => (S.locals[lc.id] || {}).on || lc.regions.includes('*') || here.includes(lc) || (!here.length && lc.rate));
  const rest = localList().filter(lc => !top.includes(lc));
  const locals = top.map(localRow).join('') + (rest.length ? `<details class="more"><summary>다른 지역 ${rest.length}곳 보기</summary><div class="rows">${rest.map(localRow).join('')}</div></details>` : '');

  // 결제 기록
  const mk = monthKey();
  const monthLog = S.ledger.filter(e => e.month === mk);
  const monthSaved = monthLog.reduce((a, e) => a + e.disc, 0);
  const recent = S.ledger.slice(-30).reverse();
  const nameOf = (id) => (allCards().find(c => c.id === id) || localList().find(l => l.id === id) || { name: id === 'etc' ? '현금·기타' : '삭제된 결제수단' }).name;

  const html = `
    <div class="section"><button class="btn ghost block" type="button" data-act="onboard">⚡ 3단계로 빠르게 설정하기</button>
      <div class="wtools"><button type="button" class="btn sm ${S.big ? 'green' : 'ghost'}" data-act="bigtext">🔠 큰 글씨 ${S.big ? '켜짐' : '켜기'}</button>
      <button type="button" class="btn sm ghost" data-act="backup">📦 백업 저장</button><button type="button" class="btn sm ghost" data-act="restore">📥 백업 불러오기</button></div>
      <p class="hint" style="margin-top:8px">휴대폰을 바꾸거나 앱을 지우기 전에 [백업 저장]을 눌러 두세요. 회원가입 없이 파일(또는 코드)로 옮겨요.</p></div>
    <div class="section"><h3>통신사 멤버십</h3><p class="hint">휴대폰이 여러 대면 여러 개 고를 수 있어요.</p><div class="carriers">${carrierBtns}</div>${tierUI()}</div>
    <div class="section"><h3>내가 쓰는 간편결제</h3><p class="hint">고르면 "KB Pay로 결제하면 할인"처럼 그 결제수단이 필요한 카드 할인을 바로 계산해요.</p>
      <div class="fchips wrap">${PAYS.map(p => `<button type="button" class="chip ${S.pays.includes(p) ? 'on' : ''}" data-pay="${esc(p)}">${S.pays.includes(p) ? '✓ ' : ''}${esc(p)}</button>`).join('')}</div></div>

    <div class="section"><h3>내 카드 ${owned.length ? `<span class="pill green">${owned.length}장</span>` : ''}</h3>
      ${owned.length ? `<div class="rows">${owned.map(c => row(c, true)).join('')}</div><p class="hint">카드 이름이나 [✏️ 고치기]를 누르면 KB Pay 결제·팩 선택, 지난달 실적, 실제 남은 한도를 고칠 수 있어요.</p>` : '<p class="hint">아래 [＋ 카드 추가하기]에서 가진 카드를 찾아 켜 주세요.</p>'}
      ${!S.walletAdd && !filtering ? `<button class="btn green block" type="button" data-act="walletadd" style="margin-top:8px">＋ 카드 추가하기</button>` : ''}
    </div>

    ${S.walletAdd || filtering ? `<div class="section"><h3>카드 추가하기 <span class="pill">${(DATA.cards || []).length + CATALOG.length}종</span> <button type="button" class="linkbtn" data-act="walletadd" style="float:right">접기</button></h3>
      <input class="search-in" id="walletQ" type="search" placeholder="카드 이름·카드사 (초성 OK: ㅌㅌㅇ)" value="${esc(S.walletQ || '')}" style="margin:4px 0 8px" />
      <div class="fchips">${issuers.map(i => `<button type="button" class="chip ${S.walletIssuer === i ? 'on' : ''}" data-issuer="${esc(i)}">${esc(i)}</button>`).join('')}</div>
      <div class="fchips">${['전체', '신용', '체크'].map(t => `<button type="button" class="chip ${S.walletType === t ? 'on' : ''}" data-ctype="${t}">${t === '전체' ? '신용+체크' : t + '카드'}</button>`).join('')}</div>
      <div id="walletResults">${verified.length ? `<p class="sub-h">✓ 혜택 확인된 카드 · 켜면 바로 계산돼요</p><div class="rows">${verified.map(c => row(c, false)).join('')}</div>` : ''}
      ${filtering && unverified.length ? `<p class="sub-h">혜택 확인 전 카드 · 할인율을 넣으면 계산돼요</p><div class="rows">${unverified.slice(0, 60).map(catRow).join('')}</div>` : ''}
      ${!filtering ? `<p class="hint">카드사를 누르거나 이름을 검색하면 혜택 확인 전 카드 ${CATALOG.length}종도 함께 보여요.</p>` : ''}
      ${filtering && !verified.length && !unverified.length ? '<p class="hint">찾는 카드가 없어요. 아래에서 직접 추가하세요.</p>' : ''}</div>
      <button class="btn ghost block" type="button" data-act="addcard" style="margin-top:8px">＋ 목록에 없는 내 카드 직접 추가</button>
      <p class="hint" style="margin-top:8px">'공식 자료 확인'은 카드사·금융그룹 공식 페이지로 확인한 카드, '2차 자료'는 비교 사이트·기사로 확인해 카드사 확인이 더 필요한 카드예요 (기준일 ${esc((DATA.meta || {}).checkedAt || '-')}).</p>
      <label class="agesel">카드 추천 나이 조건 <select id="ageSel"><option value="">고르지 않음</option><option value="u18" ${S.age === 'u18' ? 'selected' : ''}>만 18세 미만</option><option value="18_29" ${S.age === '18_29' ? 'selected' : ''}>만 18~29세</option><option value="30p" ${S.age === '30p' ? 'selected' : ''}>만 30세 이상</option></select></label>
    </div>` : ''}

    <div class="section"><h3>지역화폐·상품권</h3><p class="hint">쓰는 것을 켜 두면 매장 화면에서 카드와 비교해 줘요. 가맹점 여부는 매장마다 달라 '가맹점일 때' 기준으로 보여 드려요.</p>
      <div class="rows">${locals}</div></div>

    ${recoSection()}
    ${Object.keys(S.favs).length ? `<div class="section"><h3>⭐ 자주 가는 곳 <span class="pill">${Object.keys(S.favs).length}곳</span></h3><div class="rows">${Object.values(S.favs).sort((a, b) => b.t - a.t).map(f => `
      <button class="rowi" type="button" data-favopen="${esc(f.id)}"><div class="bd"><div class="t">${esc(f.name)}</div><div class="d">${esc(f.address || catOf(f.category).label)}</div></div><div class="r">›</div></button>`).join('')}</div>
      <p class="hint">할인·행사가 바뀌면 앱을 열 때 알려 드려요.${NATIVE.on ? ' 알림을 켜 두면 토요일 오전에 한 번 챙겨 드려요.' : ''}</p></div>` : ''}

    ${(() => { const rp = monthReport(); return `<div class="section report"><h3>${+rp.mk.slice(5)}월 절약 리포트</h3>
      <div class="rep-big">${won(rp.saved)}</div><p class="hint">예상 절약 · 결제 ${rp.n}건 · ${won(rp.spend)} 중 (내가 기록한 결제의 예상 혜택 합계, 통신사 할인 포함 · 실제 청구·캐시백은 카드사 앱에서 확인)${rp.top ? ` · 최고 절약 ${esc(rp.top.name)}` : ''}${rp.actualN ? `<br>✓ 실제 받은 것으로 확인한 혜택 ${won(rp.actual)} (${rp.actualN}건)` : ''}</p>
      <div class="rep-act">${rp.n ? `<button class="btn green" type="button" data-act="sharereport">자랑하기·공유</button>` : ''}
      <button class="btn ghost" type="button" data-act="notify">${S.notify ? '🔔 월말 알림 켜짐' : '🔕 월말 알림 받기'}</button></div>
      ${NATIVE.on ? '' : '<p class="hint" style="margin-top:6px">월말 알림은 앱 버전에서 받을 수 있어요.</p>'}</div>`; })()}

    <div class="section"><h3>결제 기록 ${monthLog.length ? `<span class="pill green">이번 달 ${won(monthSaved)} 아낌</span>` : ''}</h3>
      ${recent.length ? `<div class="rows">${recent.map(e => `<div class="rowi"><div class="bd"><div class="t">${esc(e.storeName)}</div>
        <div class="d">${new Date(e.ts).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })} · ${esc(nameOf(e.method))} · ${won(e.amount)}</div></div>
        <div class="r">${e.actual !== undefined ? `<span title="실제 받은 혜택">✓ -${won(e.actual)}</span>` : e.disc ? '예상 -' + won(e.disc) : '-'} <button type="button" class="x" data-editlog="${e.ts}" aria-label="기록 고치기">${IPEN}</button><button type="button" class="x" data-dellog="${e.ts}" aria-label="기록 삭제">${IX}</button></div></div>`).join('')}</div>`
        : '<p class="hint">매장 화면에서 [이렇게 결제했어요]를 누르면 쌓여요. 카드별 남은 한도와 전월실적 진행률이 계산돼요.</p>'}
      ${S.ledger.length ? `<button class="btn ghost block" type="button" data-act="clearlog" style="margin-top:8px">기록 전체 지우기</button>` : ''}
    </div>

    <div class="section info"><h3>카드사 결제내역 자동 불러오기</h3>
      <p class="hint">본인인증으로 모든 카드와 사용내역을 자동으로 가져오는 기능은 금융위원회 <b>본인신용정보관리업(마이데이터) 허가</b>를 받은 사업자만 제공할 수 있어요. 여긴할인에는 이 기능이 없어요. 위의 결제 기록은 내가 남긴 것만 반영하므로, 다른 곳에서 쓴 결제·취소·환불·실적 제외 항목은 모를 수 있어요. 그래서 남은 한도와 전월실적은 '기록 기준 추정'이고, 카드 화면에서 실제 남은 한도를 고칠 수 있어요.</p></div>

    <div class="section"><button class="btn ghost block danger" type="button" data-act="wipe">🗑 내 지갑 비우기 (이 기기의 카드·통신사·지역화폐·기록·⭐ 모두 삭제)</button></div>

    ${(POINTS.programs || []).map(pg => { const auto = (pg.cards || []).some(id => S.owned.has(id));
      return `<div class="section"><h3>💳 ${esc(pg.name)}</h3>${auto ? `<p class="hint">가진 카드로 ${esc(pg.name)}를 쓸 수 있어요. 사용 가능한 매장(${Object.keys(pg.merchants || {}).length}곳 브랜드)에 '💳 ${esc(pg.name.replace(/^현대카드 /, ''))} ○% 사용'으로 표시해요.</p>`
        : `<label class="hint" style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-ptprog="${esc(pg.id)}" ${store.get('hs_pt_' + pg.id, false) ? 'checked' : ''}> ${esc(pg.name)}를 쓰는 ${esc(pg.issuer)}가 있어요 <span class="muted">(목록에 없는 카드일 때)</span></label>`}</div>`; }).join('')}
    <div class="section"><label class="hint" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="statsOk" ${store.get('hs_statsOk', false) ? 'checked' : ''}> 익명 사용 통계 보내기 (선택) <span class="muted">(어떤 기능을 눌렀는지 숫자만 · 위치·카드·기기 정보 없음)</span></label></div>
    <p class="foot">카드·통신사·지역화폐 선택과 결제 기록은 이 기기에만 저장되고 서버로 보내지 않아요. · <a href="/terms.html">이용약관</a> · <a href="/privacy.html">개인정보 처리방침</a> · <a href="/location-terms.html">위치기반서비스 이용약관</a></p>`;
  // 검색 중에는 검색 결과 부분만 바꿈 → 입력칸을 다시 그리지 않아 한글 입력(초성)이 끊기거나 오타 나지 않음
  if (onlyResults && $('#walletResults')) { swapPart(html, 'walletResults'); return; }
  el.innerHTML = html;
}
function swapPart(html, id) {
  const t = document.createElement('template'); t.innerHTML = html;
  const src = t.content.getElementById(id), dst = document.getElementById(id);
  if (src && dst) dst.innerHTML = src.innerHTML;
}

function renderTabbar() {
  $$('.tabbar button').forEach(b => b.classList.toggle('on', b.dataset.tab === (S.tab === 'store' ? S.prevTab : S.tab)));
  const n = ownedCards().length + S.carriers.length + localList().filter(l => (S.locals[l.id] || {}).on).length;
  const cnt = $('#walletCnt'); cnt.textContent = n; cnt.classList.toggle('hidden', !n);
  $('#locLabel').textContent = S.center ? S.center.label || '선택한 위치' : '위치를 정해 주세요';
  $('#catChips').classList.toggle('hidden', S.tab === 'wallet' || S.tab === 'store');
}
function renderAll() {
  renderChips(); renderStatus(); renderList(); renderTabbar();
  if (S.tab === 'store') renderStore();
  if (S.tab === 'wallet') renderWallet();
  if (S.tab === 'map') renderMap();
  updateHeaderH();
}
function setTab(t) {
  if (t !== 'store') S.prevTab = t;
  S.tab = t;
  $$('.view').forEach(v => v.classList.remove('on'));
  $({ list: '#viewList', map: '#viewMap', wallet: '#viewWallet', store: '#viewStore' }[t]).classList.add('on');
  window.scrollTo(0, 0);
  renderAll();
}
// 매장 화면을 열면 주소창도 그 매장 주소(?s=…&at=…)로 바뀜 → 복사·공유·새로고침해도 같은 매장이 열리고, 뒤로가기는 목록으로
function storePath(st) { return `/?s=${encodeURIComponent(st.id)}&n=${encodeURIComponent(st.name)}&at=${st.lat.toFixed(5)},${st.lng.toFixed(5)}`; }
function openStore(id) {
  S.exclAmt = 0;   // 제외 상품 금액은 매장마다 새로
  S.selectedId = id;
  const st = S.stores.find(x => x.id === id);
  track('store', st ? (BRANDS.some(b => b[0] === st.brand) ? st.brand : (st.category || '')) : '');
  const url = st ? storePath(st) : location.pathname + location.search;
  if (S.tab !== 'store') history.pushState({ v: 'store' }, '', url); else history.replaceState(history.state, '', url);
  setTab('store');
}
function setListUrl(q) { try { history.replaceState(history.state, '', q ? `/?q=${encodeURIComponent(q)}` : '/'); } catch (e) {} }
function updateHeaderH() {
  document.documentElement.style.setProperty('--header-h', $('#topbar').offsetHeight + 'px');
}

// ---------- 바텀시트 ----------
// 아래에서 올라오는 창: 닫기(✕) 버튼·Esc 키·바깥 누르기로 닫힘. 열면 창 안으로 초점, 닫으면 원래 버튼으로 초점 복귀
function openSheet(html) {
  const sh = $('#sheet'), wasOpen = !sh.classList.contains('hidden');
  if (!wasOpen) S._sheetReturn = document.activeElement;
  sh.innerHTML = '<div class="grab"></div><button type="button" class="sheet-x" data-close="1" aria-label="닫기">'+IX+'</button>' + html;
  sh.setAttribute('tabindex', '-1');
  sh.classList.remove('hidden'); $('#dim').classList.remove('hidden');
  if (!wasOpen) history.pushState({ v: 'sheet' }, '');
  try { sh.focus({ preventScroll: true }); } catch (e) {}
}
function closeSheet(fromPop) {
  if ($('#sheet').classList.contains('hidden')) return;
  $('#sheet').classList.add('hidden'); $('#dim').classList.add('hidden');
  if (!fromPop) { S._ignorePop = true; history.back(); }
  const r = S._sheetReturn; S._sheetReturn = null;
  if (r && document.contains(r)) try { r.focus({ preventScroll: true }); } catch (e) {}
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#sheet').classList.contains('hidden')) closeSheet(); });
function cardSheet(id) {
  const c = allCards().find(x => x.id === id); if (!c) return;
  const st = S.stores.find(s => s.id === S.selectedId);
  const owned = S.owned.has(c.id);
  const d = st ? cardDiscount(c, st, Math.max(0, Number(S.amount) || 0), new Date(), owned ? {} : { ignoreUsed: true }) : null;
  const rules = (c.rules || []).map(r => `<div class="rowi"><div class="bd"><div class="t">${r.all ? '모든 가맹점' : esc((r.brands || []).join(', ') || (r.cats || []).map(x => catOf(x).label).join(', '))}</div>
    <div class="d">${[r.via ? r.via + '로 결제할 때만' : '', r.opt ? r.opt + ' 선택 시' : '', r.min ? '건당 ' + won(r.min) + ' 이상' : '', typeof r.cap === 'number' && r.cap > 0 ? '이 혜택 월 한도 ' + won(r.cap) : '', r.note || ''].filter(Boolean).map(esc).join(' · ')}</div></div><div class="r">${ruleLabel(r)}</div></div>`).join('');
  const conds = condsOf(c);
  const mine = S.cardConds[c.id] || [];
  const rem = owned ? cardRemaining(c) : null;
  const fix = S.capFix[c.id] && S.capFix[c.id].month === monthKey();
  openSheet(`<h3>${esc(c.name)}</h3><p>${esc(c.issuer || '')} ${esc(c.type || '')}${c.status ? ' · ' + esc(c.status) : ''} · ${esc(KIND_LABEL[c.kind] || '')} ${trustBadge(c)}</p>
    ${d ? `<div class="kv"><div><span>입력한 조건 기준 이 매장 예상</span><b>${d.disc > 0 ? (isCashCard(c) ? '-' : '+') + won(d.disc) : d.excluded ? '결제 불가' : '없음'}</b></div>
      <div><span>카드 전체 월 한도</span><b>${c.cap > 0 ? won(c.cap) : c.cap === 0 ? '없음' : '카드사 확인'}</b></div></div>
      ${d.cond ? `<p class="hintx light">💳 ${d.cond.need.map(condText).map(esc).join('·')}하면 -${won(d.cond.disc)}</p>` : ''}` : ''}
    ${conds.length && owned ? `<div class="conds"><b>내가 쓰는 방식</b> <span class="muted">(체크한 조건만 할인 예상에 넣어요)</span>
      ${conds.map(k => `<button type="button" class="chip ${mine.includes(k) ? 'on' : ''}" data-cond="${esc(c.id)}|${esc(k)}">${mine.includes(k) ? '✓ ' : ''}${esc(condText(k))}해요</button>`).join('')}</div>` : ''}
    ${owned && c.prevMin ? (() => { const ps = prevState(c); return `<div class="conds"><b>지난달 실적 ${won(c.prevMin)}</b> <span class="muted">${ps === 'ledger' ? '(결제 기록 기준 충족)' : ps === null ? '(아직 모름 · 할인은 조건부로 보여요)' : ''}</span>
      <button type="button" class="chip ${ps === true ? 'on' : ''}" data-prev="${esc(c.id)}:1">${ps === true ? '✓ ' : ''}채웠어요</button><button type="button" class="chip ${ps === false ? 'on' : ''}" data-prev="${esc(c.id)}:0">${ps === false ? '✓ ' : ''}못 채웠어요</button></div>`; })() : ''}
    <div class="rows">${rules}</div>
    ${owned && c.cap > 0 ? `<div class="capfix"><div><b>이번 달 남은 한도 (추정)</b> ${won(rem)}${fix ? ' · 내가 고친 값 기준' : ' · 이 앱에 기록한 결제만 반영'}</div>
      <label>카드사 앱에서 본 실제 남은 한도 <input id="capFixIn" type="number" inputmode="numeric" min="0" step="100" placeholder="${rem}"> 원</label>
      <button type="button" class="btn sm" data-capfix="${esc(c.id)}">고치기</button></div>` : ''}
    ${c.minSpend ? `<p>📌 ${esc(c.minSpend)}</p>` : ''}${c.payMethod ? `<p>💳 ${esc(c.payMethod)}</p>` : ''}${cardWho(c) ? `<p>🎂 ${esc(cardWho(c))}</p>` : ''}
    ${c.src ? `<p style="font-size:12px">확인일 ${esc(c.checked)} · 확인 기한 ${esc(c.reviewBy)} · <a href="${esc(c.src)}" target="_blank" rel="noopener">출처</a>${srcTrust(c) !== 'official' && ISSUER_HOME[c.issuer] ? ` · <a href="${esc(ISSUER_HOME[c.issuer])}" target="_blank" rel="noopener">카드사 홈페이지에서 확인</a>` : ''}</p>` : c.custom ? `<p style="font-size:12px">${(c.rules || []).length ? '내가 직접 입력한 할인율이에요.' : '아직 할인율을 넣지 않은 카드예요. 「할인율 고치기」로 넣으면 계산돼요.'}</p>` : ''}
    <div class="actions">
      <button class="btn ghost" type="button" data-close="1">닫기</button>
      <button class="btn ${owned ? 'ghost' : 'green'}" type="button" data-own="${esc(c.id)}" data-close="1">${owned ? '내 지갑에서 빼기' : '내 지갑에 담기'}</button>
      ${c.custom ? `<button class="btn ghost" type="button" data-editcard="${esc(c.id)}">할인율 고치기</button><button class="btn ghost" type="button" data-delcard="${esc(c.id)}">삭제</button>` : ''}
    </div>`);
}
function toggleCond(cardId, k) {
  const cur = new Set(S.cardConds[cardId] || []);
  cur.has(k) ? cur.delete(k) : cur.add(k);
  // 같은 카드의 팩·옵션은 하나만 (A팩을 고르면 B팩은 해제)
  const card = allCards().find(c => c.id === cardId);
  if (cur.has(k) && card) { const optSet = new Set((card.rules || []).map(r => r.opt).filter(Boolean)); if (optSet.has(k)) optSet.forEach(o => { if (o !== k) cur.delete(o); }); }
  S.cardConds[cardId] = [...cur]; if (!S.owned.has(cardId) && cur.size) S.owned.add(cardId);
  saveWallet(); renderAll();
  if ($('#sheet') && !$('#sheet').classList.contains('hidden') && $('#sheet [data-cond]')) cardSheet(cardId);
  toast(cur.has(k) ? `${condText(k)}할 때 할인을 예상에 넣어요.` : '조건을 해제했어요.');
}
function eventSheet(i) {
  const st = S.stores.find(s => s.id === S.selectedId); if (!st) return;
  const e = storeEvents(st.brand)[i]; if (!e) return;
  openSheet(`<span class="pill ${e.type === 'tip' ? 'blue' : e.type === 'promo' ? 'red' : 'amber'}">${esc(e.badge)}</span><h3 style="margin-top:8px">${esc(e.title)}</h3>${e.when ? `<p><b>📅 ${esc(e.when)}</b></p>` : ''}${e.carrier && !S.carriers.includes(e.carrier) ? `<p style="font-size:13px">ℹ️ ${esc(e.carrier)} 멤버십 회원만 받을 수 있어요.</p>` : ''}
    <div class="kv"><div><span>혜택</span><b>${esc(e.est)}</b></div><div><span>확인일</span><b>${esc(e.checked || '-')}</b></div></div>
    <p>📌 ${esc(e.condition)}</p><p>👆 ${esc(e.howTo)}</p>${e.src ? `<p style="font-size:12px"><a href="${esc(e.src)}" target="_blank" rel="noopener">출처 보기</a></p>` : ''}
    <div class="actions"><button class="btn" type="button" data-close="1">닫기</button></div>`);
}
// 🔥 프랜차이즈 이벤트 모아보기: 진행 중 + 곧 시작/다음 예정. 가까운 매장이 있으면 바로 열기
function promosSheet() {
  const all = PROMOS.map(p => ({ p, n: promoNext(p) })).filter(x => x.n);
  const near = (p) => S.stores.filter(s => p.brands.includes(s.brand)).sort((a, b) => a.distance - b.distance)[0];
  const row = ({ p, n }) => { const st = near(p);
    return `<div class="rowi"><div class="bd"><div class="t">${esc(p.brands.join('·'))} · ${esc(p.title)}</div>
      <div class="d"><b>${esc(promoWhen(p, n))}</b> · ${esc(p.cond)}${p.carrier ? ` · <b>${esc(p.carrier)} 회원만</b>` : ''}</div>
      <div class="d">👆 ${esc(p.howTo)} · <a href="${esc(p.src)}" target="_blank" rel="noopener">출처</a></div>
      ${st ? `<div class="promo-act"><button type="button" class="linkbtn" data-store="${esc(st.id)}" data-close="1">📍 가장 가까운 ${esc(st.name)} (${dist(st.distance)})</button></div>` : ''}</div>
      <div class="r"><span class="pill ${n.today ? 'red' : 'amber'}">${esc(p.est)}</span></div></div>`; };
  const notMine = (x) => x.p.carrier && S.carriers.length && !S.carriers.includes(x.p.carrier);   // v38: 다른 통신사 전용은 접어 둠
  const others = all.filter(notMine);
  const now = all.filter(x => x.n.today && !notMine(x)), soon = all.filter(x => !x.n.today && !notMine(x)).sort((a, b) => a.n.days - b.n.days);
  openSheet(`<h3>🔥 프랜차이즈 이벤트</h3><p style="font-size:13px">각 브랜드가 앱·홈페이지에서 직접 하는 행사예요. 매주 월요일에 새 행사를 확인하고, 끝난 행사는 자동으로 사라져요.</p>
    ${now.length ? `<h4>지금 진행 중 (${now.length})</h4><div class="rows">${now.map(row).join('')}</div>` : '<p>지금 진행 중인 행사가 없어요.</p>'}
    ${soon.length ? `<h4 style="margin-top:14px">곧 열려요</h4><div class="rows">${soon.map(row).join('')}</div>` : ''}
    ${others.length ? `<details style="margin-top:14px"><summary>다른 통신사 회원 전용 ${others.length}개 (내 통신사 아님)</summary><div class="rows">${others.map(row).join('')}</div></details>` : ''}
    <p style="font-size:12px;margin-top:10px">매장마다 참여 여부가 다를 수 있어요. 결제 전에 매장이나 브랜드 앱에서 한 번 더 확인하세요.</p>
    <div class="actions"><button class="btn" type="button" data-close="1">닫기</button></div>`);
}
function addCardSheet(pre, edit) {
  S.editCardId = edit && pre ? pre.id : null;
  const rv = (k) => { if (!edit || !pre) return ''; const r = (pre.rules || []).find(x => k === 'all' ? x.all : (x.cats || []).includes(k)); return r ? r.rate : ''; };
  const catInputs = [['cafe', '카페'], ['cvs', '편의점'], ['mart', '대형마트'], ['drugstore', 'H&B·생활'], ['bakery', '베이커리'], ['dining', '외식'], ['culture', '영화·서점'], ['fuel', '주유']]
    .map(([k, l]) => `<label>${l} 할인율(%)<input type="number" inputmode="decimal" min="0" max="90" step="0.1" data-rate="${k}" placeholder="0" value="${rv(k)}"></label>`).join('');
  openSheet(`<h3>${pre ? esc(pre.name) : '내 카드 직접 추가'}</h3><p>카드사 앱·상품설명서에서 확인한 할인율만 넣어 주세요. 이 기기에만 저장돼요. 할인율을 몰라도 저장할 수 있어요.${pre && pre.infoUrl ? ` <a href="${esc(pre.infoUrl)}" target="_blank" rel="noopener">이 카드 혜택 찾아보기 ↗</a>` : ''}</p>
    <div class="form-grid" id="addForm">
      <label class="full">카드 이름<input id="acName" type="text" placeholder="예: 우리 알뜰교통 카드" value="${pre ? esc(pre.name) : ''}"></label>
      <label>카드사<input id="acIssuer" type="text" placeholder="예: 우리카드" value="${pre ? esc(pre.issuer) : ''}"></label>
      <label>종류<select id="acType"><option>신용카드</option><option ${pre && (pre.type || '').startsWith('체크') ? 'selected' : ''}>체크카드</option></select></label>
      <label>전월실적(원)<input id="acPrev" type="number" inputmode="numeric" min="0" step="10000" placeholder="없으면 비워 두기" value="${edit && pre.prevMin ? pre.prevMin : ''}"></label>
      ${catInputs}
      <label>모든 가맹점(%)<input type="number" inputmode="decimal" min="0" max="10" step="0.1" data-rate="all" placeholder="0" value="${rv('all')}"></label>
      <label>월 할인 한도(원)<input id="acCap" type="number" inputmode="numeric" min="0" step="1000" placeholder="모르면 비워 두기" value="${edit && pre.cap ? pre.cap : ''}"></label>
    </div>
    <div class="actions"><button class="btn ghost" type="button" data-close="1">취소</button><button class="btn green" type="button" data-act="savecard">저장</button></div>`);
}
function saveCustomCard() {
  const name = $('#acName').value.trim();
  if (!name) { toast('카드 이름을 넣어 주세요.'); return; }
  const rules = [];
  $$('#addForm [data-rate]').forEach(inp => {
    const v = parseFloat(inp.value); if (!(v > 0)) return;
    rules.push(inp.dataset.rate === 'all' ? { all: true, rate: Math.min(v, 10) } : { cats: [inp.dataset.rate], rate: Math.min(v, 90) });
  });
  const capV = parseInt($('#acCap').value, 10);
  const prevV = parseInt($('#acPrev').value, 10);
  const c = { id: S.editCardId || ('u' + Date.now()), custom: true, name, issuer: $('#acIssuer').value.trim(), type: $('#acType').value, rules, cap: capV > 0 ? capV : null, prevMin: prevV > 0 ? prevV : 0 };
  if (S.editCardId) { S.custom = S.custom.map(x => x.id === c.id ? c : x); S.editCardId = null; closeSheet(); saveWallet(); toast('카드 정보를 고쳤어요.'); renderAll(); return; }
  S.custom.unshift(c); S.owned.add(c.id); saveWallet(); track('cardadd', rules.length ? 'rate' : 'norate');
  closeSheet(); toast(rules.length ? '카드를 추가했어요.' : '혜택을 모르는 카드로 저장했어요. 나중에 할인율을 넣을 수 있어요.'); renderAll();
}
function logPaySheet() {
  const st = S.stores.find(s => s.id === S.selectedId); if (!st) return;
  const amount = Math.max(0, Number(S.amount) || 0);
  const r = calc(st, amount);
  const opts = r.per.filter(x => !x.expired && !x.excluded).sort((a, b) => b.disc - a.disc);
  const def = r.best ? r.best.m.id : (opts[0] ? opts[0].m.id : 'etc');
  openSheet(`<h3>결제 기록 남기기</h3><p>${esc(st.name)} · 이 기기에만 저장돼요.</p>
    <div class="form-grid">
      <label class="full">결제 금액(원)<input id="lgAmt" type="number" inputmode="numeric" min="0" step="100" value="${amount}"></label>
      <label class="full">결제수단<select id="lgMethod">${opts.map(x => `<option value="${esc(x.m.id)}" ${x.m.id === def ? 'selected' : ''}>${esc(x.m.name)}${x.disc ? ` (예상 -${won(x.disc)})` : ''}</option>`).join('')}<option value="etc" ${def === 'etc' ? 'selected' : ''}>현금·기타 카드</option></select></label>
    </div>
    <p style="font-size:12px">${r.car ? `통신사 할인(${esc(r.car.name)}) -${won(r.car.disc)}은 카드 한도와 따로 계산돼요.` : ''}</p>
    <div class="actions"><button class="btn ghost" type="button" data-close="1">취소</button><button class="btn green" type="button" data-act="savelog">저장</button></div>`);
}
function saveLog() {
  const st = S.stores.find(s => s.id === S.selectedId); if (!st) return;
  const amount = Math.max(0, parseInt($('#lgAmt').value, 10) || 0);
  if (!amount) { toast('금액을 넣어 주세요.'); return; }
  const method = $('#lgMethod').value;
  const r = calc(st, amount);
  const x = r.per.find(p => p.m.id === method);
  const now = new Date();
  S.ledger.push({ ts: now.getTime(), month: monthKey(now), storeName: st.name, brand: st.brand, category: st.category, amount, method, disc: x ? x.disc : 0, rule: x && x.idx !== undefined ? x.idx : undefined, carrierDisc: r.car ? r.car.disc : 0, carrierUsed: r.car && (r.car.disc > 0 || r.car.accrue > 0) ? r.car.code : '' });
  saveWallet(); closeSheet(); toast('기록했어요. 남은 한도에 반영돼요.'); renderAll(); scheduleReminders();
}
function editLogSheet(ts) {
  const e = S.ledger.find(x => String(x.ts) === String(ts)); if (!e) return;
  openSheet(`<h3>결제 기록 고치기</h3><p>${esc(e.storeName)} · ${new Date(e.ts).toLocaleDateString('ko-KR')}</p>
    <div class="form-grid">
      <label class="full">결제 금액(원)<input id="leAmt" type="number" inputmode="numeric" min="0" step="100" value="${e.amount}"></label>
      <label class="full">실제 받은 혜택(원) · 카드사 앱에서 확인한 금액<input id="leAct" type="number" inputmode="numeric" min="0" step="10" value="${e.actual !== undefined ? e.actual : ''}" placeholder="모르면 비워 두기 (예상 ${won(e.disc)})"></label>
    </div>
    <p style="font-size:12px">결제를 취소했다면 기록을 지워 주세요(X 버튼). 실제 혜택을 넣으면 남은 한도와 리포트가 그 값으로 바뀌어요.</p>
    <div class="actions"><button class="btn ghost" type="button" data-close="1">취소</button><button class="btn green" type="button" data-act="savelogedit" data-ts="${e.ts}">저장</button></div>`);
  S._editTs = e.ts;
}
function saveLogEdit() {
  const e = S.ledger.find(x => x.ts === S._editTs); if (!e) return;
  const amt = parseInt($('#leAmt').value, 10), act = $('#leAct').value.trim();
  if (amt > 0 && amt !== e.amount) { e.disc = Math.round(e.disc * amt / e.amount); e.carrierDisc = Math.round((e.carrierDisc || 0) * amt / e.amount); e.amount = amt; }
  if (act === '') delete e.actual; else { const v = Math.max(0, parseInt(act, 10) || 0); e.actual = v; e.disc = v; }
  saveWallet(); closeSheet(); renderAll(); toast('기록을 고쳤어요.');
}
// ---------- 백업·기기 옮기기 (서버 없이 파일/코드로) ----------
const BACKUP_KEYS = ['hs_pays', 'hs_owned', 'hs_custom', 'hs_carriers', 'hs_ctier', 'hs_cmode', 'hs_locals', 'hs_ledger', 'hs_favs', 'hs_verified', 'hs_cardconds', 'hs_capfix', 'hs_prevok', 'hs_age', 'hs_big', 'hs_amount', 'hs_radius', 'hs_onboarded', 'hs_mig28'];
function backupCode() {
  const data = { v: 1, t: Date.now(), d: {} };
  BACKUP_KEYS.forEach(k => { const v = localStorage.getItem(k); if (v !== null) data.d[k] = v; });
  return 'HS1:' + btoa(unescape(encodeURIComponent(JSON.stringify(data))));
}
async function exportBackup() {
  const code = backupCode(), name = `여긴할인_백업_${todayStr()}.txt`;
  try {
    if (NATIVE.on && NATIVE.P.Share) { await NATIVE.P.Share.share({ title: '여긴할인 백업', text: code, dialogTitle: '백업 코드 보관하기 (나에게 카톡·메모)' }); toast('백업 코드를 보냈어요. 새 기기에서 [백업 불러오기]에 붙여 넣으세요.'); return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([code], { type: 'text/plain' })); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    try { await navigator.clipboard.writeText(code); } catch (e) {}
    toast('백업 파일을 저장했어요 (코드도 복사됨). 새 기기에서 [백업 불러오기]로 넣으세요.');
  } catch (e) { toast('백업을 만들지 못했어요.'); }
}
function restoreSheet() {
  openSheet(`<h3>📥 백업 불러오기</h3><p style="font-size:13px">저장해 둔 백업 파일을 고르거나, 백업 코드(HS1:로 시작)를 붙여 넣으세요. 지금 이 기기의 설정은 백업 내용으로 바뀌어요.</p>
    <input type="file" id="bkFile" accept=".txt,text/plain" style="margin:8px 0">
    <textarea id="bkCode" rows="4" style="width:100%;box-sizing:border-box" placeholder="HS1:…"></textarea>
    <div class="actions"><button class="btn ghost" type="button" data-close="1">취소</button><button class="btn green" type="button" data-act="dorestore">불러오기</button></div>`);
  $('#bkFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) $('#bkCode').value = (await f.text()).trim(); });
}
function doRestore() {
  const raw = ($('#bkCode').value || '').trim();
  try {
    if (!raw.startsWith('HS1:')) throw new Error('form');
    const data = JSON.parse(decodeURIComponent(escape(atob(raw.slice(4)))));
    if (!data || !data.d) throw new Error('form');
    Object.entries(data.d).forEach(([k, v]) => { if (BACKUP_KEYS.includes(k)) localStorage.setItem(k, v); });
    closeSheet(); toast('백업을 불러왔어요. 화면을 새로 열어요.'); setTimeout(() => location.reload(), 700);
  } catch (e) { toast('백업 코드가 올바르지 않아요. 처음부터 끝까지 그대로 붙여 넣어 주세요.'); }
}
// ---------- 큰 글씨·쉬운 화면 ----------
function applyBig() { document.body.classList.toggle('big', !!S.big); }
function wipeWallet() {
  ['hs_owned', 'hs_custom', 'hs_carriers', 'hs_ctier', 'hs_cmode', 'hs_locals', 'hs_ledger', 'hs_favs', 'hs_favnews', 'hs_verified', 'hs_cardconds', 'hs_capfix', 'hs_age', 'hs_reported', 'hs_amount', 'hs_lastLoc'].forEach(k => { try { localStorage.removeItem(k); } catch (x) {} });
  try { Object.keys(localStorage).filter(k => k.startsWith('hs_cache_') || k.startsWith('hs_xcache_')).forEach(k => localStorage.removeItem(k)); } catch (x) {}
  S.owned = new Set(); S.custom = []; S.carriers = []; S.ctier = {}; S.cmode = {}; S.locals = {}; S.ledger = []; S.favs = {}; S.favNews = []; S.verified = {}; S.cardConds = {}; S.capFix = {}; S.age = '';
  renderAll(); toast('이 기기에 저장된 내 지갑 정보를 모두 지웠어요.');
}
function localSheet(id) {
  const lc = localList().find(l => l.id === id); if (!lc) return;
  openSheet(`<h3>🪙 ${esc(lc.name)}</h3><p>${lc.regions.includes('*') ? '전국' : esc(lc.regions.join('·'))} · ${esc(lc.kind || '')}</p>
    <p>${esc(lc.note || '')}</p>
    <p>📌 가맹점(소상공인 매장 등)에서만 쓸 수 있어요. 대형마트·대기업 직영점은 보통 안 돼요. 결제 전 매장에 '${esc(lc.name)}' 가능 여부를 확인하세요.</p>
    ${lc.src ? `<p style="font-size:12px">확인일 ${esc(lc.checked || '-')} · <a href="${esc(lc.src)}" target="_blank" rel="noopener">출처</a></p>` : ''}
    <div class="actions"><button class="btn" type="button" data-close="1">닫기</button></div>`);
}
function reportSheet() {
  const st = S.stores.find(s => s.id === S.selectedId);
  openSheet(`<h3>틀린 정보 알려주기</h3><p>${st ? esc(st.name) : ''}</p>
    <select id="rpReason" style="margin-top:8px">
      <option>카드 할인율·조건이 달라요</option><option>통신사 할인이 안 돼요</option><option>매장 혜택이 끝났어요</option>
      <option>매장이 없어졌거나 위치가 달라요</option><option>있는 매장이 검색되지 않아요</option><option>기타</option>
    </select>
    <textarea id="rpDetail" rows="3" placeholder="어떻게 다른지 적어 주세요 (선택)" style="margin-top:8px"></textarea>
    <div class="actions"><button class="btn ghost" type="button" data-close="1">취소</button><button class="btn" type="button" data-act="sendreport">보내기</button></div>`);
}
async function sendReport() {
  const st = S.stores.find(s => s.id === S.selectedId);
  const payload = { benefit_id: st ? st.brand : '', reason: $('#rpReason').value, detail: `${st ? st.name + ' | ' + (st.address || '') + ' | ' : ''}${$('#rpDetail').value.trim()}`.slice(0, 1000) };
  let ok = false;
  // 여긴할인 서버가 열려 있으면 서버로 (자동 점검 작업이 모아서 확인)
  if (SERVER !== null) {
    try { const r = await fetchT(`${SERVER}/api/report`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload) }, 6000); ok = r.ok; } catch (e) {}
  }
  if (!ok && CONFIG.supabaseUrl && CONFIG.supabaseKey) {
    try {
      const r = await fetchT(`${CONFIG.supabaseUrl}/rest/v1/benefit_reports`, { method: 'POST', headers: { apikey: CONFIG.supabaseKey, Authorization: `Bearer ${CONFIG.supabaseKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify(payload) });
      ok = r.ok;
    } catch (e) {}
  }
  closeSheet();
  if (ok) toast('고마워요! 확인 후 고칠게요.');
  else if (CONFIG.contactEmail) location.href = `mailto:${CONFIG.contactEmail}?subject=${encodeURIComponent('[여긴할인 제보] ' + payload.reason)}&body=${encodeURIComponent(payload.detail)}`;
  else toast('제보 서버가 아직 연결되지 않았어요. (운영자 설정 필요)');
}

// =====================================================================
// 8. 지도 (Leaflet + OpenStreetMap)
// =====================================================================
const MAP = { m: null, layer: null, meLayer: null, lastCenter: null, ready: false, kind: '' };
let ML = null;   // 지도 도구: 카카오 지도(키가 있으면) 또는 Leaflet+오픈스트리트맵
// 카카오 지도를 Leaflet과 같은 방식으로 쓰게 해 주는 얇은 연결 (아래 지도 코드를 그대로 씀)
function kakaoShim() {
  const k = kakao.maps;
  const toLv = (z) => Math.max(1, Math.min(14, 20 - Math.round(z)));
  function KMap(id) { this.k = new k.Map(document.getElementById(id), { center: new k.LatLng(37.5665, 126.978), level: 4 }); }
  KMap.prototype.setView = function (c, z) { const a = Array.isArray(c) ? c : [c.lat, c.lng]; if (z) this.k.setLevel(toLv(z)); this.k.setCenter(new k.LatLng(a[0], a[1])); return this; };
  KMap.prototype.panTo = function (c) { this.k.panTo(new k.LatLng(c[0], c[1])); };
  KMap.prototype.getCenter = function () { const c = this.k.getCenter(); return { lat: c.getLat(), lng: c.getLng() }; };
  KMap.prototype.getZoom = function () { return 20 - this.k.getLevel(); };
  KMap.prototype.project = function (ll, z) { const sc = 256 * Math.pow(2, z), sn = Math.sin(ll[0] * Math.PI / 180); return { x: (ll[1] + 180) / 360 * sc, y: (0.5 - Math.log((1 + sn) / (1 - sn)) / (4 * Math.PI)) * sc }; };
  KMap.prototype.fitBounds = function (b) { const bb = new k.LatLngBounds(); b.pts.forEach(p => bb.extend(new k.LatLng(p[0], p[1]))); this.k.setBounds(bb); };
  KMap.prototype.invalidateSize = function () { const c = this.k.getCenter(); this.k.relayout(); this.k.setCenter(c); };
  KMap.prototype.zoomBy = function (d) { this.k.setLevel(Math.max(1, Math.min(14, this.k.getLevel() - d)), { animate: true }); };
  KMap.prototype.on = function (ev, f) { k.event.addListener(this.k, { moveend: 'idle', click: 'click', zoomend: 'zoom_changed' }[ev], f); };
  function Group() { this.items = []; } Group.prototype.addTo = function (m) { this.map = m; return this; };
  Group.prototype.clearLayers = function () { this.items.forEach(o => o.setMap(null)); this.items = []; };
  function Marker(ll, o) { this.ll = ll; this.o = o || {}; this.h = null; }
  Marker.prototype.on = function (ev, f) { this.h = f; return this; };
  Marker.prototype.addTo = function (g) {
    const ic = this.o.icon, el = document.createElement('div'); el.innerHTML = ic.html;
    if (this.o.interactive !== false) el.addEventListener('click', (e) => { e.stopPropagation(); this.h && this.h(e); });
    const ov = new k.CustomOverlay({ position: new k.LatLng(this.ll[0], this.ll[1]), content: el, xAnchor: ic.iconAnchor[0] / ic.iconSize[0], yAnchor: ic.iconAnchor[1] / ic.iconSize[1], zIndex: 10 + (this.o.zIndexOffset || 0), clickable: true });
    ov.setMap(g.map.k); g.items.push(ov); return this;
  };
  return { map: (id) => new KMap(id), layerGroup: () => new Group(), marker: (ll, o) => new Marker(ll, o), divIcon: (o) => o,
    latLngBounds: (pts) => { const la = pts.reduce((a, p) => a + p[0], 0) / pts.length, ln = pts.reduce((a, p) => a + p[1], 0) / pts.length; return { pts, getCenter: () => [la, ln], pad() { return this; } }; },
    DomEvent: { stopPropagation() {} } };
}
// 대체 지도(오픈스트리트맵용 Leaflet)는 필요할 때만 받음 → 카카오 지도가 되면 외부로 나가는 접속이 줄어듦
function loadLeaflet() {
  if (MAP.leafletTried) return; MAP.leafletTried = true;
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'; document.head.appendChild(css);
  const sc = document.createElement('script'); sc.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  sc.onload = () => { if (S.tab === 'map') renderMap(); };
  sc.onerror = () => { MAP.leafletFail = true; if (S.tab === 'map') renderMap(); };
  document.head.appendChild(sc);
}
function loadKakaoMap() {
  if (MAP.kakaoTried || !CONFIG.kakaoJsKey) return;
  MAP.kakaoTried = true;
  const sc = document.createElement('script');
  sc.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(CONFIG.kakaoJsKey)}&autoload=false`;
  sc.onload = () => { try { if (!window.kakao || !kakao.maps) throw new Error('sdk'); kakao.maps.load(() => { MAP.kakaoReady = true; if (S.tab === 'map') renderMap(); }); } catch (e) { MAP.kakaoFail = true; if (S.tab === 'map') renderMap(); } };
  sc.onerror = () => { MAP.kakaoFail = true; if (S.tab === 'map') renderMap(); };
  document.head.appendChild(sc);
  setTimeout(() => { if (!MAP.kakaoReady) { MAP.kakaoFail = true; if (S.tab === 'map' && !MAP.m) renderMap(); } }, 5000);
}
function initMap() {
  if (MAP.m) return true;
  if (CONFIG.kakaoJsKey && !MAP.kakaoFail) {
    loadKakaoMap();
    if (!MAP.kakaoReady) { const mm = $('#mapMsg'); if (mm) mm.textContent = '지도를 불러오는 중…'; return false; }
    $('#mapMsg') && $('#mapMsg').remove();
    try {
      ML = kakaoShim(); MAP.kind = 'kakao';
      const c0 = S.center || { lat: 37.5665, lng: 126.978 };
      MAP.m = ML.map('map').setView([c0.lat, c0.lng], 16);
    } catch (e) { MAP.m = null; MAP.kakaoFail = true; $('#map').innerHTML = ''; return initMap(); }   // 도메인 미등록 등 → 오픈스트리트맵으로
    MAP.layer = ML.layerGroup().addTo(MAP.m); MAP.meLayer = ML.layerGroup().addTo(MAP.m);
    bindMapEvents();
    return true;
  }
  if (typeof L === 'undefined') { loadLeaflet(); const mm = $('#mapMsg'); if (mm) mm.textContent = MAP.leafletFail ? '지도를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.' : '지도를 불러오는 중…'; return false; }
  $('#mapMsg') && $('#mapMsg').remove();
  ML = L; MAP.kind = 'osm';
  const c = S.center || { lat: 37.5665, lng: 126.978 };
  MAP.m = L.map('map', { zoomControl: false, attributionControl: true }).setView([c.lat, c.lng], 16);
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
  }).addTo(MAP.m);
  // 지도 그림(타일)을 못 받으면 빈 회색 지도를 정상처럼 두지 않고 안내 + 목록으로 보기
  MAP.tileOk = 0; MAP.tileErr = 0;
  tiles.on('tileload', () => { MAP.tileOk++; tileNotice(); });
  tiles.on('tileerror', () => { MAP.tileErr++; tileNotice(); });
  MAP.layer = L.layerGroup().addTo(MAP.m);
  MAP.meLayer = L.layerGroup().addTo(MAP.m);
  bindMapEvents();
  return true;
}
function bindMapEvents() {
  MAP.m.on('moveend', () => {
    if (!S.center) return;
    const ctr = MAP.m.getCenter();
    const moved = haversine(S.center.lat, S.center.lng, ctr.lat, ctr.lng);
    $('#mapRedo').classList.toggle('hidden', moved < 300);
  });
  MAP.m.on('click', () => { if (S.selectedId) { S.selectedId = null; drawMarkers(); renderCarousel(); } });
  MAP.m.on('zoomend', () => drawMarkers());
}
function tileNotice() {
  const bad = MAP.tileErr >= 4 && MAP.tileOk === 0;
  let el = $('#tileWarn');
  if (bad && !el) {
    el = document.createElement('div'); el.id = 'tileWarn'; el.className = 'tilewarn';
    el.innerHTML = '지도 배경을 불러오지 못했어요 (지도 서버 응답 없음). 매장 위치 점은 맞지만 길은 안 보여요. <button type="button" data-tab2="list">목록으로 보기</button>';
    $('#map').parentElement.appendChild(el);
    el.querySelector('button').addEventListener('click', () => setTab('list'));
  } else if (!bad && el) el.remove();
}
function markerHtml(st, sel) {
  const c = catOf(st.category);
  const dot = `<div class="mk" style="background:${c.color}">${c.emoji || '📍'}</div>`;
  return sel ? `<div class="mk-sel"><div class="lab">${esc(st.name)}</div>${dot}</div>` : dot;
}
// 가까운 점끼리 묶어 숫자로 보여 줌(겹침 방지). 묶음을 누르면 확대되고, 크게 확대하면 하나씩 보임. 고른 매장은 항상 따로 강조
function drawMarkers() {
  if (!MAP.m) return;
  MAP.layer.clearLayers();
  const list = filteredStores().list.slice(0, 600);
  const z = MAP.m.getZoom(), cell = z >= 18 ? 0 : 44;
  const groups = new Map();
  list.forEach(st => {
    if (st.id === S.selectedId || !cell) { groups.set('s' + st.id, [st]); return; }
    const p = MAP.m.project([st.lat, st.lng], z);
    const k = Math.floor(p.x / cell) + ':' + Math.floor(p.y / cell);
    if (!groups.has(k)) groups.set(k, []); groups.get(k).push(st);
  });
  groups.forEach(g => {
    if (g.length === 1) {
      const st = g[0], sel = st.id === S.selectedId;
      const icon = ML.divIcon({ className: '', html: markerHtml(st, sel), iconSize: sel ? [180, 72] : [26, 26], iconAnchor: sel ? [90, 70] : [13, 13] });
      const mk = ML.marker([st.lat, st.lng], { icon, zIndexOffset: sel ? 1000 : 0, keyboard: false }).addTo(MAP.layer);
      mk.on('click', (e) => { ML.DomEvent.stopPropagation(e); selectOnMap(st.id, true); });
      return;
    }
    const lat = g.reduce((a, x) => a + x.lat, 0) / g.length, lng = g.reduce((a, x) => a + x.lng, 0) / g.length;
    const sz = g.length >= 100 ? 46 : g.length >= 20 ? 40 : 34;
    const icon = ML.divIcon({ className: '', html: `<div class="mk-cl" style="width:${sz}px;height:${sz}px">${g.length}</div>`, iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] });
    const mk = ML.marker([lat, lng], { icon, keyboard: false }).addTo(MAP.layer);
    mk.on('click', (e) => { ML.DomEvent.stopPropagation(e); const b = ML.latLngBounds(g.map(x => [x.lat, x.lng])); if (z >= 17) MAP.m.setView(b.getCenter(), 18); else MAP.m.fitBounds(b.pad(0.3), { maxZoom: 18 }); });
  });
  MAP.meLayer.clearLayers();
  if (S.me) ML.marker([S.me.lat, S.me.lng], { icon: ML.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false }).addTo(MAP.meLayer);
}
function renderCarousel() {
  const list = filteredStores().list.slice(0, 40);
  const ordered = S.selectedId ? [list.find(s => s.id === S.selectedId), ...list.filter(s => s.id !== S.selectedId)].filter(Boolean) : list;
  $('#carousel').innerHTML = ordered.map(st => {
    const r = calc(st, 10000, { confirmedLocal: true });
    return `<div class="ccard ${st.id === S.selectedId ? 'on' : ''}"><button class="cc-main" type="button" data-cstore="${esc(st.id)}" aria-label="${esc(st.name)} 지도에서 보기">${badge(st)}
      <div class="bd"><div class="t">${esc(st.name)}</div><div class="d">${dist(st.distance)} · ${r.total > 0 ? '1만원 시 -' + won(r.total) : esc(catOf(st.category).label)}</div></div></button>
      <button type="button" class="pill green cc-go" data-store="${esc(st.id)}" aria-label="${esc(st.name)} 상세 보기">상세</button></div>`;
  }).join('');
  $('#carousel').scrollLeft = 0;
}
function selectOnMap(id, pan) {
  S.selectedId = id;
  if (!MAP.m) return;
  const st = S.stores.find(s => s.id === id);
  drawMarkers(); renderCarousel();
  if (st && pan) MAP.m.panTo([st.lat, st.lng]);
}
function renderMap() {
  if (!initMap()) return;
  // v38: 처음 들어올 때 회색 화면 방지 — 화면 크기가 정해진 뒤 여러 번 다시 맞춤 + 크기 변화 감시
  [60, 300, 900].forEach(t => setTimeout(() => { try { MAP.m && MAP.m.invalidateSize(); } catch (e) {} }, t));
  if (!MAP.ro && window.ResizeObserver) { MAP.ro = new ResizeObserver(() => { try { if (S.tab === 'map' && MAP.m) MAP.m.invalidateSize(); } catch (e) {} }); MAP.ro.observe($('#map')); }
  const key = S.center ? `${S.center.lat},${S.center.lng}` : '';
  if (S.center && MAP.lastCenter !== key) { MAP.m.setView([S.center.lat, S.center.lng], S.radius > 1000 ? 15 : 16); MAP.lastCenter = key; $('#mapRedo').classList.add('hidden'); }
  if (MAP.fitNext && S.searchLabel && S.stores.length) {   // 매장 이름 검색 결과 전체가 보이게
    MAP.fitNext = false; const pts = filteredStores().list.slice(0, 60).map(x => [x.lat, x.lng]);
    if (pts.length === 1) MAP.m.setView(pts[0], 17); else if (pts.length) MAP.m.fitBounds(ML.latLngBounds(pts).pad ? ML.latLngBounds(pts).pad(0.2) : ML.latLngBounds(pts), { maxZoom: 17 });
  } else if (MAP.fitNext && !S.loading) MAP.fitNext = false;
  drawMarkers(); renderCarousel();
  // 목록과 같은 필터가 걸려 있음을 지도 위에도 표시
  const fl = filterLabel(), mf = $('#mapFilter');
  if (mf) { mf.textContent = fl ? `${fl} · ${filteredStores().list.length}곳 표시` : ''; mf.classList.toggle('hidden', !fl); }
}


// =====================================================================
// 앱(Capacitor) 전용 기능 — 웹에서는 아무것도 하지 않음
// =====================================================================
const NATIVE = (() => {
  const C = window.Capacitor;
  const on = !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());
  return { on, P: on ? (C.Plugins || {}) : {}, platform: on && C.getPlatform ? C.getPlatform() : 'web' };
})();

// 이번 달 리포트 (결제 기록 기준)
function monthReport(mk = monthKey()) {
  const log = S.ledger.filter(e => e.month === mk);
  const saved = log.reduce((a, e) => a + e.disc + (e.carrierDisc || 0), 0);
  const actualN = log.filter(e => e.actual !== undefined).length, actual = log.reduce((a, e) => a + (e.actual || 0), 0);
  const spend = log.reduce((a, e) => a + e.amount, 0);
  const byStore = {};
  log.forEach(e => { byStore[e.storeName] = (byStore[e.storeName] || 0) + e.disc + (e.carrierDisc || 0); });
  const top = Object.entries(byStore).sort((a, b) => b[1] - a[1])[0];
  return { mk, n: log.length, saved, spend, actual, actualN, top: top ? { name: top[0], saved: top[1] } : null };
}
function reportText(r) {
  const m = +r.mk.slice(5);
  return `${m}월에 여긴할인으로 약 ${won(r.saved)} 아꼈어요! (내 기록 기준 예상 · 결제 ${r.n}건${r.top ? ` · 최고 절약 ${r.top.name} ${won(r.top.saved)}` : ''})\n내 카드·통신사·지역화폐로 주변 매장 할인을 한눈에 → ${CONFIG.remoteBase}`;
}
async function shareReport() {
  const text = reportText(monthReport());
  try {
    if (NATIVE.on && NATIVE.P.Share) { await NATIVE.P.Share.share({ title: '이번 달 절약 리포트', text, dialogTitle: '공유하기' }); return; }
    if (navigator.share) { await navigator.share({ title: '이번 달 절약 리포트', text }); return; }
    await navigator.clipboard.writeText(text); toast('리포트 문구를 복사했어요.');
  } catch (e) { /* 사용자가 공유를 취소한 경우 */ }
}

// =====================================================================
// v26 ① 친구에게 알려주기 (공유 링크로 들어오면 그 매장을 바로 열어 줌)
// =====================================================================
function storeLink(st) {
  return `${CONFIG.remoteBase}/?s=${encodeURIComponent(st.id)}&n=${encodeURIComponent(st.name)}&at=${st.lat.toFixed(5)},${st.lng.toFixed(5)}`;
}
function storeShareText(st) {
  const r = calc(st, 10000);
  const lines = [`📍 ${st.name}`];
  if (st.address) lines.push(st.address);
  if (r.total > 0) lines.push(`💰 1만원 결제 시 ${won(r.total)} 할인 (내 ${r.best ? (r.best.m.kind === 'local' ? lcLabel(r.best.m.id) : r.best.m.name) : '통신사 멤버십'} 기준)`);
  const pay = payCandidates(st).filter(lc => payOk(payStatus(lc.id, st))).map(lc => lcLabel(lc.id));
  if (pay.length) lines.push(`🪙 ${pay.join('·')} 가맹점`);
  const ev = storeEvents(st.brand).find(e => e.type !== 'tip' && e.type !== 'soon');
  if (ev) lines.push(`🎁 ${ev.title}${ev.when ? ` (${ev.when})` : ''}`);
  lines.push('', '내 카드·통신사로는 얼마 할인되는지 확인해 보세요 👇', storeLink(st));
  return lines.join('\n');
}
async function shareOut(title, text) {
  try {
    if (NATIVE.on && NATIVE.P.Share) { await NATIVE.P.Share.share({ title, text, dialogTitle: '친구에게 알려주기' }); return; }
    if (navigator.share) { await navigator.share({ title, text }); return; }
    await navigator.clipboard.writeText(text); toast('문구를 복사했어요. 카톡 대화창에 붙여 넣으세요.');
  } catch (e) { /* 공유 취소 */ }
}
// 공유 링크(?s=매장id&n=이름&at=위도,경도)로 들어온 경우: 그 위치 매장을 불러온 뒤 그 매장을 엶
function readShareLink() {
  try {
    const q = new URLSearchParams(location.search); const at = (q.get('at') || '').split(',').map(Number);
    if (!(at[0] > 33 && at[0] < 39 && at[1] > 124 && at[1] < 132)) return null;
    history.replaceState(null, '', location.pathname);
    return { id: q.get('s') || '', name: q.get('n') || '', lat: at[0], lng: at[1] };
  } catch (e) { return null; }
}
function openPending() {
  const p = S.pendingOpen; if (!p || S.loading) return;
  const st = S.stores.find(x => x.id === p.id) || S.stores.find(x => p.name && nameLike(x.name, dbNorm(p.name)) && kcDist(x.lat, x.lng, p.lat, p.lng) < 120);
  S.pendingOpen = null;
  if (st) { openStore(st.id); return; }
  // 목록에 없으면(업종 밖 가게·아직 안 불러온 식당 등) 카카오에서 그 가게만 다시 찾아 넣음
  const add = (one) => { if (!one) return false; if (!S.stores.some(x => x.id === one.id)) { S.stores.push(one); S.stores.sort((a, b) => a.distance - b.distance); } renderAll(); openStore(one.id); return true; };
  if (p.doc && add(storeFromDoc(p.doc, S.center))) return;
  if (p.name && kakaoOn()) {
    const token = loadToken;
    kakaoApi('search/keyword', { query: p.name, x: p.lng, y: p.lat, radius: 300, sort: 'distance', size: 5 }, makeBudget(1)).then(res => {
      if (token !== loadToken) return;
      const docs = res.documents || [];
      const doc = docs.find(d => 'k' + d.id === p.id) || docs.find(d => nameLike(d.place_name, dbNorm(p.name)));
      if (!add(storeFromDoc(doc, S.center))) toast(`'${p.name}' 매장을 찾지 못했어요. 주변 매장을 보여 드려요.`);
    }).catch(() => toast(`'${p.name}' 매장을 찾지 못했어요. 주변 매장을 보여 드려요.`));
    return;
  }
  if (p.name) toast(`'${p.name}' 매장을 찾지 못했어요. 주변 매장을 보여 드려요.`);
}

// =====================================================================
// v26 ② ⭐ 자주 가는 곳 + 새 소식 (행사 추가·지역화폐 할인율·내 카드 할인 변화)
// =====================================================================
const isFav = (id) => !!S.favs[id];
function saveFavs() { store.set('hs_favs', S.favs); store.set('hs_favnews', S.favNews.slice(-30)); }
// 비교용 요약: 시간대 조건이 날마다 달라지지 않게 기준 시각(수요일 낮 12시)으로 계산
const FAV_REF = new Date(2026, 0, 7, 12, 0, 0);
function favSig(f) {
  const st = { ...f, distance: 0 };
  const evs = storeEvents(f.brand).filter(e => e.type !== 'tip').map(e => e.title).sort();
  const owned = ownedCards().map(c => c.id).sort().join(',');
  const card = Math.max(0, ...ownedCards().map(c => cardDiscount(c, st, 10000, FAV_REF, { ignoreUsed: true }).disc || 0));
  const lcs = payCandidates(st).filter(lc => (S.locals[lc.id] || {}).on && lc.rate && !isExpired(lc)).map(lc => `${lc.id}:${lc.rate}`).sort();
  return { evs, owned, card, lcs };
}
function toggleFav(st) {
  if (isFav(st.id)) { delete S.favs[st.id]; toast('자주 가는 곳에서 뺐어요.'); }
  else {
    const f = { id: st.id, name: st.name, brand: st.brand, category: st.category, address: st.address || '', jibun: st.jibun || '', lat: st.lat, lng: st.lng, url: st.url || '', t: Date.now() };
    f.sig = favSig(f); S.favs[st.id] = f;
    toast('⭐ 자주 가는 곳에 넣었어요. 할인·행사가 바뀌면 알려 드려요.');
  }
  saveFavs(); renderAll(); scheduleReminders();
}
// 앱을 열 때마다(자료를 받은 뒤) 지난번과 비교해 새 소식을 만듦
function checkFavNews() {
  if (!DATA.cards) return;
  let n = 0;
  Object.values(S.favs).forEach(f => {
    const now = favSig(f), old = f.sig;
    if (old && old.owned === now.owned) {
      const msgs = [];
      now.evs.filter(t => !(old.evs || []).includes(t)).forEach(t => msgs.push(`🎁 새 혜택: ${t}`));
      if (now.card > (old.card || 0)) msgs.push(`💳 내 카드 할인이 늘었어요 (1만원 기준 ${won(old.card || 0)} → ${won(now.card)})`);
      const om = Object.fromEntries((old.lcs || []).map(x => x.split(':'))), nm = Object.fromEntries(now.lcs.map(x => x.split(':')));
      Object.entries(nm).forEach(([id, r]) => { if (om[id] && +r > +om[id]) msgs.push(`🪙 ${lcLabel(id)} 할인율이 올랐어요 (${om[id]}% → ${r}%)`); });
      msgs.forEach(m => { S.favNews.push({ id: f.id, name: f.name, msg: m, t: Date.now(), read: false }); n++; });
    }
    f.sig = now;
  });
  saveFavs();
  if (n) { toast(`⭐ 자주 가는 곳 새 소식 ${n}건`); renderAll(); }
}
function favNewsSheet() {
  const list = S.favNews.slice().reverse();
  openSheet(`<h3>⭐ 자주 가는 곳 소식</h3>
    ${list.length ? `<div class="rows">${list.map(x => `<button class="rowi" type="button" data-favopen="${esc(x.id)}"><div class="bd"><div class="t">${esc(x.name)}</div><div class="d">${esc(x.msg)} · ${esc(fmtAgo(x.t))}</div></div><div class="r">›</div></button>`).join('')}</div>`
      : '<p class="hint">아직 소식이 없어요. 할인·행사가 바뀌면 여기에 모여요.</p>'}
    <button class="btn block" type="button" data-act="closesheet">닫기</button>`);
  S.favNews.forEach(x => { x.read = true; }); saveFavs(); renderList();
}
// 자주 가는 곳 열기: 지금 목록에 있으면 바로, 없으면 그 위치 매장을 불러와서 엶
function openFav(id) {
  const f = S.favs[id] || S.favNews.find(x => x.id === id); if (!f) return;
  closeSheet();
  if (S.stores.some(x => x.id === id)) { openStore(id); return; }
  const fv = S.favs[id]; if (!fv) return;
  S.pendingOpen = { id, name: fv.name, lat: fv.lat, lng: fv.lng };
  loadAround({ lat: fv.lat, lng: fv.lng }, fv.name);
}

// =====================================================================
// v26 ③ 나에게 맞는 카드 (최근 결제 기록 → 없으면 자주 가는 곳 가정)
// 카드 발급 권유가 아니라 비교 정보 · 한도를 모르는 할인은 계산에서 뺌(부풀림 방지)
// =====================================================================
function recommendCards() {
  const since = Date.now() - 60 * 86400000;
  let base = S.ledger.filter(e => e.ts >= since && e.amount > 0), mode = 'ledger', months = 0;
  if (base.length >= 3) {
    const days = Math.max(30, (Date.now() - Math.min(...base.map(e => e.ts))) / 86400000);
    months = days / 30;
  } else {
    const favs = Object.values(S.favs);
    if (!favs.length) return { mode: 'none', need: 3 - base.length, list: [] };
    mode = 'fav'; months = 1;   // 자주 가는 곳마다 한 달에 4번, 1만원씩 쓴다고 가정
    base = favs.flatMap(f => [0, 1, 2, 3].map(i => ({ brand: f.brand, category: f.category, amount: 10000, ts: FAV_REF.getTime(), disc: 0 })));
  }
  const spendM = base.reduce((a, e) => a + e.amount, 0) / months;
  const gotM = mode === 'ledger' ? base.reduce((a, e) => a + (e.disc || 0), 0) / months : 0;
  const list = (DATA.cards || []).filter(c => !S.owned.has(c.id) && !isExpired(c) && (c.rules || []).length && isCashCard(c) && ageOk(c) && !/종료|중단/.test(c.status || '')).map(c => {
    const byRule = new Map(), via = new Set(), opt = new Set();
    base.forEach(e => {
      const x = cardDiscount(c, { brand: e.brand, category: e.category, name: e.storeName || '' }, e.amount, mode === 'ledger' ? new Date(e.ts) : FAV_REF, { ignoreUsed: true, allConds: true });
      if (x.disc > 0 && x.capKnown) { byRule.set(x.rule, (byRule.get(x.rule) || 0) + x.disc); if (x.rule && x.rule.via) via.add(x.rule.via); if (x.rule && (x.rule.opt || /선택|옵션|팩/.test(x.rule.note || ''))) opt.add(x.rule.opt || x.rule.note); }
    });
    // 규칙별 월 한도 → 카드 전체 월 한도 순서로 자름 (한 달 기준)
    let m = 0; byRule.forEach((sum, rule) => { const mm = sum / months; m += typeof rule.cap === 'number' && rule.cap > 0 ? Math.min(mm, rule.cap) : mm; });
    if (c.cap > 0) m = Math.min(m, c.cap);
    const who = cardWho(c);
    const fee = (String(c.minSpend || '').match(/연회비\s*([0-9만천원,~\s]+)/) || [])[1];
    return { c, monthly: Math.round(m / 10) * 10, gain: Math.round((m - gotM) / 10) * 10, via: [...via], fee: fee ? fee.trim() : '', who: who ? who.trim() : '', opt: [...opt][0] || '', prevOk: !c.prevMin || spendM >= c.prevMin };
  }).filter(x => x.gain >= 500).sort((a, b) => b.gain - a.gain).slice(0, 3);
  return { mode, n: base.length, spendM: Math.round(spendM), gotM: Math.round(gotM), list };
}
function recoSection() {
  const R = recommendCards();
  const head = `<h3>💡 나에게 맞는 카드 ${CONFIG.cardPromo.affiliate ? '<span class="adlbl">광고</span>' : ''}</h3>`;
  if (R.mode === 'none') return `<div class="section promo">${head}<p class="hint">매장에서 [✔ 이렇게 결제했어요]로 ${R.need}번 더 기록하거나, 자주 가는 곳에 ⭐를 눌러 두면 내 소비에 맞는 카드를 찾아 드려요.</p></div>`;
  const basis = R.mode === 'ledger' ? `최근 결제 기록 ${R.n}건 (한 달 약 ${won(R.spendM)}) 기준` : `자주 가는 곳 ${R.n / 4}곳에서 한 달에 4번씩 1만원 쓴다고 가정`;
  if (!R.list.length) return `<div class="section promo">${head}<p class="hint">${esc(basis)}으로 보면, 지금 가진 결제수단보다 크게 나은 카드는 없어요 👍</p></div>`;
  return `<div class="section promo">${head}<p class="hint">${esc(basis)} · 지금보다 한 달에 더 아낄 수 있는 금액이에요</p>
    <div class="rows">${R.list.map(x => `<div class="rowi"><div class="bd"><div class="t">${esc(x.c.name)} <span class="pill">${esc(x.c.type || '')}</span></div>
      <div class="d">${esc(x.c.issuer)}${x.c.prevMin ? ` · 전월실적 ${won(x.c.prevMin)} 이상${x.prevOk ? '' : ' (지금 소비로는 못 미쳐요)'}` : ' · 전월실적 조건 없음'}${x.fee ? ` · 연회비 ${esc(x.fee)}` : ''}${x.via.length ? ` · ${esc(x.via.join('·'))} 결제 시` : ''}${x.who ? ` · ${esc(x.who)}` : ''}${x.opt ? ` · ${esc(x.opt)}` : ''}</div>
      <div class="promo-act"><button type="button" class="linkbtn" data-card="${esc(x.c.id)}">혜택 자세히</button>
      <a class="btn sm" href="${esc(cardInfoUrl(x.c))}" target="_blank" rel="noopener${CONFIG.cardPromo.affiliate ? ' sponsored' : ''}">카드 알아보기</a></div></div>
      <div class="r"><b class="up">월 +${won(x.gain)}</b><small>예상</small></div></div>`).join('')}</div>
    <p class="hint">예상치예요. 실제 할인은 전월실적·한도·옵션 선택에 따라 달라져요.</p>${promoNotice()}</div>`;
}

// 월말 알림: 25일 저녁에 한도·전월실적, 다음 달 1일 아침에 지난달 리포트 (결제 기록 기준)
const NOTI = { MONTH_END: 1001, REPORT: 1002, FAV: 1003 };
function nextAt(day, hour, now = new Date()) {
  let d = new Date(now.getFullYear(), now.getMonth(), day, hour, 0, 0);
  if (d <= now) d = new Date(now.getFullYear(), now.getMonth() + 1, day, hour, 0, 0);
  return d;
}
function monthEndMessage() {
  const lines = [];
  ownedCards().forEach(c => {
    const st = monthStats(c.id);
    if (c.prevMin && st.spend < c.prevMin) lines.push(`${c.name}: 다음 달 혜택까지 ${won(c.prevMin - st.spend)} 더 써야 해요`);
    else if (c.cap > 0 && st.disc < c.cap && st.n) lines.push(`${c.name}: 할인 한도 ${won(c.cap - st.disc)} 남았어요`);
  });
  return lines.length ? lines.slice(0, 3).join('\n') : null;
}
async function scheduleReminders() {
  const LN = NATIVE.P.LocalNotifications; if (!NATIVE.on || !LN) return;
  try {
    await LN.cancel({ notifications: [{ id: NOTI.MONTH_END }, { id: NOTI.REPORT }, { id: NOTI.FAV }] });
    if (!S.notify) return;
    const list = [];
    const favN = Object.keys(S.favs).length;
    if (favN) list.push({ id: NOTI.FAV, title: '⭐ 자주 가는 곳 할인 확인', body: `자주 가는 곳 ${favN}곳의 이번 주 할인·행사를 확인해 보세요.`, schedule: { on: { weekday: 7, hour: 11, minute: 0 }, allowWhileIdle: true }, extra: { open: 'list' } });
    const body = monthEndMessage();
    if (body) list.push({ id: NOTI.MONTH_END, title: '이번 달 카드 실적·한도 확인 (기록 기준)', body, schedule: { at: nextAt(25, 20) }, extra: { open: 'wallet' } });
    list.push({ id: NOTI.REPORT, title: '지난달 절약 리포트가 준비됐어요', body: '여긴할인에서 지난달 아낀 금액을 확인해 보세요.', schedule: { at: nextAt(1, 10) }, extra: { open: 'wallet' } });
    await LN.schedule({ notifications: list });
  } catch (e) { console.warn('알림 예약 실패', e); }
}
async function toggleNotify() {
  const LN = NATIVE.P.LocalNotifications;
  if (!S.notify) {
    if (!NATIVE.on || !LN) { toast('알림은 앱에서만 받을 수 있어요.'); return; }
    try {
      const p = await LN.requestPermissions();
      if (p.display !== 'granted') { toast('알림 권한이 꺼져 있어요. 휴대폰 설정에서 여긴할인 알림을 허용해 주세요.'); return; }
    } catch (e) { return; }
  }
  S.notify = !S.notify; store.set('hs_notify', S.notify);
  await scheduleReminders();
  toast(S.notify ? '매달 25일 저녁·1일 아침에 알려 드릴게요.' : '알림을 껐어요.');
  renderAll();
}

function nativeInit() {
  document.documentElement.classList.add('native', 'native-' + NATIVE.platform);
  const { App, Browser, LocalNotifications: LN, StatusBar } = NATIVE.P;
  // 안드로이드 뒤로가기 버튼: 시트 닫기 → 매장 화면 닫기 → 목록 탭 → 앱 종료
  if (App) App.addListener('backButton', () => {
    if (!$('#sheet').classList.contains('hidden')) { closeSheet(); return; }
    if (S.tab === 'store') { history.back(); return; }
    if (S.tab !== 'list') { setTab('list'); return; }
    App.exitApp();
  });
  // 앱으로 돌아올 때 알림 내용 갱신
  if (App) App.addListener('appStateChange', ({ isActive }) => { if (isActive) scheduleReminders(); });
  // 알림을 눌러 들어오면 해당 화면으로
  if (LN) LN.addListener('localNotificationActionPerformed', (a) => {
    const open = a && a.notification && a.notification.extra && a.notification.extra.open;
    if (open === 'wallet') setTab('wallet');
  });
  // 바깥 링크(카카오맵·네이버·카드사)는 앱 안 브라우저로 열기
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]'); if (!a) return;
    const href = a.getAttribute('href');
    if (/^https?:\/\//.test(href) && Browser) { e.preventDefault(); Browser.open({ url: href }); }
  }, true);
  if (StatusBar) { try { StatusBar.setBackgroundColor({ color: '#ffffff' }); StatusBar.setStyle({ style: 'LIGHT' }); } catch (e) {} }
  scheduleReminders();
}


// =====================================================================
// 첫 실행 안내: 통신사 → 카드 → 지역화폐 3단계
// =====================================================================
const POPULAR_CARD_IDS = ['samsung_taptap_o', 'kb_goodday', 'shinhan_mrlife', 'hyundai_zero3', 'lotte_likit_12', 'woori_card2_super',
  'kb_nori2_kbpay', 'toss_check', 'hana_npay_money_check', 'kb_my_wesh', 'nh20_haebom', 'samsung_monimo', 'hyundai_alphabet_s', 'shinhan_deep_dream_check'];
const OB = { step: 0, q: '' };
const isOnboarding = () => !$('#sheet').classList.contains('hidden') && !!$('#sheet .ob');
function onboardingSheet(step = 0, onlyResults) {
  OB.step = step;
  const dots = [0, 1, 2].map(i => `<i class="${i === step ? 'on' : ''}"></i>`).join('');
  let body = '';
  if (step === 0) {
    body = `<h3>어떤 통신사를 쓰세요?</h3><p>멤버십 할인을 함께 계산해 드려요. 여러 개 골라도 돼요.</p>
      <div class="carriers">${[['KT', 'KT'], ['SKT', 'SKT'], ['LGU', 'LG U+']].map(([k, l]) => `<button type="button" data-carrier="${k}" class="${S.carriers.includes(k) ? 'on' : ''}">${l}</button>`).join('')}
      <button type="button" data-carrier="NONE" class="${!S.carriers.length && store.get('hs_carrierNone', false) ? 'on' : ''}">없음·알뜰폰</button></div>${tierUI()}`;
  } else if (step === 1) {
    const q = norm(OB.q);
    const pool = (DATA.cards || []).filter(c => !isExpired(c));
    const list = q ? pool.filter(c => matchQ(q, c.name + ' ' + c.issuer)).slice(0, 20)
      : POPULAR_CARD_IDS.map(id => pool.find(c => c.id === id)).filter(Boolean);
    // 혜택 확인 전 카드(은행 기본 체크카드 등)도 이름으로 찾아 '혜택 모르는 카드'로 바로 담기
    const catHits = q ? CATALOG.filter(c => matchQ(q, c.name + ' ' + c.issuer)).slice(0, 8) : [];
    const mineName = new Set(S.custom.map(c => c.name));
    body = `<h3>가진 카드를 골라 주세요</h3><p>${q ? '검색 결과' : '많이 쓰는 카드'}예요. 카드 이름·카드사·초성으로 찾을 수 있어요.</p>
      <input class="search-in" id="obQ" type="search" placeholder="예: 굿데이, 신한, ㅌㅌ" value="${esc(OB.q)}" style="margin:2px 0 10px">
      <div id="obResults"><div class="ob-cards">${list.map(c => `<button type="button" class="ob-card ${S.owned.has(c.id) ? 'on' : ''}" data-obcard="${esc(c.id)}"><b>${esc(c.name)}</b><small>${esc(c.issuer)} ${esc(c.type || '')}</small></button>`).join('')}${catHits.map(c => `<button type="button" class="ob-card ${mineName.has(c.name) ? 'on' : ''}" data-obcat="${esc(c.id)}"><b>${esc(c.name)}</b><small>${esc(c.issuer)} · 혜택 확인 전</small></button>`).join('')}${list.length || catHits.length ? '' : '<p class="hint">찾는 카드가 없어요. 나중에 [내 지갑]에서 직접 추가할 수 있어요.</p>'}</div>
      <p class="hint">선택한 카드 ${ownedCards().filter(c => !c.custom).length}장</p></div>`;
  } else {
    const here = localsForHere(); const where = placeName();
    // 위치를 알면 우리 지역 것만, 모르면 할인율이 확인된 것만 (온누리는 전국이라 항상)
    const mine = (here.length ? here : localList().filter(lc => lc.rate && !isExpired(lc)))
      .sort((a, b) => (a.regions.includes('*') ? 1 : 0) - (b.regions.includes('*') ? 1 : 0));
    body = `<h3>쓰는 지역화폐가 있나요?</h3><p>${here.length ? `${esc(where)} 기준이에요. ` : '위치를 찾으면 우리 동네 지역화폐를 자동으로 켜 드려요. '}켜 두면 가맹점에서 카드보다 나은지 비교해 드려요.</p>
      <div class="rows">${mine.map(lc => { const on = (S.locals[lc.id] || {}).on; return `<div class="cardrow"><div class="bd"><div class="t">🪙 ${esc(lc.name)}</div><div class="d">${lc.rate && !isExpired(lc) ? `${pct(lc.rate)} 할인·캐시백` : esc(lcShortNote(lc))}</div></div><button type="button" class="toggle ${on ? 'on' : ''}" data-local="${esc(lc.id)}" aria-label="${esc(lc.name)}"></button></div>`; }).join('')}</div>
      <p class="hint">다른 지역 상품권은 [내 지갑]에서 켤 수 있어요.</p>
      <label class="hint" style="display:flex;gap:8px;align-items:flex-start;margin-top:10px"><input type="checkbox" id="obStats" ${store.get('hs_statsOk', false) ? 'checked' : ''}> <span>(선택) 익명 사용 통계 보내기 — 어떤 기능을 눌렀는지 숫자만 보내요. 위치·카드·기기 정보는 보내지 않아요. 나중에 [내 지갑]에서 바꿀 수 있어요.</span></label>
      <p class="hint" style="font-size:12px">[시작하기]를 누르면 <a href="/terms.html" target="_blank" rel="noopener">이용약관</a>·<a href="/location-terms.html" target="_blank" rel="noopener">위치기반서비스 이용약관</a>에 동의하는 것으로 봐요. <a href="/privacy.html" target="_blank" rel="noopener">개인정보 처리방침</a></p>`;
  }
  const html = `<div class="ob"><div class="ob-dots">${dots}</div>${body}
    <div class="actions">${step > 0 ? `<button class="btn ghost" type="button" data-ob="prev">이전</button>` : `<button class="btn ghost" type="button" data-ob="skip">나중에 할게요</button>`}
    <button class="btn green" type="button" data-ob="${step < 2 ? 'next' : 'done'}">${step < 2 ? '다음' : '시작하기'}</button></div></div>`;
  if (onlyResults && $('#obResults')) { swapPart(html, 'obResults'); return; }
  if ($('#sheet').classList.contains('hidden')) openSheet(html);
  else $('#sheet').innerHTML = '<div class="grab"></div>' + html;
  if (step === 1) { const i = $('#obQ'); if (i && OB.q) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }
}
function finishOnboarding() {
  S.onboarded = true; store.set('hs_onboarded', true);
  track('onboard', (ownedCards().length ? 'c' : '') + (S.carriers.length ? 't' : ''));
  closeSheet(); saveWallet(); renderAll();
  toast(ownedCards().length || S.carriers.length ? '설정 완료! 매장마다 할인액이 보여요.' : '언제든 [내 지갑]에서 바꿀 수 있어요.');
}

// 방문 통계 (Cloudflare Web Analytics: 쿠키·개인 식별 없음). 토큰이 있을 때 웹에서만
function loadAnalytics() {
  if (!CONFIG.cfAnalyticsToken || NATIVE.on) return;
  const sc = document.createElement('script');
  sc.type = 'module'; sc.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  sc.setAttribute('data-cf-beacon', JSON.stringify({ token: CONFIG.cfAnalyticsToken }));
  document.head.appendChild(sc);
}

// =====================================================================
// 9. 이벤트 연결 & 시작
// =====================================================================
function bind() {
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); searchQuery($('#q').value); });
  $('#gpsBtn').addEventListener('click', () => useMyLocation(false));
  $('#locBtn').addEventListener('click', () => { $('#q').focus(); });
  $('#radiusSel').value = String(S.radius);
  $('#radiusSel').addEventListener('change', (e) => {
    S.radius = +e.target.value; store.set('hs_radius', S.radius);
    if (S.center && !S.searchLabel) loadAround(S.center, S.center.label);
  });
  $$('.tabbar button').forEach(b => b.addEventListener('click', () => {
    if (S.tab === 'store') history.back();
    if (b.dataset.tab === 'map') S.selectedId = null;
    setTab(b.dataset.tab);
  }));
  $('#mapRedo').addEventListener('click', () => { const c = MAP.m.getCenter(); loadAround({ lat: c.lat, lng: c.lng }, '지도에서 고른 곳'); });
  const zoom = (d) => { if (!MAP.m) return; if (MAP.m.zoomBy) MAP.m.zoomBy(d); else MAP.m.setZoom(MAP.m.getZoom() + d); };
  $('#mapZin').addEventListener('click', () => zoom(1));
  // 업종 칩 줄: 오른쪽에 더 있으면 흐리게 표시, 끝까지 밀면 흐림 없앰
  const cc = $('#catChips'), ccEnd = () => cc.classList.toggle('end', cc.scrollLeft + cc.clientWidth >= cc.scrollWidth - 4);
  cc.addEventListener('scroll', ccEnd, { passive: true }); window.addEventListener('resize', ccEnd); new MutationObserver(ccEnd).observe(cc, { childList: true }); setTimeout(ccEnd, 0);
  $('#mapZout').addEventListener('click', () => zoom(-1));
  $('#mapMe').addEventListener('click', () => {
    if (S.me) MAP.m.setView([S.me.lat, S.me.lng], 16); else useMyLocation(false);
  });
  $('#dim').addEventListener('click', () => closeSheet());
  window.addEventListener('popstate', () => {
    if (S._ignorePop) { S._ignorePop = false; return; }
    if (!$('#sheet').classList.contains('hidden')) { closeSheet(true); return; }
    if (S.tab === 'store') { setTab(S.prevTab); return; }
    // 앞으로가기로 매장 주소에 다시 온 경우 그 매장을 다시 엶
    const q = new URLSearchParams(location.search), sid = q.get('s');
    if (sid && S.stores.some(x => x.id === sid)) { S.selectedId = sid; setTab('store'); }
  });
  new ResizeObserver(updateHeaderH).observe($('#topbar'));

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, a'); if (!t) return;
    const d = t.dataset;
    if (d.favopen) { openFav(d.favopen); return; }
    if (d.vfy) { const [id, ok] = d.vfy.split(':'); if (S.selectedId) setVerify(S.selectedId, id, ok === '1'); return; }
    if (d.merch) { S.dbOnly = S.dbOnly === d.merch ? false : d.merch; renderAll(); return; }
    if (d.cat) { S.cat = d.cat; renderAll(); if (extraFor(d.cat) && !S.loading && S.source === '카카오맵') loadExtra(extraFor(d.cat)); return; }
    if (d.store) { if (d.close) closeSheet(); openStore(d.store); return; }
    if (d.cstore) {
      if (S.selectedId === d.cstore) openStore(d.cstore); else selectOnMap(d.cstore, true);
      return;
    }
    if (d.area) { e.preventDefault(); e.stopPropagation(); S.selectedId = null; S.pendingOpen = null; $('#q').value = d.area; setTab('list');
      const a = AREAS[d.area];   // v38: 추천 지역은 좌표를 미리 넣어 두어 검색 없이 바로 이동(서면역 무반응·강남역 지연 해결)
      if (a) { track('search'); loadAround({ lat: a[0], lng: a[1] }, d.area); setListUrl(d.area); } else searchQuery(d.area);
      return; }
    if (d.amt) { S.amount = +d.amt; store.set('hs_amount', S.amount); renderStore(); return; }
    if (d.card) { cardSheet(d.card); return; }
    if (d.ev !== undefined) { eventSheet(+d.ev); return; }
    if (d.ctier) { const [code, t] = d.ctier.split(':'); S.ctier = { ...S.ctier, [code]: S.ctier[code] === t ? '' : t }; saveWallet(); renderAll(); if (isOnboarding()) onboardingSheet(OB.step); return; }
    if (d.cmode) { const [code, m] = d.cmode.split(':'); S.cmode = { ...S.cmode, [code]: m }; saveWallet(); renderAll(); if (isOnboarding()) onboardingSheet(OB.step); return; }
    if (d.carrier) {
      store.set('hs_carrierNone', d.carrier === 'NONE');
      if (d.carrier === 'NONE') S.carriers = [];
      else S.carriers = S.carriers.includes(d.carrier) ? S.carriers.filter(x => x !== d.carrier) : [...S.carriers, d.carrier];
      saveWallet(); renderAll(); if (isOnboarding()) onboardingSheet(OB.step); return;
    }
    if (d.own) {
      S.owned.has(d.own) ? S.owned.delete(d.own) : S.owned.add(d.own); saveWallet();
      if (d.close) closeSheet();
      renderAll(); return;
    }
    if (d.ob) {
      if (d.ob === 'next') onboardingSheet(OB.step + 1);
      else if (d.ob === 'prev') onboardingSheet(OB.step - 1);
      else finishOnboarding();
      return;
    }
    if (d.obcat) {
      const c = CATALOG.find(x => x.id === d.obcat);
      if (c) {
        const had = S.custom.find(x => x.name === c.name);
        if (had) { S.custom = S.custom.filter(x => x !== had); S.owned.delete(had.id); }
        else { const nc = { id: 'u' + Date.now(), custom: true, name: c.name, issuer: c.issuer, type: c.type, rules: [], cap: null, prevMin: 0, catalogId: c.id }; S.custom.unshift(nc); S.owned.add(nc.id); toast('혜택을 모르는 카드로 담았어요. [내 지갑]에서 할인율을 넣을 수 있어요.'); }
        saveWallet(); renderAll(); onboardingSheet(1, true);
      }
      return;
    }
    if (d.obcard) { if (S.owned.has(d.obcard)) S.owned.delete(d.obcard); else S.owned.add(d.obcard); saveWallet(); renderAll(); onboardingSheet(1, true); return; }
    if (d.issuer) { S.walletIssuer = d.issuer; renderWallet(); return; }
    if (d.ctype) { S.walletType = d.ctype; renderWallet(); return; }
    if (d.catadd) { const c = CATALOG.find(x => x.id === d.catadd); if (c) addCardSheet(c); return; }
    if (d.local) { const cur = S.locals[d.local] || {}; S.locals[d.local] = { ...cur, on: !cur.on, touched: true, auto: false }; saveWallet(); renderAll(); if (isOnboarding()) onboardingSheet(OB.step); return; }
    if (d.localinfo) { localSheet(d.localinfo); return; }
    if (d.dellog) { S.ledger = S.ledger.filter(e => String(e.ts) !== d.dellog); saveWallet(); renderAll(); scheduleReminders(); return; }
    if (d.editlog) { editLogSheet(d.editlog); return; }
    if (d.pay) { S.pays = S.pays.includes(d.pay) ? S.pays.filter(x => x !== d.pay) : [...S.pays, d.pay]; saveWallet(); renderAll(); return; }
    if (d.cond) { const [cid, k] = d.cond.split('|'); toggleCond(cid, k); return; }
    if (d.prev) { const [cid, ok] = d.prev.split(':'); const cur = S.prevOk[cid]; const v = ok === '1';
      if (cur && cur.month === monthKey() && cur.ok === v) delete S.prevOk[cid]; else S.prevOk[cid] = { month: monthKey(), ok: v };
      saveWallet(); renderAll(); if (!$('#sheet').classList.contains('hidden') && $('#sheet [data-prev]')) cardSheet(cid);
      toast(v ? '이번 달은 실적 충족으로 계산해요.' : '이번 달은 이 카드 할인을 빼고 계산해요.'); return; }
    if (d.capfix) { const v = parseInt(($('#capFixIn') || {}).value, 10); if (!(v >= 0)) { toast('카드사 앱에서 본 남은 한도를 숫자로 넣어 주세요.'); return; }
      S.capFix[d.capfix] = { month: monthKey(), left: v, ts: Date.now() }; saveWallet(); renderAll(); cardSheet(d.capfix); toast('남은 한도를 고쳤어요. 이번 달 계산에 반영돼요.'); return; }
    if (d.lsug) { const [id, yes] = d.lsug.split(':'); answerSuggest(id, yes === '1'); return; }
    if (d.sort) { S.sort = d.sort; store.set('hs_sort', S.sort); renderAll(); return; }
    if (d.pick) { const [la, ln] = d.pick.split(',').map(Number); const pc = (S._pickCands || [])[+d.pickidx]; if (pc && pc.doc && storeFromDoc(pc.doc)) S.pendingOpen = { id: 'k' + pc.doc.id, name: pc.name, lat: la, lng: ln, doc: pc.doc }; closeSheet(); setTab(S._pickBack || 'list'); if (S._pickBack === 'map') MAP.lastCenter = null; loadAround({ lat: la, lng: ln }, d.pickname || ''); return; }
    if (d.editcard) { const c = S.custom.find(x => x.id === d.editcard); if (c) addCardSheet(c, true); return; }
    if (d.delcard) { S.custom = S.custom.filter(c => c.id !== d.delcard); S.owned.delete(d.delcard); saveWallet(); closeSheet(); renderAll(); return; }
    if (d.close) { closeSheet(); return; }
    switch (d.act) {
      case 'gps': useMyLocation(false); break;
      case 'reload': if (S.center) loadAround({ lat: S.center.lat, lng: S.center.lng }, S.center.label); break;
      case 'back': history.back(); break;
      case 'showmap': { const id = S.selectedId; history.back(); setTimeout(() => { setTab('map'); selectOnMap(id, true); }, 30); break; }
      case 'report': reportSheet(); break;
      case 'sendreport': sendReport(); break;
      case 'addcard': addCardSheet(); break;
      case 'savecard': saveCustomCard(); break;
      case 'logpay': logPaySheet(); break;
      case 'dbonly': S.dbOnly = false; renderAll(); break;
      case 'onboard': onboardingSheet(0); break;
      case 'sharereport': shareReport(); break;
      case 'notify': toggleNotify(); break;
      case 'savelog': saveLog(); break;
      case 'fav': { const st = S.stores.find(x => x.id === S.selectedId); if (st) toggleFav(st); break; }
      case 'sharestore': { const st = S.stores.find(x => x.id === S.selectedId); if (st) shareOut(st.name + ' 할인 정보', storeShareText(st)); break; }
      case 'favnews': favNewsSheet(); break;
      case 'closesheet': closeSheet(); break;
      case 'favonly': S.favOnly = !S.favOnly; renderAll(); break;
      case 'promoonly': S.promoOnly = !S.promoOnly; renderAll(); break;
      case 'promos': promosSheet(); break;
      case 'clearlog': if (confirm('결제 기록을 모두 지울까요?')) { S.ledger = []; saveWallet(); renderAll(); } break;
      case 'morestores': runPending(200, loadToken, true); break;
      case 'retryextra': S.extraFail = false; S.extraRetried = true; loadExtra(extraFor(S.cat) || 'dining'); renderAll(); break;
      case 'sugsave': { const v = parseFloat(($('#sugRate') || {}).value); const id = t.dataset.id;
        S.locals[id] = { ...(S.locals[id] || {}), on: true, touched: true, auto: false, rate: v > 0 ? Math.min(v, 30) : null };
        S.localSuggest = S.localSuggest.filter(x => x !== id); saveWallet(); closeSheet(); renderAll();
        toast(v > 0 ? `${lcLabel(id)} ${v}%로 계산해요. 가맹점으로 확인된 매장에서 할인이 보여요.` : '켜 두었어요. 할인율은 [내 지갑]에서 넣을 수 있어요.'); break; }
      case 'saveonly': S.saveOnly = !S.saveOnly; renderAll(); break;
      case 'walletadd': S.walletAdd = !S.walletAdd; if (!S.walletAdd) { S.walletQ = ''; S.walletIssuer = '전체'; S.walletType = '전체'; } renderWallet(); break;
      case 'wipe': if (confirm('이 기기에 저장된 카드·통신사·지역화폐·결제 기록·⭐ 자주 가는 곳을 모두 지울까요? 되돌릴 수 없어요.')) wipeWallet(); break;
      case 'savelogedit': saveLogEdit(); break;
      case 'backup': exportBackup(); break;
      case 'restore': restoreSheet(); break;
      case 'dorestore': doRestore(); break;
      case 'bigtext2':
      case 'bigtext': S.big = !S.big; store.set('hs_big', S.big); applyBig(); renderAll(); updateHeaderH(); toast(S.big ? '글씨를 크게 보여 드려요. 꼭 필요한 버튼만 남겼어요.' : '보통 글씨로 돌아왔어요.'); break;
    }
  });
  document.addEventListener('change', (e) => {
    const id = e.target.dataset && e.target.dataset.lrate;
    if (id) { const v = parseFloat(e.target.value); S.locals[id] = { ...(S.locals[id] || {}), on: true, rate: v > 0 ? Math.min(v, 30) : null }; saveWallet(); toast('할인율을 저장했어요.'); }
    if (e.target.dataset && e.target.dataset.ptprog) { store.set('hs_pt_' + e.target.dataset.ptprog, e.target.checked); toast(e.target.checked ? '포인트 사용 가능한 매장을 표시해요.' : '포인트 사용처 표시를 껐어요.'); renderAll(); }
    if (e.target.id === 'statsOk' || e.target.id === 'obStats') { store.set('hs_statsOk', !!e.target.checked); toast(e.target.checked ? '익명 통계를 보내요. 고마워요!' : '익명 통계를 보내지 않아요.'); }
    if (e.target.id === 'ageSel') { S.age = e.target.value; store.set('hs_age', S.age); renderAll(); toast(S.age ? '나이 조건에 맞지 않는 카드는 추천에서 빼요.' : '나이 조건을 쓰지 않아요.'); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'obQ') { OB.q = e.target.value; clearTimeout(OB.t); OB.t = setTimeout(() => onboardingSheet(1, true), 120); return; }
    if (e.target.id === 'amtInput') {
      S.amount = Math.min(100000000, Math.max(0, parseInt(e.target.value, 10) || 0)); store.set('hs_amount', S.amount);
      clearTimeout(S._amtT); S._amtT = setTimeout(() => { const pos = e.target.selectionStart; renderStore(); const i = $('#amtInput'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (x) {} } }, 350);
    }
    if (e.target.id === 'exclInput') {
      S.exclAmt = Math.max(0, parseInt(e.target.value, 10) || 0);
      clearTimeout(S._amtT); S._amtT = setTimeout(() => { const pos = e.target.selectionStart; renderStore(); const i = $('#exclInput'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (x) {} } }, 350);
    }
    if (e.target.id === 'walletQ') {
      S.walletQ = e.target.value;
      clearTimeout(S._wq); S._wq = setTimeout(() => renderWallet(true), 120);
    }
  });
}

async function start() {
  applyBig();
  PROXY_READY = probeProxy();
  PROXY_READY.then(() => track('open'));
  bind();
  // 다시 열 때 '어디 근처…' 빈 화면이 잠깐 보이지 않게, 마지막 위치나 공유 주소가 있으면 처음부터 '찾는 중'으로 그림
  const last0 = store.get('hs_lastLoc', null), qs0 = new URLSearchParams(location.search);
  if (last0 || qs0.get('at') || qs0.get('q')) { S.loading = true; if (last0) S.center = last0; }
  renderAll();
  await loadData();
  renderAll();
  loadAnalytics();
  checkFavNews();
  const shared = readShareLink();
  if (!S.onboarded) setTimeout(() => onboardingSheet(0), 400);
  const last = store.get('hs_lastLoc', null);
  let granted = false;
  try {
    if (NATIVE.on && NATIVE.P.Geolocation) granted = (await NATIVE.P.Geolocation.checkPermissions()).location === 'granted';
    else granted = navigator.permissions && (await navigator.permissions.query({ name: 'geolocation' })).state === 'granted';
  } catch (e) {}
  const qParam = new URLSearchParams(location.search).get('q');
  if (shared) { S.pendingOpen = shared; loadAround({ lat: shared.lat, lng: shared.lng }, shared.name || '공유받은 매장'); }
  else if (qParam) { $('#q').value = qParam; searchQuery(qParam); }
  else if (granted) useMyLocation(true);
  else if (last) loadAround(last, last.label);
  if (NATIVE.on) nativeInit();
  else if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
}
document.addEventListener('DOMContentLoaded', start);
