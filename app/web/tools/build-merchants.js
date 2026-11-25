#!/usr/bin/env node
// 지역화폐·온누리상품권 가맹점 공공데이터(CSV) → 앱용 시·군·구별 색인 파일
// 사용법 (web 폴더에서):
//   node tools/build-merchants.js <종류> "내려받은파일.csv" [--region 부산] [--basis 2025-07-31]
//   종류: dongbaek(동백전) | onnuri(온누리상품권) | incheon_eum(인천e음) | 그 밖의 지역화폐 id
// 결과: data/<폴더>/index.json + 시·군·구별 JSON
//   index.json: { id, region, basis, count, source, gus: { "<시군구>" 또는 "<시도> <시군구>": { file, n } } }
//   region이 있으면(예: 동백전=부산) 키는 "사하구"처럼 시·군·구만, 없으면(온누리=전국) "부산 사하구"처럼 시·도를 붙임
// 색인 키: R:<도로명>:<건물번호> / J:<동·리>:<번지> / S:<도로명>(번지 없음) / D:<동>(번지 없음) → 가맹점 이름 목록
const fs = require('fs');
const path = require('path');

const SETS = {
  dongbaek: { dir: 'data/dongbaek', region: '부산', label: '동백전', source: 'https://www.data.go.kr/data/15088786/fileData.do' },
  onnuri: { dir: 'data/merchants/onnuri', region: '', label: '온누리상품권', source: 'https://www.data.go.kr/data/3060079/fileData.do' },
  incheon_eum: { dir: 'data/merchants/incheon_eum', region: '인천', label: '인천e음', source: 'https://www.data.go.kr/data/15146286/fileData.do' }
};

// ---- 앱(app.js)과 같은 규칙: 바꾸면 양쪽 다 바꿔야 함 ----
const REGION_ALIAS = [['서울', '서울'], ['부산', '부산'], ['대구', '대구'], ['인천', '인천'], ['광주', '광주'], ['대전', '대전'], ['울산', '울산'], ['세종', '세종'], ['경기', '경기'],
  ['강원', '강원'], ['충청북', '충북'], ['충북', '충북'], ['충청남', '충남'], ['충남', '충남'], ['전라북', '전북'], ['전북', '전북'], ['전라남', '전남'], ['전남', '전남'],
  ['경상북', '경북'], ['경북', '경북'], ['경상남', '경남'], ['경남', '경남'], ['제주', '제주']];
