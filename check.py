"""올리기 전 형식 검사. 문제가 있으면 종료 코드 1."""
import json, re, sys, datetime
D = re.compile(r'^\d{4}-\d{2}-\d{2}$'); today = datetime.date.today().isoformat(); err = []
b = json.load(open('benefits.json', encoding='utf-8')); p = json.load(open('promos.json', encoding='utf-8')); t = json.load(open('points.json', encoding='utf-8'))
ids = [c['id'] for c in b['cards']]
if len(ids) != len(set(ids)): err.append('카드 id 중복')
if len(ids) < 10: err.append('카드가 너무 적음')
for c in b['cards']:
    for r in c.get('rules', []):
        if not (r.get('brands') or r.get('cats') or r.get('all')): err.append(f"{c['id']}: 대상 없음")
        if not ((isinstance(r.get('rate'), (int, float)) and 0 < r['rate'] <= 80) or (isinstance(r.get('amount'), (int, float)) and r['amount'] > 0)): err.append(f"{c['id']}: 비율·금액 이상")
for lc in b.get('localCurrencies', []):
    if lc.get('rate') is not None and not (0 < lc['rate'] <= 50): err.append(f"{lc['id']}: 할인율 이상")
for x in p.get('promos', []):
    if not str(x.get('src', '')).startswith('https://'): err.append(f"{x.get('id')}: 출처 없음")
    if not (x.get('end') or x.get('recur')): err.append(f"{x.get('id')}: 기간 없음")
    if x.get('end') and not D.match(x['end']): err.append(f"{x.get('id')}: 날짜 형식")
for pg in t.get('programs', []):
    for br, m in pg.get('merchants', {}).items():
        if not (0 < m.get('rate', 0) <= 100): err.append(f"{pg['id']}/{br}: 비율 이상")
        if not str(m.get('src', '')).startswith('https://'): err.append(f"{pg['id']}/{br}: 출처 없음")
        if not D.match(str(m.get('reviewBy', ''))): err.append(f"{pg['id']}/{br}: reviewBy 형식")
print('문제 없음' if not err else '\n'.join(err)); sys.exit(1 if err else 0)
