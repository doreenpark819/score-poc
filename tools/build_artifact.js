#!/usr/bin/env node
// claude.ai Artifact판 만들기: index.html + 데모 CSV를 Artifact 규격에 맞춰 출력한다.
//  - 문서 뼈대(doctype/html/head/body)는 Artifact가 감싸므로 제거하고 <title>·<style>·본문만 남김
//  - window.__ARTIFACT__ 표시: 열자마자 데모 로드, AI 도우미는 Claude(sample), CSV 저장은 downloads 기능
//  - Artifact는 파일당 16MB 제한 → 큰 CSV는 줄 단위로 나눠 각 조각에 헤더를 붙임
// 사용법: node tools/build_artifact.js <출력 폴더>
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist-artifact'));
const PART_BYTES = 14 * 1024 * 1024;
const DEMO_FILES = ['contracts.csv', 'contract_coverages.csv', 'loss_experience.csv', 'credit_info.csv',
  'credit_delinq.csv', 'applications.csv', 'application_coverages.csv'];

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

// 1) CSV 나누기
const parts = {}, files = {};
for (const name of DEMO_FILES) {
  // 한글은 UTF-8로 3바이트라 문자 수가 아니라 바이트 단위로 자른다
  const buf = fs.readFileSync(path.join(ROOT, name));
  const nl = buf.indexOf(0x0a);
  const header = buf.subarray(0, nl + 1);
  const headerNoBom = header[0] === 0xef ? header.subarray(3) : header;
  const chunks = [];
  if (buf.length <= PART_BYTES) chunks.push(buf);
  else {
    let pos = nl + 1;
    while (pos < buf.length) {
      let end = Math.min(buf.length, pos + PART_BYTES - header.length);
      if (end < buf.length) end = buf.lastIndexOf(0x0a, end - 1) + 1;
      chunks.push(Buffer.concat([chunks.length ? headerNoBom : header, buf.subarray(pos, end)]));
      pos = end;
    }
  }
  parts[name] = chunks.map((c, i) => {
    const rel = chunks.length === 1 ? `data/${name}` : `data/${name.replace(/\.csv$/, '')}.${i + 1}.csv`;
    fs.writeFileSync(path.join(OUT, rel), c);
    if (c.length > 16 * 1024 * 1024) throw new Error(`${rel} 16MB 초과`);
    files[rel] = rel;
    return rel;
  });
}

// 2) 페이지
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1]
  .replace(/<meta charset[^>]*>\s*/i, '')
  .replace(/<meta name="viewport"[^>]*>\s*/i, '');
// claude.ai Artifact판에는 회사 로고(CI)를 싣지 않음 (공개 가능한 페이지에 실제 회사 브랜드를 넣지 않기 위함)
const body = html.match(/<body>([\s\S]*?)<\/body>/)[1]
  .replace(/const BRAND = \{.*\}; \/\/ @brand-logo/, "const BRAND = { name: '', logo: '' }; // @brand-logo");
const flag = `<script>window.__ARTIFACT__ = ${JSON.stringify({ autoDemo: true, parts })};</script>\n`;
const page = head.trim() + '\n' + flag + body.trim() + '\n';
fs.writeFileSync(path.join(OUT, 'index.html'), page);

const total = Object.keys(files).reduce((s, f) => s + fs.statSync(path.join(OUT, f)).size, 0);
console.log(JSON.stringify({ out: OUT, pageBytes: Buffer.byteLength(page), dataBytes: total, files: Object.keys(files) }, null, 2));
