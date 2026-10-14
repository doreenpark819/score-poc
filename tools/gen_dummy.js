#!/usr/bin/env node
// 더미 v4 생성기: 증권 × 담보 단위 데이터 (시드 고정으로 항상 같은 결과)
// 사용법: node tools/gen_dummy.js  → 저장소 루트에 CSV 7개, tools/expected_v4.json 생성
//         require('./gen_dummy').simulate({ seed, nPolicies }) → 파일 없이 메모리로 생성 (통계 검증용)
//
// 생성 가정 (실제 효과 근거 아님, PRD 8장)
//  - 위험보험료 = 연령·성별만 반영한 기대손해 (신용·연체 미반영) → 신용·연체 효과가 손해율 차이로 드러남
//  - 실제 사고빈도 = 기본빈도 × 연령·성별 × 10분위 참값 × 연체 참값^(담보별 민감도)
//  - 연체 여부는 신용 10분위와 상관 (불량 분위일수록 연체·채무불이행 확률 높음) → 단순 상대도 ≠ 보정 상대도
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const N_POLICIES = Number(process.env.N_POLICIES || 100000);
const N_APPS = 1000;
const OBS_END = new Date(Date.UTC(2026, 8, 30)); // 실적 관측 종료 2026-09-30

// ---------- 시드 고정 난수 ----------
let seed = 20261014;
function rand() { // mulberry32
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = arr => arr[Math.floor(rand() * arr.length)];
const pickW = (items, weights) => {
  const s = weights.reduce((a, b) => a + b, 0); let r = rand() * s;
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r < 0) return items[i]; }
  return items[items.length - 1];
};
function poisson(l) { const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rand(); } while (p > L); return k - 1; }
const expo = mean => -Math.log(1 - rand()) * mean;
const MAN = 10000; // 만원

// ---------- 담보 마스터 ----------
// freq: 연간 기본 사고빈도(45세 기준), incl: 증권 내 가입 확률, si: 가입금액 선택지(원)
// ageK: 연령 기울기(연 1세당 로그), sexM/sexF: 성별 계수, dq: 연체 효과 민감도(지수)
// sev: 1건당 지급액 생성 방식
const COVERAGES = [
  { code: 'CV01', name: '일반암',     incl: .85, freq: .0040, ageK: .055, sexM: 1.00, sexF: 1.10, dq: .8, si: [1000, 2000, 3000, 5000].map(x => x * MAN), sev: 'full' },
  { code: 'CV02', name: '유사암',     incl: .80, freq: .0060, ageK: .030, sexM: .60,  sexF: 1.60, dq: .8, si: [100, 200, 300, 500].map(x => x * MAN), sev: 'full' },
  { code: 'CV03', name: '암치료',     incl: .45, freq: .0045, ageK: .055, sexM: 1.00, sexF: 1.10, dq: .8, si: [500, 1000, 2000].map(x => x * MAN), sev: 'part' },
  { code: 'CV04', name: '뇌혈관질환', incl: .60, freq: .0030, ageK: .065, sexM: 1.40, sexF: .70,  dq: 1.0, si: [500, 1000, 2000, 3000].map(x => x * MAN), sev: 'full' },
  { code: 'CV05', name: '심혈관질환', incl: .60, freq: .0030, ageK: .065, sexM: 1.50, sexF: .60,  dq: 1.0, si: [500, 1000, 2000, 3000].map(x => x * MAN), sev: 'full' },
  { code: 'CV06', name: '질병수술',   incl: .70, freq: .0500, ageK: .030, sexM: .95,  sexF: 1.05, dq: 1.0, si: [30, 50, 100].map(x => x * MAN), sev: 'full' },
  { code: 'CV07', name: '재해수술',   incl: .50, freq: .0150, ageK: .010, sexM: 1.30, sexF: .70,  dq: 1.5, si: [30, 50, 100].map(x => x * MAN), sev: 'full' },
  { code: 'CV08', name: '질병입원',   incl: .50, freq: .0600, ageK: .030, sexM: .95,  sexF: 1.05, dq: 1.4, si: [2, 3, 5].map(x => x * MAN), sev: 'days', days: 7 },
  { code: 'CV09', name: '재해입원',   incl: .40, freq: .0300, ageK: .010, sexM: 1.30, sexF: .70,  dq: 1.6, si: [2, 3, 5].map(x => x * MAN), sev: 'days', days: 10 },
  { code: 'CV10', name: '질병장해',   incl: .30, freq: .0015, ageK: .050, sexM: 1.10, sexF: .90,  dq: 1.0, si: [1000, 3000, 5000].map(x => x * MAN), sev: 'rate' },
  { code: 'CV11', name: '재해장해',   incl: .50, freq: .0020, ageK: .010, sexM: 1.40, sexF: .60,  dq: 1.5, si: [1000, 3000, 5000, 10000].map(x => x * MAN), sev: 'rate' },
  { code: 'CV12', name: '암외진단',   incl: .30, freq: .0100, ageK: .040, sexM: 1.00, sexF: 1.00, dq: .8, si: [100, 300, 500].map(x => x * MAN), sev: 'full' },
  { code: 'CV13', name: '기타진단',   incl: .30, freq: .0300, ageK: .020, sexM: 1.00, sexF: 1.00, dq: 1.0, si: [10, 30, 50].map(x => x * MAN), sev: 'full' },
  { code: 'CV14', name: '기타치료',   incl: .30, freq: .0400, ageK: .020, sexM: 1.00, sexF: 1.00, dq: 1.3, si: [10, 30, 50].map(x => x * MAN), sev: 'part' },
];
// 1건당 평균 지급률 (가입금액 대비). days는 일당 × 평균 입원일수
const SEV_MEAN = { full: 1, part: 0.6, rate: 0.15 };
function sevMean(cv, si) { return cv.sev === 'days' ? si * cv.days : si * SEV_MEAN[cv.sev]; }
function sevDraw(cv, si) {
  if (cv.sev === 'full') return si;
  if (cv.sev === 'part') return si * (0.2 + 0.8 * rand());            // 평균 0.6
  if (cv.sev === 'rate') return si * Math.min(1, 0.03 + expo(0.12));   // 평균 약 0.15
  return si * (1 + poisson(cv.days - 1));                             // 평균 days일
}

