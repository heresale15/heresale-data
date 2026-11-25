#!/usr/bin/env node
// 한국조폐공사 지역사랑상품권 가맹점기본정보(CSV) → 앱용 위치 칸(tile) 색인
// 사용법 (web 폴더에서):
//   node tools/build-kc.js "가맹점기본정보.csv" [더 많은 파일.csv …] [--complete] [--basis 2026-11-19]
//   --complete : 전국 전체 자료일 때만 붙이세요. 붙이면 앱이 "목록에 없음"까지 표시하고, 없으면 "확인됨"만 표시해요.
// 자료: 공공데이터포털 "한국조폐공사_지역사랑상품권_가맹점기본정보"(파일) 또는 "통합 가맹점기본정보"(오픈API, tools/fetch-kc.js로 받기)
//   필요한 열: 가맹점명, 위도, 경도, 가맹점주소, 사업자 상태(1 계속 2 휴업 3 폐업), 가맹점 이용상태 구분(1 신규 2 변경 3 해지),
//             가맹점 결제유형 구분명(카드·모바일·지류), 가맹점 구분(ID), 기준일자
// 결과: data/merchants/kc/index.json + data/merchants/kc/g/g0001.json … (시·군·구마다 파일 1개 → 전국 약 250개)
//   시군구 파일: {"t": {"<위도칸>_<경도칸>": [[이름(정규화), 위도*1e5, 경도*1e5, 표시], …]}}  (칸 = 0.02도, 약 2km)
//   표시: 1=폐업·휴업·해지(--keep-closed일 때만 넣음), 2=카드, 4=모바일, 8=지류
//   index.gus: {"서울 구로구": "g0001.json", …}  — 앱이 매장 주소의 시·군·구로 파일을 고름 (app.js kcGuKey와 같은 규칙)
const fs = require('fs');
const path = require('path');
const TILE = 50;   // 시군구 파일 안에서 0.02도 칸으로 나눠 둠 (앱이 매장 근처 칸만 비교)
// ---- 주소 → 시·군·구 열쇠 (app.js의 regionShort·kcGuKey와 같은 규칙) ----
const REGION_ALIAS = [['서울', '서울'], ['부산', '부산'], ['대구', '대구'], ['인천', '인천'], ['광주', '광주'], ['대전', '대전'], ['울산', '울산'], ['세종', '세종'], ['경기', '경기'],
  ['강원', '강원'], ['충청북', '충북'], ['충북', '충북'], ['충청남', '충남'], ['충남', '충남'], ['전라북', '전북'], ['전북', '전북'], ['전라남', '전남'], ['전남', '전남'],
  ['경상북', '경북'], ['경북', '경북'], ['경상남', '경남'], ['경남', '경남'], ['제주', '제주']];
const GJ_GU = ['동구', '서구', '남구', '북구', '광산구'];
const SGG_SKIP = /^(?:광역시|특별시|특별자치시|특별자치도)$/;
function regionShort(text) {
  const t = String(text || '').trim(); if (!t) return '';
  const toks = t.split(/\s+/); const first = toks[0];
  if (/^전남광주/.test(first)) return GJ_GU.includes(toks[1]) ? '광주' : '전남';
  const hit = REGION_ALIAS.find(([k]) => first.startsWith(k)) || REGION_ALIAS.find(([k]) => t.startsWith(k));
  return hit ? hit[1] : '';
}
function kcGuKey(addr) {
  const sido = regionShort(addr); if (!sido) return '';
  const rest = String(addr || '').trim().split(/\s+/).slice(1).filter(x => !SGG_SKIP.test(x));
  const a = rest[0] || '';
  if (/(시|군|구)$/.test(a)) { const b = rest[1] || ''; return /시$/.test(a) && /구$/.test(b) ? `${sido} ${a} ${b}` : `${sido} ${a}`; }
  return sido;
}
const normName = (n) => String(n || '').toLowerCase()
  .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\(자\)/g, '')
  .replace(/[\s·.,\-_()\[\]{}'"&/]+/g, '');   // 앱(app.js)의 dbNorm과 같은 규칙

function decode(buf) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) { return new TextDecoder('euc-kr').decode(buf); }
}
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(v => v !== '')) rows.push(row); row = []; }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const readline = require('readline');
const args = process.argv.slice(2);
// 윈도우 명령창은 *를 풀어 주지 않아서 직접 풀어 줌 (예: ..\kc_data\kc_*.csv)
const files = [];
for (const a of args.filter(x => !x.startsWith('--') && !/^\d{4}-\d{2}-\d{2}$/.test(x))) {
  if (a.includes('*')) {
    const dir = path.dirname(a), re = new RegExp('^' + path.basename(a).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    if (fs.existsSync(dir)) fs.readdirSync(dir).filter(f => re.test(f)).sort().forEach(f => files.push(path.join(dir, f)));
  } else if (fs.existsSync(a)) files.push(a);
}
const complete = args.includes('--complete');
const keepClosed = args.includes('--keep-closed');
const bi = args.indexOf('--basis'); const basisArg = bi >= 0 ? args[bi + 1] : '';
if (!files.length) { console.error('사용법: node tools/build-kc.js "가맹점기본정보.csv" [더 많은 파일 …] [--complete]'); process.exit(1); }

const dir = path.resolve(__dirname, '../data/merchants/kc');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'g'), { recursive: true });
const guFile = {};   // 시군구 열쇠 → 파일 이름
let noGu = 0;
let read = 0, bad = 0, latest = '', open = 0, closedN = 0, closedSkipped = 0;

