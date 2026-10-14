#!/usr/bin/env node
// index.html의 계산 블록(@calc-begin ~ @calc-end)을 그대로 실행해 PRD 6장 정답값과 비교한다.
// 사용법: node verify.js [단계번호(기본: 마지막 구현 단계)]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = __dirname;
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const m = html.match(/\/\/ @calc-begin[^\n]*\n([\s\S]*?)\/\/ @calc-end/);
if (!m) { console.error('index.html에서 @calc-begin ~ @calc-end 블록을 찾지 못했습니다.'); process.exit(2); }

const ctx = vm.createContext({});
// const 선언은 컨텍스트 전역 프로퍼티가 되지 않으므로 필요한 이름을 명시적으로 꺼낸다
vm.runInContext(m[1] + '\n;globalThis.__calc = { CONFIG, FILE_SPECS, parseCSV, detectFileType, buildDataset, lossRatio, decileTable };', ctx);
const calc = ctx.__calc;

// 화면과 같은 경로: 파일을 읽어 헤더로 종류 판별
const files = {};
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.csv'))) {
  const parsed = calc.parseCSV(fs.readFileSync(path.join(dir, f), 'utf8'));
  const key = calc.detectFileType(parsed.header);
  if (key) files[key] = parsed.records;
  else console.warn(`인식 실패: ${f}`);
}
// PRD 6장 정답값은 제외 상품 없음(전체 10,000건) 기준
const ds = calc.buildDataset(files, { excludeProducts: [] });
// 앱 기본값(CONFIG.EXCLUDE_PRODUCTS) 적용 결과: 정답값 없음, 참고용
const dsApp = calc.buildDataset(files);

const TOL = 0.01;
const rows = [];
function check(step, item, expected, actual, { exact = false, fmt = v => String(v) } = {}) {
  const diff = actual - expected;
  const pass = exact ? actual === expected : Math.abs(diff) <= TOL + 1e-12;
  rows.push({ step, item, expected: fmt(expected), actual: fmt(actual),
    diff: exact ? (diff === 0 ? '0' : String(diff)) : (diff >= 0 ? '+' : '') + diff.toFixed(4),
    pass });
}

const STEPS = {
  1() {
    check(1, '분석 계약 수', 10000, ds.counts.analyzed, { exact: true, fmt: v => v.toLocaleString('en-US') + '건' });
    check(1, '전체 손해율', 0.998, calc.lossRatio(ds.policies), { fmt: v => (v * 100).toFixed(2) + '%' });
  },
  2() {
    const expected = [0.63, 0.68, 0.68, 0.81, 0.90, 1.03, 0.92, 1.12, 1.47, 1.77];
    const { rows } = calc.decileTable(ds.policies);
    expected.forEach((e, i) => check(2, `10분위 상대도 ${i + 1}분위`, e, rows[i].rel, { fmt: v => v.toFixed(4) }));
  },
};

// 참고표: 전체 vs 앱 기본값(제외 상품 적용)
const REFERENCE = {
  1() {
    return [['분석 계약 수', ds.counts.analyzed, dsApp.counts.analyzed],
      ['전체 손해율', pct(calc.lossRatio(ds.policies)), pct(calc.lossRatio(dsApp.policies))]];
  },
  2() {
    const a = calc.decileTable(ds.policies).rows, b = calc.decileTable(dsApp.policies).rows;
    return a.map((r, i) => [`${i + 1}분위 상대도`, r.rel.toFixed(2), b[i].rel.toFixed(2)]);
  },
};
const pct = v => (v * 100).toFixed(1) + '%';

const upTo = Number(process.argv[2] || Object.keys(STEPS).length);
for (let s = 1; s <= upTo; s++) if (STEPS[s]) STEPS[s]();

console.log(`인식 파일: ${Object.keys(files).join(', ')} | 버전: ${ds.hasDelinq ? 'A+B' : 'A'}`);
console.log(`매칭: ${JSON.stringify(ds.counts)}`);
console.log('');
console.log('| 단계 | 항목 | 기대값 | 계산값 | 차이 | 결과 |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.step} | ${r.item} | ${r.expected} | ${r.actual} | ${r.diff} | ${r.pass ? '✅' : '❌'} |`);
const failed = rows.filter(r => !r.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} 통과 (허용오차 ±${TOL}, 건수는 정확히 일치)`);

const exclLabel = dsApp.excludeProducts.length ? dsApp.excludeProducts.join(', ') + ' 제외' : '제외 없음';
console.log(`\n[참고] 앱 기본값(${exclLabel}) 적용 시. 정답값 없음`);
console.log(`| 항목 | 전체 (PRD 기준) | ${exclLabel} |`);
console.log('|---|---|---|');
for (let s = 1; s <= upTo; s++) if (REFERENCE[s]) for (const r of REFERENCE[s]()) console.log(`| ${r.join(' | ')} |`);
process.exit(failed ? 1 : 0);
