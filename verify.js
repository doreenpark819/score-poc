#!/usr/bin/env node
// index.html의 계산 블록(@calc-begin ~ @calc-end)을 그대로 실행해 PRD 6장 정답값(더미 v4)과 비교한다.
// '독립 계산' 열은 tools/gen_dummy.js가 앱 코드와 별개로 계산한 값(tools/expected_v4.json)이다.
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
vm.runInContext(m[1] + '\n;globalThis.__calc = { CONFIG, FILE_SPECS, parseFile, buildDataset, lossRatio, decileTable, delinqTable, makeRelFns, separation, segmentTable };', ctx);
const calc = ctx.__calc;
const indep = JSON.parse(fs.readFileSync(path.join(dir, 'tools', 'expected_v4.json'), 'utf8'));

// 화면과 같은 경로: 파일을 읽어 헤더로 종류 판별
const t0 = Date.now();
const files = {};
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.csv'))) {
  const parsed = calc.parseFile(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (parsed.key) files[parsed.key] = parsed;
  else console.warn(`인식 실패: ${f}`);
}
const ds = calc.buildDataset(files);
const elapsed = Date.now() - t0;

const TOL = 0.01;
const rows = [];
function check(step, item, expected, actual, independent, { exact = false, fmt = v => String(v) } = {}) {
  const diff = actual - expected;
  const pass = exact ? actual === expected : Math.abs(diff) <= TOL + 1e-12;
  rows.push({ step, item, expected: fmt(expected), actual: fmt(actual), indep: fmt(independent),
    diff: exact ? (diff === 0 ? '0' : String(diff)) : (diff >= 0 ? '+' : '') + diff.toFixed(4), pass });
}
const f4 = v => v.toFixed(4);

// PRD 6장 정답값 (더미 v4, 소수 둘째 자리)
const STEPS = {
  1() {
    check(1, '분석 계약 수', 100000, ds.counts.analyzed, indep.policies,
      { exact: true, fmt: v => v.toLocaleString('en-US') + '건' });
    check(1, '담보 행 수', 709730, ds.cov.length, indep.coverageRows,
      { exact: true, fmt: v => v.toLocaleString('en-US') + '행' });
    check(1, '전체 손해율', 0.946, calc.lossRatio(ds.policies), indep.overallLR,
      { fmt: v => (v * 100).toFixed(2) + '%' });
  },
  2() {
    const expected = [0.62, 0.67, 0.71, 0.84, 0.82, 0.86, 1.10, 1.00, 1.47, 1.96];
    const { rows: dec } = calc.decileTable(ds.policies);
    expected.forEach((e, i) => check(2, `10분위 상대도 ${i + 1}분위`, e, dec[i].rel, indep.decileRel[i], { fmt: f4 }));
  },
  3() {
    const dec = calc.decileTable(ds.policies), dq = calc.delinqTable(ds.policies, dec), fn = calc.makeRelFns(dec, dq);
    const L = ['정상', '연체', '채무불이행'];
    [81849, 15801, 2350].forEach((e, g) => check(3, `연체등급 계약 수 ${g} ${L[g]}`, e, dq[g].n, indep.gradeCnt[g],
      { exact: true, fmt: v => v.toLocaleString('en-US') + '건' }));
    [0.92, 1.33, 1.71].forEach((e, g) => check(3, `연체 단순 상대도 ${g} ${L[g]}`, e, dq[g].simpleRel, indep.simpleRel[g], { fmt: f4 }));
    [0.96, 1.14, 1.23].forEach((e, g) => check(3, `연체 보정 상대도 ${g} ${L[g]}`, e, dq[g].adjRel, indep.adjRel[g], { fmt: f4 }));
    check(3, '분리도 A', 3.16, calc.separation(ds.policies, fn.A).ratio, indep.separationA, { fmt: f4 });
    check(3, '분리도 B', 3.37, calc.separation(ds.policies, fn.B).ratio, indep.separationB, { fmt: f4 });
  },
};

// 정답값 없는 참고 출력
const REFERENCE = {
  3() {
    const dec = calc.decileTable(ds.policies);
    const segs = calc.segmentTable(ds, dec, { dim: 'coverage' });
    const sens = indep.truth.dqSensitivity, [, d1, d2] = indep.truth.TRUE_DELINQ;
    console.log('\n[참고] 담보별 정상 대비 보정 배수 vs 생성 참값 (* = 사고 ' + calc.CONFIG.SEGMENT.MIN_CLAIMS + '건 미만, 신뢰 부족)');
    console.log('| 담보 | 사고(정상/연체/채무불이행) | 연체 배수 | 참값 | 채무불이행 배수 | 참값 |');
    console.log('|---|---|---|---|---|---|');
    for (const s of segs) {
      const [c0, c1, c2] = s.cells, k = sens[s.key];
      const m = c => (c.multiple == null ? '-' : c.multiple.toFixed(2)) + (c.credible ? '' : '*');
      console.log(`| ${s.key} | ${c0.claims}/${c1.claims}/${c2.claims} | ${m(c1)} | ${Math.pow(d1, k).toFixed(2)} | ${m(c2)} | ${Math.pow(d2, k).toFixed(2)} |`);
    }
    for (const dim of ['age', 'gender']) {
      const t = calc.segmentTable(ds, dec, { dim });
      console.log(`\n[참고] ${dim === 'age' ? '연령대' : '성별'}: ` + t.map(s =>
        `${s.key} 손해율 ${s.cells.map(c => (c.lr * 100).toFixed(0) + '%').join('/')} 채무불이행 배수 ${s.cells[2].multiple.toFixed(2)}`).join(' · '));
    }
  },
};

const upTo = Number(process.argv[2] || Object.keys(STEPS).length);
for (let s = 1; s <= upTo; s++) if (STEPS[s]) STEPS[s]();

console.log(`인식 파일: ${Object.keys(files).join(', ')} | 버전: ${ds.hasDelinq ? 'A+B' : 'A'} | 파싱+조인 ${elapsed}ms`);
console.log(`매칭: ${JSON.stringify(ds.counts)}`);
console.log('');
console.log('| 단계 | 항목 | PRD 정답값 | 앱 계산값 | 차이 | 독립 계산 | 결과 |');
console.log('|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.step} | ${r.item} | ${r.expected} | ${r.actual} | ${r.diff} | ${r.indep} | ${r.pass ? '✅' : '❌'} |`);
const failed = rows.filter(r => !r.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} 통과 (허용오차 ±${TOL}, 건수는 정확히 일치)`);
for (let s = 1; s <= upTo; s++) if (REFERENCE[s]) REFERENCE[s]();
process.exit(failed ? 1 : 0);
