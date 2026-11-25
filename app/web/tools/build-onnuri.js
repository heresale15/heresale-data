#!/usr/bin/env node
// 온누리상품권 가맹점 CSV(소상공인시장진흥공단_전국 온누리상품권 가맹점 현황) → 앱용 시·도별 이름 색인
// 사용법 (web 폴더에서): node tools/build-onnuri.js "내려받은파일_20260731.csv"
// 이 자료에는 상세 주소가 없고(소재지 = 시·도), 가맹점명·소속 시장명만 있어요.
// 그래서 앱은 "같은 시·도 + 같은 가게 이름"으로 찾고, 소속 시장이 매장 근처에 있는지 카카오로 한 번 더 확인해요.
// 결과: data/merchants/onnuri/index.json + 시·도별 JSON { m: [시장명…], n: { 정규화이름: [시장번호(종이만 가능하면 음수)] } }
const fs = require('fs');
const path = require('path');

const normName = (n) => String(n || '').toLowerCase()
  .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\(자\)/g, '')
  .replace(/[\s·.,\-_()\[\]{}'"&/]+/g, '');   // 앱(app.js)의 dbNorm과 같은 규칙
const SIDO = { '서울': 'seoul', '부산': 'busan', '대구': 'daegu', '인천': 'incheon', '전남광주': 'jngj', '광주': 'jngj', '전남': 'jngj', '대전': 'daejeon', '울산': 'ulsan',
  '세종': 'sejong', '경기': 'gyeonggi', '강원': 'gangwon', '충북': 'chungbuk', '충남': 'chungnam', '전북': 'jeonbuk', '경북': 'gyeongbuk', '경남': 'gyeongnam', '제주': 'jeju' };

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

const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.error('사용법: node tools/build-onnuri.js "전국 온누리상품권 가맹점 현황.csv"'); process.exit(1); }
const basisArg = (process.argv.indexOf('--basis') > 0) ? process.argv[process.argv.indexOf('--basis') + 1] : '';
const fm = path.basename(file).match(/(20\d{2})(\d{2})(\d{2})/);
const basis = basisArg || (fm ? `${fm[1]}-${fm[2]}-${fm[3]}` : '');

const rows = parseCSV(decode(fs.readFileSync(file)));
const head = rows.shift().map(h => h.trim().replace(/\s/g, ''));
const col = (...names) => names.map(n => head.findIndex(h => h.includes(n))).find(i => i >= 0);
const iName = col('가맹점명'), iMkt = col('소속시장', '시장명'), iSido = col('소재지'), iDig = col('디지털'), iPaper = col('지류');
if ([iName, iMkt, iSido].some(i => i === undefined || i < 0)) { console.error('열을 찾지 못했어요: ' + head.join(', ')); process.exit(1); }

const out = {}; let ok = 0, skip = 0, paperOnly = 0;
for (const r of rows) {
  const sido = String(r[iSido] || '').trim(); const key = SIDO[sido];
  const name = normName(r[iName]); const mkt = String(r[iMkt] || '').trim();
  if (!key || name.length < 2 || !mkt) { skip++; continue; }
  const g = out[key] || (out[key] = { m: [], mi: new Map(), n: {} });
  let mi = g.mi.get(mkt); if (mi === undefined) { mi = g.m.length; g.m.push(mkt); g.mi.set(mkt, mi); }
  const digital = iDig === undefined || String(r[iDig]).trim().toUpperCase() !== 'N';
  if (!digital) paperOnly++;
  const v = digital ? mi : -(mi + 1);
  const list = g.n[name] || (g.n[name] = []);
  if (!list.includes(v) && !list.includes(digital ? -(mi + 1) : mi)) list.push(v);
  else if (digital && list.includes(-(mi + 1))) list[list.indexOf(-(mi + 1))] = mi;   // 같은 시장에 디지털 가능 기록이 있으면 그쪽 우선
  ok++;
}
const dir = path.resolve(__dirname, '../data/merchants/onnuri');
fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) fs.unlinkSync(path.join(dir, f));
const index = { id: 'onnuri', type: 'name', label: '온누리상품권', basis, builtAt: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), count: ok, paperOnly,
  source: 'https://www.data.go.kr/data/3060079/fileData.do', note: '원본에 상세 주소가 없어 시·도 + 가게 이름 + 소속 시장으로 확인', gus: {} };
const KEY_NAME = { jngj: '전남광주' };
for (const [key, g] of Object.entries(out)) {
  const f = key + '.json';
  fs.writeFileSync(path.join(dir, f), JSON.stringify({ m: g.m, n: g.n }));
  const sidoName = KEY_NAME[key] || Object.keys(SIDO).find(k => SIDO[k] === key);
  index.gus[sidoName] = { file: f, n: Object.keys(g.n).length, markets: g.m.length };
}
fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 1));
const total = Object.values(index.gus).reduce((a, v) => a + fs.statSync(path.join(dir, v.file)).size, 0);
console.log(`완료: 온누리 가맹점 ${ok.toLocaleString()}곳 (종이만 ${paperOnly.toLocaleString()}곳) · 제외 ${skip} · 기준일 ${basis || '-'} · 시·도 ${Object.keys(index.gus).length}곳 · ${(total / 1048576).toFixed(1)}MB`);
