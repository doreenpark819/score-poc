#!/usr/bin/env node
// 통계 검증: 앱의 계산이 '산수'뿐 아니라 '추정'으로서 맞는지 확인한다.
//
// 정답지(참값): 생성기가 아는 기대손해(사고 우연성 제거)로 같은 지표를 계산한 값.
//   앱이 실제 손해로 추정한 값이 이 참값을 편향 없이, 알려진 오차 안에서 맞히는지 본다.
//   여러 시드의 기대손해를 합쳐(약 300만 건) 표본 구성 차이까지 평균낸 '모집단 참값'을 쓴다.
// 반복 실험: 시드마다 10만 건을 새로 만들고 index.html의 계산 코드를 그대로 돌린다.
// 신뢰구간: 시드마다 증권 단위 붓스트랩(200회) 95% 구간이 참값을 포함하는 비율(목표 약 95%).
// 권고 정확도: 참값으로 낸 권고(오라클)와 앱 추정값으로 낸 권고의 일치율.
//
// 사용법: node tools/stat_validate.js [반복 수(기본 30)] [붓스트랩 수(기본 200)]
//   결과: tools/stat_validation.json, VALIDATION.md
const fs = require('fs');
const path = require('path');
const { simulate, TRUE_DECILE, TRUE_DELINQ } = require('./gen_dummy');

const ROOT = path.join(__dirname, '..');
const R = Number(process.argv[2] || 30);
const B = Number(process.argv[3] || 200);
const SEEDS = [20261014, ...Array.from({ length: R - 1 }, (_, i) => 1000 + i)];

// index.html 계산 블록을 그대로 실행 (verify.js와 같은 코드, 속도 때문에 vm 대신 Function)
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const block = html.match(/\/\/ @calc-begin[^\n]*\n([\s\S]*?)\/\/ @calc-end/)[1];
const calc = new Function(block + ';return { CONFIG, buildDataset, decileTable, delinqTable, makeRelFns, separation, assessApps };')();
const { CONFIG } = calc;
const UW = CONFIG.UW_RULES.map(r => r.label);
const uwOf = rel => CONFIG.UW_RULES.find(r => rel < r.max).label;

// 생성 결과를 parseFile과 같은 열 구조로 (CSV를 거치지 않고 앱 계산에 바로 넣음)
function toFiles(sim) {
  const table = (rows, spec) => {
    const cols = {};
    for (const [name, idx, num] of spec) cols[name] = rows.map(r => num ? Number(r[idx]) : String(r[idx]));
    return { header: spec.map(s => s[0]), length: rows.length, cols };
  };
  return {
    contracts: table(sim.contracts, [['policy_no', 0], ['customer_id', 1], ['age', 3, 1], ['gender', 4]]),
    coverages: table(sim.contractCov, [['policy_no', 0], ['coverage_code', 1], ['coverage_name', 2], ['sum_insured', 3, 1]]),
    loss: table(sim.loss, [['policy_no', 0], ['coverage_code', 1], ['risk_premium', 3, 1], ['claim_paid', 4, 1], ['reserve_change', 5, 1], ['claim_cnt', 6, 1]]),
    credit: table(sim.credInfo, [['customer_id', 0], ['credit_decile', 4, 1]]),
    delinq: table(sim.credDelinq, [['customer_id', 0], ['default_kcis_cnt', 2, 1], ['default_cb_cnt', 3, 1],
      ['cb_delinq_cnt', 4, 1], ['soho_delinq_cnt', 6, 1], ['default_loanbiz_cnt', 7, 1]]),
    apps: table(sim.apps, [['app_no', 0], ['customer_id', 1], ['age', 3, 1], ['gender', 4]]),
    appCoverages: table(sim.appCov, [['app_no', 0], ['coverage_code', 1], ['coverage_name', 2], ['sum_insured', 3, 1]]),
  };
}