// ---------- 신용·연체 참값 ----------
const TRUE_DECILE = [0.62, 0.66, 0.70, 0.78, 0.88, 0.97, 1.03, 1.13, 1.40, 1.75];
const TRUE_DELINQ = [1.00, 1.25, 1.50];                  // 정상·연체·채무불이행 (10분위 효과와 별개)
const P_DEFAULT = [.002, .003, .005, .008, .012, .018, .025, .035, .050, .080];
const P_DELINQ  = [.060, .080, .100, .120, .140, .160, .180, .200, .240, .300];

const ageF = (cv, age) => Math.exp(cv.ageK * (age - 45));
const sexF = (cv, g) => g === 'M' ? cv.sexM : cv.sexF;
const round100 = x => Math.round(x / 100) * 100;
const round1000 = x => Math.round(x / 1000) * 1000;
const pad = (n, w) => String(n).padStart(w, '0');
const ymd = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}`;

// ---------- 고객 (계약자 + 청약자) ----------
function makeCustomer(id) {
  const decile = randInt(1, 10);
  const r = rand();
  const grade = r < P_DEFAULT[decile - 1] ? 2 : r < P_DEFAULT[decile - 1] + P_DELINQ[decile - 1] ? 1 : 0;
  const age = randInt(20, 70);
  return { id, decile, grade, age, gender: rand() < .5 ? 'M' : 'F' };
}
function creditRows(c, baseDate) {
  const pctLo = (c.decile - 1) * 10, pctv = +(pctLo + rand() * 10).toFixed(1);
  const score = Math.round(1000 - pctv * 6.5 - rand() * 10);
  const income = Math.round((5200 - c.decile * 180 + (rand() - .5) * 2400) / 10) * 10;
  const info = [c.id, baseDate, score, pctv, c.decile, Math.max(1200, income)];
  // 연체 컬럼: 등급 판정 규칙(PRD ①)과 일치하도록 생성
  let kcis = 0, cb = 0, loanbiz = 0, cbDq = 0, soho = 0;
  if (c.grade === 2) {
    const which = pickW(['kcis', 'cb', 'loanbiz'], [.5, .35, .15]);
    if (which === 'kcis') kcis = randInt(1, 3); else if (which === 'cb') cb = randInt(1, 2); else loanbiz = 1;
    if (rand() < .5) cbDq = randInt(1, 3);
  } else if (c.grade === 1) {
    if (rand() < .8) cbDq = randInt(1, 4); else soho = randInt(1, 2);
  }
  const consumer = cbDq ? randInt(0, cbDq) : 0;
  const h36 = rand() < .95 ? 36 : randInt(12, 35), h12 = Math.min(12, h36);
  const delinq = [c.id, baseDate, kcis, cb, cbDq, consumer, soho, loanbiz, h36, h36, h12, h12];
  return { info, delinq };
}
function chooseCoverages() {
  let list = COVERAGES.filter(cv => rand() < cv.incl);
  if (!list.length) list = [COVERAGES[0]];
  return list.map(cv => ({ cv, si: pick(cv.si) }));
}

// 시드별 생성. 난수 호출 순서를 바꾸지 않아야 공식 데이터(시드 20261014)가 그대로 나온다
// policies[].expLoss = 사고 우연성을 뺀 기대손해 (통계 검증의 정답지)
function simulate({ seed: s = 20261014, nPolicies = N_POLICIES, nApps = N_APPS } = {}) {
seed = s;
// 참값 평균을 1로 맞추는 정규화 (위험보험료 기준 가중이 아닌 고객 단순평균, 근사)
const customers = [];
for (let i = 1; i <= nPolicies; i++) customers.push(makeCustomer('C' + pad(i, 6)));
const norm = customers.reduce((s, c) => s + TRUE_DECILE[c.decile - 1] * TRUE_DELINQ[c.grade], 0) / customers.length;

// ---------- 계약·담보·실적 ----------
const START = Date.UTC(2025, 5, 1), END = Date.UTC(2026, 7, 31);
const contracts = [], contractCov = [], loss = [], credInfo = [], credDelinq = [];
const policies = []; // 독립 계산용 (증권 단위 합계)
customers.forEach((c, i) => {
  const d = new Date(START + Math.floor(rand() * ((END - START) / 864e5 + 1)) * 864e5);
  const policyNo = `P${String(d.getUTCFullYear()).slice(2)}${pad(d.getUTCMonth() + 1, 2)}${pad(i + 1, 5)}`;
  const months = Math.min(15, Math.max(1,
    (OBS_END.getUTCFullYear() - d.getUTCFullYear()) * 12 + OBS_END.getUTCMonth() - d.getUTCMonth()));
  const channel = pickW(['설계사', 'GA', 'TM'], [.49, .35, .16]);
  const baseDate = ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)));
  contracts.push([policyNo, c.id, ymd(d), c.age, c.gender, channel]);
  const cr = creditRows(c, baseDate); credInfo.push(cr.info); credDelinq.push(cr.delinq);

  let pPrem = 0, pLoss = 0, pExp = 0;
  for (const { cv, si } of chooseCoverages()) {
    const base = cv.freq * ageF(cv, c.age) * sexF(cv, c.gender);
    const premium = Math.max(100, round100(base * sevMean(cv, si) * months / 12));
    const credit = TRUE_DECILE[c.decile - 1] * Math.pow(TRUE_DELINQ[c.grade], cv.dq) / norm;
    const lambda = base * credit * months / 12;
    const n = poisson(lambda);
    pExp += lambda * sevMean(cv, si) + premium * 0.01; // 기대 사고손해 + 소액 적립의 기댓값
    let paid = 0, reserve = round100(premium * 0.02 * rand()); // IBNR 성격의 소액 적립
    for (let k = 0; k < n; k++) {
      const amt = round1000(sevDraw(cv, si));
      if (rand() < .25) reserve += amt; else paid += amt;           // 미결 25%는 준비금으로
    }
    contractCov.push([policyNo, cv.code, cv.name, si]);
    loss.push([policyNo, cv.code, months, premium, paid, reserve, n]);
    pPrem += premium; pLoss += paid + reserve;
  }
  policies.push({ policy_no: policyNo, decile: c.decile, grade: c.grade, premium: pPrem, loss: pLoss, expLoss: pExp });
});

// ---------- 청약 ----------
const apps = [], appCov = [], appCust = [];
for (let i = 1; i <= nApps; i++) {
  const c = makeCustomer('N' + pad(i, 6));
  const d = new Date(Date.UTC(2026, 9, randInt(1, 13)));
  const appNo = 'A2610' + pad(i, 5);
  apps.push([appNo, c.id, ymd(d), c.age, c.gender, pickW(['설계사', 'GA', 'TM'], [.49, .35, .16])]);
  const cr = creditRows(c, '2026-09-01'); credInfo.push(cr.info); credDelinq.push(cr.delinq);
  for (const { cv, si } of chooseCoverages()) appCov.push([appNo, cv.code, cv.name, si]);
  appCust.push({ app_no: appNo, decile: c.decile, grade: c.grade });
}
return { contracts, contractCov, loss, credInfo, credDelinq, apps, appCov, appCust, policies };
}
module.exports = { simulate, COVERAGES, TRUE_DECILE, TRUE_DELINQ };

if (require.main === module) {
const { contracts, contractCov, loss, credInfo, credDelinq, apps, appCov, appCust, policies } = simulate();

// ---------- CSV 저장 (UTF-8 BOM, LF) ----------
function writeCsv(name, header, rows) {
  const body = [header.join(','), ...rows.map(r => r.join(','))].join('\n') + '\n';
  fs.writeFileSync(path.join(ROOT, name), '﻿' + body);
  console.log(`${name}: ${rows.length.toLocaleString()}행`);
}
writeCsv('contracts.csv', ['policy_no', 'customer_id', 'contract_date', 'age', 'gender', 'channel'], contracts);
writeCsv('contract_coverages.csv', ['policy_no', 'coverage_code', 'coverage_name', 'sum_insured'], contractCov);
writeCsv('loss_experience.csv', ['policy_no', 'coverage_code', 'exposure_months', 'risk_premium', 'claim_paid', 'reserve_change', 'claim_cnt'], loss);
writeCsv('credit_info.csv', ['customer_id', 'base_date', 'credit_score', 'credit_pct', 'credit_decile', 'income_amt'], credInfo);
writeCsv('credit_delinq.csv', ['customer_id', 'base_date', 'default_kcis_cnt', 'default_cb_cnt', 'cb_delinq_cnt', 'cb_delinq_consumer_cnt',
  'soho_delinq_cnt', 'default_loanbiz_cnt', 'score_hist36_cnt', 'summary_hist36_cnt', 'score_hist12_cnt', 'summary_hist12_cnt'], credDelinq);
writeCsv('applications.csv', ['app_no', 'customer_id', 'app_date', 'age', 'gender', 'channel'], apps);
writeCsv('application_coverages.csv', ['app_no', 'coverage_code', 'coverage_name', 'sum_insured'], appCov);

// ---------- 독립 계산: PRD 6장 정답값 (앱 코드와 별개 구현) ----------
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const LR = a => sum(a, x => x.loss) / sum(a, x => x.premium);
const overall = LR(policies);
const decRel = [], decCnt = [];
for (let d = 1; d <= 10; d++) { const g = policies.filter(p => p.decile === d); decRel.push(LR(g) / overall); decCnt.push(g.length); }
const gradeCnt = [], simpleRel = [], adjRel = [];
for (let g = 0; g <= 2; g++) {
  const ps = policies.filter(p => p.grade === g);
  gradeCnt.push(ps.length);
  simpleRel.push(LR(ps) / overall);
  adjRel.push(sum(ps, p => p.loss) / sum(ps, p => p.premium * overall * decRel[p.decile - 1]));
}
function separation(relOf) {
  const sorted = [...policies].sort((a, b) => relOf(a) - relOf(b) || (a.policy_no < b.policy_no ? -1 : 1));
  const size = sorted.length / 10;
  return LR(sorted.slice(9 * size)) / LR(sorted.slice(0, size));
}
const relA = p => decRel[p.decile - 1];
const relB = p => decRel[p.decile - 1] * adjRel[p.grade];
const uw = r => r < 1.0 ? '표준인수' : r < 1.3 ? '한도축소' : r < 1.6 ? '부담보+한도축소' : '심사역검토';
const uwCnt = { 표준인수: 0, 한도축소: 0, '부담보+한도축소': 0, 심사역검토: 0 };
for (const a of appCust) uwCnt[uw(decRel[a.decile - 1] * adjRel[a.grade])]++;

const expected = {
  policies: policies.length, coverageRows: loss.length, overallLR: overall,
  decileRel: decRel, decileCnt: decCnt, gradeCnt, simpleRel, adjRel,
  separationA: separation(relA), separationB: separation(relB),
  apps: N_APPS, appCoverageRows: appCov.length, uwCnt,
  truth: { TRUE_DECILE, TRUE_DELINQ, dqSensitivity: Object.fromEntries(COVERAGES.map(c => [c.name, c.dq])) },
};
fs.writeFileSync(path.join(__dirname, 'expected_v4.json'), JSON.stringify(expected, null, 2) + '\n');
const f2 = x => x.toFixed(2);
console.log('\n[독립 계산 결과]');
console.log('계약', policies.length, '/ 담보행', loss.length, '/ 전체 손해율', (overall * 100).toFixed(1) + '%');
console.log('10분위 상대도', decRel.map(f2).join(', '));
console.log('연체등급 계약 수', gradeCnt.join(' / '), '| 단순', simpleRel.map(f2).join(' / '), '| 보정', adjRel.map(f2).join(' / '));
console.log('분리도 A / B', f2(expected.separationA), '/', f2(expected.separationB));
console.log('청약 권고(B)', JSON.stringify(uwCnt));
}
