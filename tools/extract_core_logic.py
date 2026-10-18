#!/usr/bin/env python3
"""제출용 핵심 로직 추출: 구현된 코드를 수정 없이 그대로 잘라 .txt 파일로 저장한다.

- index.html 의 계산 블록(// @calc-begin ~ // @calc-end): 설정값, CSV 판별·자동 검토·전처리,
  손해율·상대도·연체 보정·종합상대도·스코어·권고 인수조건·분리도·교차 검증·신뢰구간·세그먼트 계산
- api/chat.js: AI 도우미 서버 중계 함수
- 화면 디자인(<style>, HTML 마크업)과 화면 표시 코드는 넣지 않는다
- 인증정보로 보이는 실제 값이 있으면 <REDACTED>로 가린다 (API 키는 원래 환경변수에서만 읽음)

사용법: python3 tools/extract_core_logic.py [출력 경로]
"""
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'submission' / 'score_poc_core_logic.txt'

# 실제 비밀값 형태만 가린다 (환경변수 이름 등 코드는 그대로 둔다)
SECRET_PATTERNS = [
    re.compile(r'sk-or-v1-[A-Za-z0-9]{20,}'),                       # OpenRouter 키
    re.compile(r'sk-[A-Za-z0-9_\-]{20,}'),                           # 일반 API 키
    re.compile(r'(?i)((?:api[_-]?key|secret|password|token)\s*[:=]\s*)([\'"])[^\'"\s]{6,}\2'),
]


def redact(text):
    count = 0
    for pat in SECRET_PATTERNS:
        if pat.groups >= 2:
            text, n = pat.subn(lambda m: f'{m.group(1)}{m.group(2)}<REDACTED>{m.group(2)}', text)
        else:
            text, n = pat.subn('<REDACTED>', text)
        count += n
    return text, count


def calc_block(html):
    lines = html.split('\n')
    start = next(i for i, l in enumerate(lines) if '// @calc-begin' in l)
    end = next(i for i, l in enumerate(lines) if '// @calc-end' in l)
    return '\n'.join(lines[start:end + 1]), start + 1, end + 1


def main():
    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    calc, s, e = calc_block(html)
    chat = (ROOT / 'api' / 'chat.js').read_text(encoding='utf-8').rstrip('\n')
    parts = [
        ('index.html', f'{s}-{e}행 (계산 블록)', calc),
        ('api/chat.js', '전체', chat),
    ]
    out, total_redacted = [], 0
    for name, where, code in parts:
        code, n = redact(code)
        total_redacted += n
        digest = hashlib.sha256(code.encode('utf-8')).hexdigest()[:16]
        out.append(f'// ===== 파일: {name} · {where} · sha256 {digest} =====\n{code}\n')
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text('\n'.join(out), encoding='utf-8')
    print(f'저장: {OUT} ({OUT.stat().st_size:,} bytes, 가린 인증정보 {total_redacted}건)')


if __name__ == '__main__':
    main()