// 칸(10분위 × 연체등급) 합계로 지표 계산: 앱의 추정식은 모두 칸 합계의 함수
const cellIdx = (d, g) => (d - 1) * 3 + g;
function metricsFromCells(prem, loss) {
  let P = 0, L = 0; const dp = Array(10).fill(0), dl = Array(10).fill(0), gp = [0, 0, 0], gl = [0, 0, 0];
  for (let d = 1; d <= 10; d++) for (let g = 0; g < 3; g++) {
    const k = cellIdx(d, g); P += prem[k]; L += loss[k];
    dp[d - 1] += prem[k]; dl[d - 1] += loss[k]; gp[g] += prem[k]; gl[g] += loss[k];
  }
  const overall = L / P, decRel = dl.map((l, i) => (l / dp[i]) / overall);
  const simpleRel = gl.map((l, g) => (l / gp[g]) / overall);
  const adjRel = [0, 1, 2].map(g => {
    let e = 0; for (let d = 1; d <= 10; d++) e += prem[cellIdx(d, g)] * overall * decRel[d - 1];
    return gl[g] / e;
  });
  return { overall, decRel, simpleRel, adjRel };
}

// 칸 단위 분리도 참값: 상대도 순으로 칸을 정렬해 계약 수 기준 하위·상위 10%를 채움(칸 안은 평균)
function separationFromCells(cnt, prem, loss, relOfCell) {
  const cells = [];
  for (let d = 1; d <= 10; d++) for (let g = 0; g < 3; g++) {
    const k = cellIdx(d, g); if (cnt[k]) cells.push({ r: relOfCell(d, g), n: cnt[k], p: prem[k] / cnt[k], l: loss[k] / cnt[k] });
  }
  cells.sort((a, b) => a.r - b.r);
  const N = cells.reduce((s, c) => s + c.n, 0), take = N / 10;
  const edge = list => { let left = take, P = 0, L = 0; for (const c of list) { const m = Math.min(left, c.n); P += m * c.p; L += m * c.l; left -= m; if (left <= 0) break; } return L / P; };
  return edge([...cells].reverse()) / edge(cells);
}

const quant = (arr, q) => { const a = [...arr].sort((x, y) => x - y); const i = (a.length - 1) * q, lo = Math.floor(i); return a[lo] + (a[Math.ceil(i)] - a[lo]) * (i - lo); };
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