function regionShort(t) {
  const first = String(t || '').trim().split(/\s+/)[0] || '';
  const hit = REGION_ALIAS.find(([k]) => first.startsWith(k));
  return hit ? hit[1] : '';
}
function addrKeys(addr) {
  const a = String(addr || '').replace(/\(.*?\)/g, ' ').replace(/,.*$/, '').replace(/\s+/g, ' ').trim();
  const keys = [];
  const road = a.match(/([가-힣A-Za-z0-9.]+(?:로|길))\s*(\d+(?:-\d+)?)/);
  if (road) keys.push('R:' + road[1] + ':' + road[2]);
  const jibun = a.match(/([가-힣0-9]+(?:동|가|리|읍|면))\s+(?:산\s*)?(\d+(?:-\d+)?)(?!\S*(?:로|길))/);
  if (jibun && !road) keys.push('J:' + jibun[1] + ':' + jibun[2]);
  return keys;
}
function streetKeys(addr) {
  const a = String(addr || '').replace(/\(.*?\)/g, ' ').replace(/,.*$/, '').replace(/\s+/g, ' ').trim();
  const road = a.match(/\s([가-힣A-Za-z0-9.]+(?:로|길))(?:\s|$)/);
  if (road) return ['S:' + road[1]];
  const dong = a.match(/\s([가-힣0-9]+(?:동|가|리))(?:\s|$)/);
  if (dong) return ['D:' + dong[1].replace(/\d+동$/, '동')];
  return [];
}
const SKIP_NAME = /\d{2,3}[가-힣]\d{4}|개인택시|콜택시|모범택시|택시\(|\(택시|택시_|_택시|택시주식회사|택시\s*\(주\)|택시$|운수\(주\)|\(주\)[가-힣]*운수$|운수$|운수\s*\d|교통_/;
function normName(n) {
  return String(n || '').toLowerCase()
    .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사/g, '')
    .replace(/[\s·.,\-_()\[\]{}'"&/]+/g, '');
}
// ------------------------------------------------------------

function decode(buf) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (e) { return new TextDecoder('euc-kr').decode(buf); }
}
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = ''; if (row.some(v => v !== '')) rows.push(row); row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const findCol = (head, names) => { for (const n of names) { const i = head.findIndex(h => h.replace(/\s/g, '') === n); if (i >= 0) return i; } for (const n of names) { const i = head.findIndex(h => h.replace(/\s/g, '').includes(n)); if (i >= 0) return i; } return -1; };

const args = process.argv.slice(2);
const id = args[0]; const file = args[1];
const ri = args.indexOf('--region');
const bi = args.indexOf('--basis');   // 파일에 기준일 열이 없을 때 (예: 파일명 "…_20250731" → --basis 2025-07-31)
if (!id || !file || !fs.existsSync(file)) {
  console.error('사용법: node tools/build-merchants.js <dongbaek|onnuri|incheon_eum|…> "파일.csv" [--region 부산]');
  process.exit(1);
}
const set = { ...(SETS[id] || { dir: 'data/merchants/' + id, region: '', label: id, source: '' }) };
if (ri > 0) set.region = args[ri + 1] || '';

const rows = parseCSV(decode(fs.readFileSync(file)));
const head = rows.shift().map(h => String(h).trim());
const iName = findCol(head, ['가맹점명', '상호명', '가맹점명칭', '상호', '점포명', '업체명', '가맹점']);
const iRoad = findCol(head, ['소재지도로명주소', '도로명주소', '가맹점도로명주소']);
const iJibun = findCol(head, ['소재지지번주소', '지번주소', '가맹점지번주소']);
const iAddr = findCol(head, ['가맹점주소', '소재지주소', '소재지', '주소']);
const iSido = findCol(head, ['시도명', '시도']);
const iSgg = findCol(head, ['시군구명', '시군구']);
const iDate = findCol(head, ['데이터기준일자', '기준일자', '기준일']);
const addrCols = [iRoad, iJibun, iAddr].filter((x, i, a) => x >= 0 && a.indexOf(x) === i);
if (iName < 0 || !addrCols.length) { console.error('가맹점명/주소 열을 찾지 못했어요. 첫 줄: ' + head.join(', ')); process.exit(1); }
console.log(`열: 이름=${head[iName]} · 주소=${addrCols.map(i => head[i]).join('+')}${iSido >= 0 ? ' · 시도=' + head[iSido] : ''}${iSgg >= 0 ? ' · 시군구=' + head[iSgg] : ''}`);

// 주소 앞부분을 "시도 시군구 나머지"로 맞춤 (시도·시군구 열이 따로 있으면 보충)
function fullAddr(r, a) {
  a = String(a || '').trim(); if (!a) return '';
  if (!regionShort(a) && iSido >= 0 && r[iSido]) a = `${r[iSido]} ${iSgg >= 0 && r[iSgg] && !a.startsWith(r[iSgg]) ? r[iSgg] + ' ' : ''}${a}`;
  return a;
}
// 1차: 시도별로 실제 쓰이는 시·군·구 이름 모으기 (줄임말 "부산 사하" → "사하구" 맞추기용)
const SGG = {};
const sggTok = (t) => /^[가-힣]+(?:시|군|구)$/.test(t) && t.length >= 2 && !/^(?:광역시|특별시|특별자치시|특별자치도)$/.test(t);
for (const r of rows) for (const c of addrCols) {
  const a = fullAddr(r, r[c]); const sido = regionShort(a); if (!sido) continue;
  const t = a.split(/\s+/)[1] || '';
  if (sggTok(t)) (SGG[sido] || (SGG[sido] = new Set())).add(t);
}
function sggOf(a) {
  const toks = a.split(/\s+/); const sido = regionShort(a); if (!sido) return null;
  if (sido === '세종') return { sido, sgg: '' };
  for (const t of toks.slice(1, 3)) {
    if (sggTok(t) && SGG[sido] && SGG[sido].has(t)) return { sido, sgg: t };
    const hit = SGG[sido] && [...SGG[sido]].filter(x => x.slice(0, -1) === t);
    if (hit && hit.length === 1) return { sido, sgg: hit[0] };
  }
  return { sido, sgg: null };
}

const out = {}; let ok = 0, skip = 0, basis = '', street = 0;
const why = { noName: 0, otherRegion: 0, noSgg: 0, taxi: 0, noNumber: 0 };
for (const r of rows) {
  const raw = r[iName]; const name = normName(raw);
  if (iDate >= 0 && r[iDate] && String(r[iDate]).trim() > basis) basis = String(r[iDate]).trim();
  if (!name) { skip++; why.noName++; continue; }
  if (SKIP_NAME.test(raw)) { skip++; why.taxi++; continue; }
  let placed = false, reason = 'noNumber';
  const seenKey = new Set();
  for (const c of addrCols) {
    const a = fullAddr(r, r[c]); if (!a) continue;
    const g = sggOf(a); if (!g) { reason = 'otherRegion'; continue; }
    if (set.region && g.sido !== set.region) { reason = 'otherRegion'; continue; }
    if (g.sgg === null) { reason = 'noSgg'; continue; }
    const gk = set.region ? (g.sgg || g.sido) : (g.sgg ? `${g.sido} ${g.sgg}` : g.sido);
    let keys = addrKeys(a), isStreet = false;
    if (!keys.length) { keys = streetKeys(a); isStreet = true; }
    if (!keys.length) { reason = 'noNumber'; continue; }
    const m = out[gk] || (out[gk] = {});
    for (const k of keys) {
      if (seenKey.has(gk + k)) continue; seenKey.add(gk + k);
      const list = m[k] || (m[k] = []);
      if (!list.includes(name)) list.push(name);
    }
    if (isStreet && !placed) street++;
    placed = true;
  }
  if (placed) ok++; else { skip++; why[reason]++; }
}

const dir = path.resolve(__dirname, '..', set.dir);
fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) fs.unlinkSync(path.join(dir, f));
if (bi > 0 && args[bi + 1]) basis = args[bi + 1];
const index = { id, label: set.label, region: set.region || '', basis: basis || '', builtAt: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), count: ok, skipped: why, streetOnly: street, source: set.source, gus: {} };
Object.keys(out).sort((a, b) => a.localeCompare(b, 'ko')).forEach((gk, i) => {
  const f = 'g' + String(i + 1).padStart(3, '0') + '.json';
  fs.writeFileSync(path.join(dir, f), JSON.stringify(out[gk]));
  index.gus[gk] = { file: f, n: Object.keys(out[gk]).length };
});
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 1));
const total = Object.values(index.gus).reduce((a, v) => a + fs.statSync(path.join(dir, v.file)).size, 0);
console.log(`완료(${set.label}): 가맹점 ${ok.toLocaleString()}곳 · 제외 ${skip.toLocaleString()}곳 (이름 없음 ${why.noName}, 대상 지역 밖·시도 불명 ${why.otherRegion}, 시군구 불명 ${why.noSgg}, 택시·운수 ${why.taxi}, 번지·길 없음 ${why.noNumber}) · 번지 없이 길·동만 ${street.toLocaleString()} · 기준일 ${basis || '-'}`);
console.log(`  시·군·구 ${Object.keys(index.gus).length}곳 · 파일 합계 ${(total / 1048576).toFixed(1)}MB → ${set.dir}`);
