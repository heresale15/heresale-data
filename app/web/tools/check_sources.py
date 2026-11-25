#!/usr/bin/env python3
"""benefits.json의 출처(src) 페이지 변경과 확인 기한(reviewBy)을 검사해 report.md를 만든다.
사용: python tools/check_sources.py data/benefits.json data/source_state.json report.md
- 출처 페이지 본문이 지난번과 달라졌으면 '확인 필요'로 보고 (자동 수정은 하지 않음)
- reviewBy가 14일 안으로 다가왔거나 지났으면 보고 (지난 항목은 앱이 이미 계산에서 빼고 있음)
"""
import datetime, hashlib, html, json, re, sys, urllib.request

data_path, state_path, report_path = sys.argv[1:4]
data = json.load(open(data_path, encoding='utf-8'))
try:
    state = json.load(open(state_path, encoding='utf-8'))
except FileNotFoundError:
    state = {}
today = datetime.date.today()

items = []  # (이름, src, reviewBy)
for c in data.get('cards', []):
    items.append((c['name'], c.get('src'), c.get('reviewBy')))
for code, c in data.get('carriers', {}).items():
    items.append((c['name'], c.get('src'), c.get('reviewBy')))
for lc in data.get('localCurrencies', []):
    if lc.get('src'):
        items.append((lc['name'], lc.get('src'), lc.get('reviewBy')))
for brand, evs in data.get('events', {}).items():
    for e in evs:
        items.append((f"{brand}: {e['title']}", e.get('src'), e.get('reviewBy')))

def page_hash(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (heresale source checker)'})
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read().decode('utf-8', 'ignore')
    raw = re.sub(r'(?is)<(script|style|noscript)[^>]*>.*?</\1>', ' ', raw)
    text = html.unescape(re.sub(r'<[^>]+>', ' ', raw))
    # 숫자·퍼센트·원이 들어간 문장만 비교 (광고·날짜 위젯 변화에 덜 민감하게)
    lines = sorted(set(l.strip() for l in re.split(r'[\n.。]', text) if re.search(r'\d+\s*(%|원|만원|천원)', l)))
    return hashlib.sha256('\n'.join(lines).encode()).hexdigest()

changed, failed, due = [], [], []
seen = {}
for name, src, review in items:
    if review:
        d = datetime.date.fromisoformat(review)
        if d - today <= datetime.timedelta(days=14):
            due.append(f"- {name} — 확인 기한 {review}{' (지남: 앱에서 계산 제외 중)' if d < today else ''}")
    if not src or src in seen:
        continue
    seen[src] = None
    try:
        h = page_hash(src)
    except Exception as e:  # noqa
        failed.append(f"- {src} ({type(e).__name__})"); continue
    seen[src] = h
    if state.get(src) and state[src] != h:
        changed.append(f"- [{name}]({src})")
    state[src] = h

json.dump(state, open(state_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
parts = []
if changed: parts.append('## 출처 페이지 내용이 바뀜 — 혜택이 달라졌는지 확인하세요\n' + '\n'.join(changed))
if due: parts.append('## 확인 기한이 다가오거나 지남\n' + '\n'.join(due))
if failed: parts.append('## 출처를 열지 못함\n' + '\n'.join(failed))
open(report_path, 'w', encoding='utf-8').write('\n\n'.join(parts))
print('\n\n'.join(parts) or '변경 없음')