// ---------- 반복 실험 ----------
const runs = [];
const popCnt = Array(30).fill(0), popPrem = Array(30).fill(0), popExp = Array(30).fill(0);
const t0 = Date.now();
for (const seed of SEEDS) {
  const sim = simulate({ seed });
  const ds = calc.buildDataset(toFiles(sim));
  const dec = calc.decileTable(ds.policies, { monotone: false });
  const dq = calc.delinqTable(ds.policies, dec), fn = calc.makeRelFns(dec, dq);
  const est = {
    overall: dec.overall, decRel: dec.rows.map(r => r.rel), simpleRel: dq.map(r => r.simpleRel), adjRel: dq.map(r => r.adjRel),
    sepA: calc.separation(ds.policies, fn.A).ratio, sepB: calc.separation(ds.policies, fn.B).ratio,
  };
  // 앱 정책 순서 = 생성 순서 (모두 매칭되므로) → 기대손해 연결
  if (ds.policies.length !== sim.policies.length || ds.policies.some((p, i) => p.policy_no !== sim.policies[i].policy_no)) throw new Error('정책 순서 불일치');
  const n = ds.policies.length, cell = new Uint8Array(n), prem = new Float64Array(n), loss = new Float64Array(n);
  const cPrem = Array(30).fill(0), cLoss = Array(30).fill(0), cExp = Array(30).fill(0), cCnt = Array(30).fill(0);
  ds.policies.forEach((p, i) => {
    const k = cellIdx(p.decile, p.grade); cell[i] = k; prem[i] = p.premium; loss[i] = p.loss;
    cPrem[k] += p.premium; cLoss[k] += p.loss; cExp[k] += sim.policies[i].expLoss; cCnt[k]++;
    popCnt[k]++; popPrem[k] += p.premium; popExp[k] += sim.policies[i].expLoss;
  });
  // 칸 합계 재계산이 앱 결과와 같은지 (지표가 칸 합계의 함수라는 가정 확인)
  const chk = metricsFromCells(cPrem, cLoss);
  const maxGap = Math.max(...chk.decRel.map((v, i) => Math.abs(v - est.decRel[i])), ...chk.adjRel.map((v, g) => Math.abs(v - est.adjRel[g])));
  if (maxGap > 1e-9) throw new Error(`칸 합계 재계산 불일치 ${maxGap}`);
  // 붓스트랩: 증권을 복원추출
  const boot = { decRel: [], adjRel: [], simpleRel: [], overall: [] };
  let bs = seed ^ 0x9e3779b9; // 붓스트랩도 시드 고정 (보고서 재현용)
  const brand = () => { bs = (bs + 0x6D2B79F5) | 0; let t = Math.imul(bs ^ (bs >>> 15), 1 | bs); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  for (let b = 0; b < B; b++) {
    const bp = Array(30).fill(0), bl = Array(30).fill(0);
    for (let j = 0; j < n; j++) { const i = (brand() * n) | 0; bp[cell[i]] += prem[i]; bl[cell[i]] += loss[i]; }
    const m = metricsFromCells(bp, bl);
    boot.decRel.push(m.decRel); boot.adjRel.push(m.adjRel); boot.simpleRel.push(m.simpleRel); boot.overall.push(m.overall);
  }
  const ci = (key, idx) => {
    const v = boot[key].map(x => idx == null ? x : x[idx]);
    return { lo: quant(v, 0.025), hi: quant(v, 0.975), se: sd(v) };
  };
  runs.push({
    seed, est, sampleTruth: metricsFromCells(cPrem, cExp),
    ci: {
      overall: ci('overall'), decRel: est.decRel.map((_, i) => ci('decRel', i)),
      simpleRel: [0, 1, 2].map(g => ci('simpleRel', g)), adjRel: [0, 1, 2].map(g => ci('adjRel', g)),
    },
    apps: sim.appCust.map(a => ({ decile: a.decile, grade: a.grade })),
    appUw: calc.assessApps(ds, dec, dq).map(a => a.status),
  });
  process.stderr.write(`\r반복 ${runs.length}/${SEEDS.length} (${((Date.now() - t0) / 1000).toFixed(0)}초)`);
}
process.stderr.write('\n');

// ---------- 모집단 참값 ----------
const truth = metricsFromCells(popPrem, popExp);
const truthRel = (d, g) => truth.decRel[d - 1] * truth.adjRel[g];
truth.sepA = separationFromCells(popCnt, popPrem, popExp, d => truth.decRel[d - 1]);
truth.sepB = separationFromCells(popCnt, popPrem, popExp, truthRel);

// ---------- 요약 ----------
function summarize(name, truthVal, estOf, ciOf) {
  const est = runs.map(estOf);
  const out = { name, truth: truthVal, mean: mean(est), bias: mean(est) - truthVal, mcSD: sd(est), official: est[0] };
  out.relBias = out.bias / truthVal;
  if (ciOf) {
    const cis = runs.map(ciOf);
    out.bootSE = mean(cis.map(c => c.se));
    out.coverage = cis.filter(c => c.lo <= truthVal && truthVal <= c.hi).length / cis.length;
    out.officialCI = [cis[0].lo, cis[0].hi];
  }
  return out;
}
const rows = [summarize('전체 손해율', truth.overall, r => r.est.overall, r => r.ci.overall)];
for (let d = 0; d < 10; d++) rows.push(summarize(`10분위 상대도 ${d + 1}분위`, truth.decRel[d], r => r.est.decRel[d], r => r.ci.decRel[d]));
const L = CONFIG.DELINQ.LABELS;
for (let g = 0; g < 3; g++) rows.push(summarize(`연체 단순 상대도 ${L[g]}`, truth.simpleRel[g], r => r.est.simpleRel[g], r => r.ci.simpleRel[g]));
for (let g = 0; g < 3; g++) rows.push(summarize(`연체 보정 상대도 ${L[g]}`, truth.adjRel[g], r => r.est.adjRel[g], r => r.ci.adjRel[g]));
rows.push(summarize('분리도 A', truth.sepA, r => r.est.sepA));
rows.push(summarize('분리도 B', truth.sepB, r => r.est.sepB));

// 방향성 검정
const share = f => runs.filter(f).length / runs.length;
const direction = {
  sepBgtA: share(r => r.est.sepB > r.est.sepA),
  adjOrdered: share(r => r.est.adjRel[0] < r.est.adjRel[1] && r.est.adjRel[1] < r.est.adjRel[2]),
  decMonotone: share(r => r.est.decRel.every((v, i, a) => i === 0 || v >= a[i - 1])),
  decInversions: mean(runs.map(r => r.est.decRel.filter((v, i, a) => i > 0 && v < a[i - 1]).length)),
  adj2gt1: share(r => r.ci.adjRel[2].lo > r.est.adjRel[0]),
};

// 권고 정확도: 오라클(참값 상대도) vs 앱
const conf = Object.fromEntries(UW.map(a => [a, Object.fromEntries(UW.map(b => [b, 0]))]));
const agree = runs.map(r => {
  let ok = 0;
  r.apps.forEach((a, i) => { const o = uwOf(truthRel(a.decile, a.grade)); conf[o][r.appUw[i]]++; if (o === r.appUw[i]) ok++; });
  return ok / r.apps.length;
});
// 칸(10분위×연체) 중 참값이 구간 경계(±0.05) 근처인 칸 → 추정 오차로 권고가 갈리기 쉬움
const nearEdge = [];
for (let d = 1; d <= 10; d++) for (let g = 0; g < 3; g++) {
  const r = truthRel(d, g), edge = CONFIG.UW_RULES.slice(0, -1).find(u => Math.abs(r - u.max) < 0.05);
  if (edge) nearEdge.push(`${d}분위·${L[g]} ${r.toFixed(3)} (경계 ${edge.max})`);
}

// DGP 참값과의 관계 (해석용): 10분위 참값은 연체 효과와 섞여 있지 않은 '순수' 효과
const meanTD = TRUE_DECILE.reduce((s, x) => s + x, 0) / 10;
const result = {
  generatedAt: new Date().toISOString(), replications: R, bootstrap: B, policiesPerRun: runs[0] && runs[0].apps ? 100000 : null,
  seeds: SEEDS, truth, rows, direction,
  uw: { agreementMean: mean(agree), agreementMin: Math.min(...agree), agreementMax: Math.max(...agree), confusion: conf, nearEdge },
  dgp: { TRUE_DECILE_normalized: TRUE_DECILE.map(x => x / meanTD), TRUE_DELINQ },
  seconds: (Date.now() - t0) / 1000,
};
fs.writeFileSync(path.join(__dirname, 'stat_validation.json'), JSON.stringify(result, null, 2) + '\n');

// ---------- 보고서 ----------
const f = (x, k = 3) => x == null ? '-' : x.toFixed(k);
const pct = x => (x * 100).toFixed(0) + '%';
const judge = r => {
  const z = Math.abs(r.bias) / (r.mcSD / Math.sqrt(R));
  const biasOk = z < 3 || Math.abs(r.relBias) < 0.01;
  const covOk = r.coverage == null || (r.coverage >= 0.8);
  return biasOk && covOk ? '✅' : '⚠️';
};
let md = `# 통계 검증 보고서 (가상 데이터 v4)

\`node tools/stat_validate.js ${R} ${B}\`로 생성. 소요 ${result.seconds.toFixed(0)}초.

## 무엇을 검증했나
- **정답지(참값)**: 생성기가 아는 **기대손해**(사고 우연성 제거)로 앱과 같은 공식을 계산한 값입니다. ${R}개 시드 × 10만 건, 약 ${(R / 10).toFixed(0)}00만 건을 합친 모집단 값입니다.
- **추정**: 시드마다 10만 건을 새로 만들고, \`index.html\`의 계산 코드를 그대로 돌려 실제 손해로 추정합니다.
- **판정 기준**
  - 편향: 평균 추정값 − 참값이 반복 오차(표준오차/√${R})의 3배 이내이거나, 상대 편향이 1% 이내이면 통과
  - 신뢰구간: 붓스트랩 ${B}회 95% 구간이 참값을 포함하는 비율이 80% 이상이면 통과 (이론값 95%, 반복 ${R}회의 우연 변동 감안)

## 1. 지표별 편향·오차·신뢰구간
| 지표 | 참값 | 평균 추정 | 편향 | 반복 표준편차 | 붓스트랩 SE | 95% 구간 포함률 | 공식 데이터 추정 (95% 구간) | 판정 |
|---|---|---|---|---|---|---|---|---|
`;
for (const r of rows) {
  md += `| ${r.name} | ${f(r.truth)} | ${f(r.mean)} | ${r.bias >= 0 ? '+' : ''}${f(r.bias)} (${(r.relBias * 100).toFixed(1)}%) | ${f(r.mcSD)} | ${f(r.bootSE)} | ${r.coverage == null ? '-' : pct(r.coverage)} | ${f(r.official)}${r.officialCI ? ` (${f(r.officialCI[0], 2)}~${f(r.officialCI[1], 2)})` : ''} | ${judge(r)} |\n`;
}
md += `
- 분리도는 증권 정렬이 필요해 붓스트랩을 생략했습니다. 반복 실험 분포로만 판정합니다.
- **반복 표준편차 ≈ 붓스트랩 SE**이면, 화면 한 번의 결과에 붙일 오차 범위를 붓스트랩으로 구할 수 있다는 뜻입니다.

## 2. 방향성 (반복 ${R}회 중 비율)
| 확인 | 결과 |
|---|---|
| 분리도 B > A (연체정보가 변별력을 더함) | ${pct(direction.sepBgtA)} |
| 보정 상대도 정상 < 연체 < 채무불이행 순서 | ${pct(direction.adjOrdered)} |
| 채무불이행 보정 상대도 95% 하한 > 정상 추정값 (유의한 연체 효과) | ${pct(direction.adj2gt1)} |
| 10분위 상대도가 1→10분위로 역전 없이 증가 | ${pct(direction.decMonotone)} (회당 평균 역전 ${direction.decInversions.toFixed(1)}곳) |

## 3. 권고 정확도 (참값으로 낸 권고 = 오라클 vs 앱 추정)
- 청약 1,000건 기준 일치율: 평균 **${pct(result.uw.agreementMean)}** (최저 ${pct(result.uw.agreementMin)}, 최고 ${pct(result.uw.agreementMax)})
- 참값이 권고 구간 경계(±0.05)에 걸친 칸: ${nearEdge.length ? nearEdge.join(', ') : '없음'}. 이 칸은 추정 오차로 권고가 쉽게 바뀝니다.

| 오라클 \\ 앱 | ${UW.join(' | ')} |
|---|${UW.map(() => '---').join('|')}|
${UW.map(o => `| ${o} | ${UW.map(a => conf[o][a].toLocaleString()).join(' | ')} |`).join('\n')}

## 4. 생성 가정(DGP)과의 관계 (해석)
- 10분위 '순수' 효과(평균 1로 맞춘 값): ${result.dgp.TRUE_DECILE_normalized.map(x => x.toFixed(2)).join(', ')}
- 앱의 10분위 상대도 참값: ${truth.decRel.map(x => x.toFixed(2)).join(', ')}
  - 앱의 상대도는 **연체 효과가 섞인 값**입니다. 불량 분위일수록 연체자가 많아서, 순수 효과보다 양 끝이 더 벌어집니다.
  - 연체 보정 상대도가 그 섞인 몫을 다시 빼는 역할을 합니다.
- 연체 순수 효과: 정상 1 : 연체 ${TRUE_DELINQ[1]} : 채무불이행 ${TRUE_DELINQ[2]} (담보별 민감도로 거듭제곱)
  - 앱 보정 상대도 참값의 비율: 1 : ${(truth.adjRel[1] / truth.adjRel[0]).toFixed(2)} : ${(truth.adjRel[2] / truth.adjRel[0]).toFixed(2)}
  - 손해 비중이 큰 암·뇌심 담보의 민감도가 0.8~1.0이라, 전체 증권 단위로 합치면 순수 효과보다 약하게 나타납니다. 이는 공식이 정의한 대로 맞게 나온 값입니다(추정 편향 아님).
`;
fs.writeFileSync(path.join(ROOT, 'VALIDATION.md'), md);
console.log(md);
