#!/usr/bin/env node
// 한국조폐공사 지역사랑상품권 가맹점(오픈API) 전체 내려받기 → CSV (선생님 컴퓨터에서 실행)
// 인증키는 파일에 저장하지 않아요. 실행할 때만 입력합니다. (web 폴더는 인터넷에 공개되니 키를 넣지 마세요)
//
// 1) 시험 (첫 화면만 받아서 항목 이름 확인):
//    node tools/fetch-kc.js test "End Point 주소" 인증키
// 2) 전체 받기 (제공기관별로 나눠 받음, 중간에 끊겨도 다시 실행하면 이어서 받음):
//    node tools/fetch-kc.js all "End Point 주소" 인증키
//    → C:\heresale\kc_data\kc_<제공기관>.csv 파일들이 생겨요 (web 폴더 밖)
// 3) 앱용 파일 만들기:  node --max-old-space-size=6144 tools/build-kc.js ..\kc_data\kc_*.csv
const fs = require('fs');
const path = require('path');

const [mode, endpoint, key] = process.argv.slice(2);
if (!['test', 'all'].includes(mode) || !endpoint || !key) {
  console.log('사용법:\n  node tools/fetch-kc.js test "End Point 주소" 인증키\n  node tools/fetch-kc.js all "End Point 주소" 인증키');
  process.exit(1);
}
const OUT = path.resolve(__dirname, '../../kc_data');
const INST = ['I0000001', 'I0000002', 'I0000003', 'I0000004', 'I0000005', 'I0000006', 'I0000007', 'I0000008', 'I0000009', 'I0000010', 'I0000011', 'I0000012', 'I0000013', 'I0000014', 'I0000015', 'I0000016'];
const PER = 1000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 공공데이터포털 API는 두 가지 모양이 있어서 둘 다 처리 (odcloud: page/perPage, apis.data.go.kr: pageNo/numOfRows)
function buildUrl(page, inst) {
  const u = new URL(endpoint);
  const k = /%/.test(key) ? decodeURIComponent(key) : key;
  u.searchParams.set('serviceKey', k);
  // 조폐공사 API는 주소(apis.data.go.kr)와 달리 page/perPage·cond[...] 방식을 쓰는 것도 있어서 두 방식을 함께 보냄 (모르는 값은 무시됨)
  u.searchParams.set('page', page); u.searchParams.set('perPage', PER);
  u.searchParams.set('returnType', 'JSON');
  if (inst) u.searchParams.set('cond[pvsn_inst_cd::EQ]', inst);
  if (!/odcloud/.test(u.host)) {
    u.searchParams.set('pageNo', page); u.searchParams.set('numOfRows', PER); u.searchParams.set('type', 'json');
    if (inst) u.searchParams.set('pvsn_inst_cd', inst);
  }
  return u.toString();
}
function pick(json) {
  if (Array.isArray(json.data)) return { items: json.data, total: json.totalCount ?? json.matchCount };
  const b = json.response && json.response.body; const raw = b && b.items;
  const items = Array.isArray(raw) ? raw : raw && raw.item ? [].concat(raw.item) : [];
  const err = json.response && json.response.header && json.response.header.resultCode;
  if (err && !/^0+$/.test(String(err))) throw new Error(`API 오류 ${err}: ${json.response.header.resultMsg}`);
  return { items, total: b ? Number(b.totalCount) : undefined };
}
async function get(page, inst) {
  for (let t = 1; t <= 5; t++) {
    try {
      const res = await fetch(buildUrl(page, inst), { headers: { accept: 'application/json' } });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
      if (/^\s*</.test(text)) throw new Error('JSON이 아닌 응답: ' + text.slice(0, 300));
      return pick(JSON.parse(text));
    } catch (e) { if (t === 5) throw e; console.log(`  다시 시도 ${t}/4 … (${e.message.slice(0, 120)})`); await sleep(3000 * t); }
  }
}
// 응답 항목 이름이 한글이든 영문이든 찾아서 build-kc.js가 읽는 한글 열로 바꿈
const FIELDS = [
  ['가맹점 구분(ID)', /구분\(?ID|frcs_?id|mrhst_?id|frnchs_?id|^id$|^alt_text$/i],
  ['가맹점명', /가맹점명|frcs_?nm|mrhst_?nm|frnchs_?nm|bzst_?nm|^nm$/i],
  ['위도', /위도|^lat|_lat$/i],
  ['경도', /경도|^lot|^lon|^lng|_lot$|_lon$/i],
  ['가맹점주소', /주소|addr/i],
  ['사업자 상태', /사업자\s*상태$|bzmn_?stts(_cd)?$|b_?stt_?cd/i],
  ['가맹점 이용상태 구분', /이용\s*상태\s*구분$|use_?stts(_cd)?$|frcs_?stts(_cd)?$|^frcs_reg_se$/i],
  ['가맹점 결제유형 구분명', /결제\s*유형.*명|stlm_?type_?nm|pay_?type_?nm|stlm_?mthd_?nm/i],
  ['사용처지역코드', /사용처\s*지역|usage_?rgn|use_?rgn|rgn_?cd/i],
  ['기준일자', /기준일자|crtr_?ymd|base_?dt/i],
  ['제공기관코드', /제공기관|pvsn_?inst_?cd/i]
];
function mapKeys(sample) {
  const keys = Object.keys(sample); const m = {};
  for (const [ko, re] of FIELDS) { const k = keys.find(x => x === ko || re.test(x)); if (k) m[ko] = k; }
  return m;
}
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

(async () => {
  if (mode === 'test') {
    const { items, total } = await get(1, '');
    console.log(`전체 건수: ${total ?? '알 수 없음'} · 첫 페이지 ${items.length}건`);
    if (!items.length) { console.log('받은 자료가 없어요. End Point 주소와 인증키를 확인해 주세요.'); return; }
    console.log('\n[첫 번째 자료]'); console.log(JSON.stringify(items[0], null, 1));
    const m = mapKeys(items[0]);
    console.log('\n[항목 연결]'); FIELDS.forEach(([ko]) => console.log(`  ${ko.padEnd(14)} ← ${m[ko] || '(못 찾음)'}`));
    console.log('\n이 화면을 캡처해서 Claude에게 보내 주세요.');
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const prog = path.join(OUT, 'progress.json');
  const done = fs.existsSync(prog) ? JSON.parse(fs.readFileSync(prog, 'utf8')) : {};
  let calls = 0;
  // 제공기관 나눠 받기가 되는지 확인 (안 되면 한 번에 전부 받음 → 같은 자료를 여러 번 받지 않게)
  let list = INST;
  if (!done._mode) {
    const all = await get(1, ''); calls++;
    let one = {}; try { one = await get(1, 'I0000001'); calls++; } catch (e) { console.log('제공기관별 조건이 막혀서 한 번에 받아요.'); }
    done._mode = (all.total && one.total && one.total < all.total) ? 'inst' : 'single';
    fs.writeFileSync(prog, JSON.stringify(done));
  }
  if (done._mode === 'single') { list = ['ALL']; console.log('제공기관별 나누기가 안 돼서 한 번에 받아요.'); }
  for (const inst0 of list) {
    const inst = inst0 === 'ALL' ? '' : inst0;
    const st = done[inst0] || { page: 0, total: null, finished: false };
    if (st.finished) { console.log(`${inst0}: 이미 받음`); continue; }
    const file = path.join(OUT, `kc_${inst0}.csv`);
    let m = null;
    if (!st.page) fs.writeFileSync(file, '\uFEFF' + FIELDS.map(f => f[0]).join(',') + '\n');
    for (let page = st.page + 1; ; page++) {
      const { items, total } = await get(page, inst); calls++;
      if (st.total == null) { st.total = total; console.log(`${inst0}: 전체 ${total ?? '?'}건`); }
      if (!items.length) { st.finished = true; break; }
      m = m || mapKeys(items[0]);
      if (!m['가맹점명'] || !m['위도'] || !m['경도']) throw new Error('가맹점명·위도·경도 항목을 찾지 못했어요. test 결과를 Claude에게 보내 주세요.');
      fs.appendFileSync(file, items.map(it => FIELDS.map(([ko]) => csvCell(m[ko] ? it[m[ko]] : (ko === '제공기관코드' && inst0 !== 'ALL' ? inst0 : ko === '가맹점 결제유형 구분명' && /mobile/i.test(endpoint) ? '모바일' : ''))).join(',')).join('\n') + '\n');
      st.page = page; done[inst0] = st; fs.writeFileSync(prog, JSON.stringify(done));
      if (page % 20 === 0) console.log(`  ${inst0}: ${Math.min(page * PER, st.total || page * PER).toLocaleString()} / ${(st.total || 0).toLocaleString()}`);
      if (items.length < PER) { st.finished = true; break; }
      if (calls >= 9500) { console.log('오늘 호출 한도(1만 회)에 가까워 멈췄어요. 내일 같은 명령을 다시 실행하면 이어서 받아요.'); fs.writeFileSync(prog, JSON.stringify(done)); return; }
      await sleep(150);
    }
    done[inst0] = st; fs.writeFileSync(prog, JSON.stringify(done));
    console.log(`${inst0}: 완료`);
  }
  console.log(`\n모두 받았어요 → ${OUT}\n다음: node --max-old-space-size=6144 tools/build-kc.js "${OUT}\\kc_*.csv"`);
})().catch(e => { console.error('\n멈춤: ' + e.message + '\n같은 명령을 다시 실행하면 이어서 받아요.'); process.exit(1); });