// 한 줄씩 읽기 (큰 파일도 메모리를 적게 씀). 작은 EUC-KR 파일(포털 샘플)은 통째로 읽음
async function* rowsOf(file) {
  const size = fs.statSync(file).size; const head = Buffer.alloc(3); const fd = fs.openSync(file, 'r'); fs.readSync(fd, head, 0, 3, 0); fs.closeSync(fd);
  const bom = head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF;
  if (size < 60 * 1048576 && !bom) { for (const r of parseCSV(decode(fs.readFileSync(file)))) yield r; return; }
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let pending = '';
  for await (let line of rl) {
    if (pending) { line = pending + '\n' + line; pending = ''; }
    if (((line.match(/"/g) || []).length) % 2 === 1) { pending = line; continue; }   // 따옴표 안 줄바꿈
    const r = parseCSV(line)[0]; if (r) yield r.map((v, i) => i === 0 ? v.replace(/^﻿/, '') : v);
  }
}
(async () => {
  for (const file of files) {
    const best = new Map(); let head = null, I = null;
    for await (const r of rowsOf(file)) {
      if (!head) {
        head = r.map(h => h.trim().replace(/^﻿/, '').replace(/\s/g, ''));
        const col = (n) => head.findIndex(h => h === n.replace(/\s/g, ''));
        I = { id: col('가맹점구분(ID)'), name: col('가맹점명'), lat: col('위도'), lng: col('경도'), biz: col('사업자상태'),
          use: col('가맹점이용상태구분'), pay: col('가맹점결제유형구분명'), date: col('기준일자'), addr: col('가맹점주소') };
        for (const k of ['name', 'lat', 'lng']) if (I[k] < 0) { console.error(`${file}: '${k}' 열이 없어요. 첫 줄: ${head.join(', ')}`); process.exit(1); }
        continue;
      }
      read++;
      const lat = parseFloat(r[I.lat]), lng = parseFloat(r[I.lng]); const name = normName(r[I.name]);
      if (!(lat > 33 && lat < 39 && lng > 124 && lng < 132) || name.length < 2) { bad++; continue; }
      const date = I.date >= 0 ? String(r[I.date] || '').trim() : '';
      if (date > latest) latest = date;
      const key = I.id >= 0 && r[I.id] ? r[I.id] : `${name}|${lat.toFixed(5)}|${lng.toFixed(5)}`;
      const prev = best.get(key); if (prev && prev[4] > date) continue;
      const closed = (I.biz >= 0 && /^0?[23]$/.test(String(r[I.biz]).trim())) || (I.use >= 0 && /^0?3$/.test(String(r[I.use]).trim()));
      if (closed && !keepClosed) { closedSkipped++; best.delete(key); continue; }   // 폐업·해지는 기본으로 빼서 파일을 줄임
      const pay = I.pay >= 0 ? String(r[I.pay] || '') : '';
      const flag = (closed ? 1 : 0) | (/카드/.test(pay) ? 2 : 0) | (/모바일/.test(pay) ? 4 : 0) | (/지류/.test(pay) ? 8 : 0);
      best.set(key, [name, Math.round(lat * 1e5), Math.round(lng * 1e5), flag, date, I.addr >= 0 ? kcGuKey(r[I.addr]) : '']);
    }
    // 이 파일 결과를 시군구 파일에 덧붙임 (파일마다 메모리를 비움)
    const groups = {};
    for (const v of best.values()) {
      if (!v[5]) { noGu++; continue; }
      const g = groups[v[5]] || (groups[v[5]] = {});
      const k = `${Math.floor(v[1] / 1e5 * TILE)}_${Math.floor(v[2] / 1e5 * TILE)}`;
      (g[k] || (g[k] = [])).push(v.slice(0, 4));
      if (v[3] & 1) closedN++; else open++;
    }
    for (const [gk, tiles] of Object.entries(groups)) {
      if (!guFile[gk]) guFile[gk] = `g${String(Object.keys(guFile).length + 1).padStart(4, '0')}.json`;
      const f = path.join(dir, 'g', guFile[gk]);
      const old = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).t : {};
      for (const [k, list] of Object.entries(tiles)) old[k] = (old[k] || []).concat(list);
      fs.writeFileSync(f, JSON.stringify({ t: old }));
    }
    console.log(`  ${path.basename(file)}: ${best.size.toLocaleString()}곳`);
  }
  const index = { id: 'kc', type: 'gu', label: '지역사랑상품권', tile: TILE, complete, basis: basisArg || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10),
    builtAt: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), count: open, closed: closedN,
    source: 'https://www.data.go.kr/data/15108285/openapi.do', gus: guFile };
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  let total = 0, biggest = 0; for (const f of Object.values(guFile)) { const z = fs.statSync(path.join(dir, 'g', f)).size; total += z; biggest = Math.max(biggest, z); }
  console.log(`완료: 읽은 줄 ${read.toLocaleString()} · 좌표 이상 ${bad} · 가맹점 ${open.toLocaleString()}곳 · 빼낸 폐업·해지 ${(closedSkipped + closedN).toLocaleString()}곳 · 주소 불명 ${noGu} · 시군구 파일 ${Object.keys(guFile).length}개 · 전체 ${(total / 1048576).toFixed(1)}MB (가장 큰 파일 ${(biggest / 1048576).toFixed(1)}MB) · 기준 ${index.basis}`);
})();
