#!/usr/bin/env node
// 회사 로고(CI)를 index.html 머리글에 넣는다. 이미지를 data URI로 파일 안에 넣으므로 단일 HTML·내부망에서도 그대로 표시된다.
// 사용법: node tools/set_logo.js <로고 파일(.svg/.png/.jpg)> "<회사명>"   · 로고 빼기: node tools/set_logo.js --clear
// 공식 CI 파일(사내 브랜드 가이드 원본)을 쓰고, 사내 CI 사용 규정을 확인할 것
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'index.html');
const MIME = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const [arg, name = ''] = process.argv.slice(2);
if (!arg) { console.error('사용법: node tools/set_logo.js <로고 파일> "<회사명>" | --clear'); process.exit(1); }

let value = { name: '', logo: '' };
if (arg !== '--clear') {
  const mime = MIME[path.extname(arg).toLowerCase()];
  if (!mime) { console.error('지원 형식: .svg .png .jpg .jpeg .webp'); process.exit(1); }
  const buf = fs.readFileSync(arg);
  if (buf.length > 300 * 1024) console.warn(`경고: 로고 파일이 ${Math.round(buf.length / 1024)}KB로 큽니다. 300KB 이하 권장`);
  value = { name, logo: `data:${mime};base64,${buf.toString('base64')}` };
}
const html = fs.readFileSync(FILE, 'utf8');
const re = /const BRAND = \{.*\}; \/\/ @brand-logo/;
if (!re.test(html)) { console.error('index.html에서 로고 자리(@brand-logo)를 찾지 못했습니다'); process.exit(1); }
fs.writeFileSync(FILE, html.replace(re, `const BRAND = ${JSON.stringify(value)}; // @brand-logo`));
console.log(value.logo ? `로고를 넣었습니다 (${name || '이름 없음'}, ${Math.round(value.logo.length / 1024)}KB)` : '로고를 뺐습니다');
