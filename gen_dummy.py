"""심사 스코어 PoC 더미데이터 생성 v3 (seed=42)
- credit_info.csv   : 활용가능 항목 (신용평점, 상위%, 10분위, 소득수준)
- credit_delinq.csv : 연체·채무불이행 수신건수 10항목 (v3, 사내 호출 항목 기준) - 포함/미포함 2버전 비교용으로 분리
"""
import numpy as np, pandas as pd
from datetime import date
rng = np.random.default_rng(42)
N, A = 10000, 50
BASE = date(2026, 9, 30)

PROD = {'건강종합':1.0,'암':1.2,'실손':0.8}; PROD_P=[.5,.3,.2]
SEV_MEAN = 3_000_000; BASE_RATE = 0.00110           # 월 위험보험료율(가입금액 대비)
DECILE_RATE = lambda d: 0.07 * 1.11 ** (d - 1)      # 10분위별 연간 청구확률: 1분위 7% → 10분위 18%
DELINQ_F = {0:1.0, 1:1.25, 2:1.50, 3:2.20}          # 연체등급의 추가 설명력(신용평점 외)
def income_f(amt):                                   # 소득 낮을수록 소폭 상승
    return 1.10 if amt < 3000 else 1.05 if amt < 5000 else 1.0 if amt < 7000 else 0.95 if amt < 10000 else 0.90
def delinq_p(score):
    if score >= 800: return [.95,.04,.01,.00]
    if score >= 650: return [.80,.12,.06,.02]
    if score >= 500: return [.55,.20,.15,.10]
    return [.30,.25,.25,.20]

def months_between(d1, d2): return (d2.year-d1.year)*12 + d2.month-d1.month

# ---- 계약
start = pd.Timestamp('2025-06-01').toordinal(); end = pd.Timestamp('2026-08-31').toordinal()
cdates = [date.fromordinal(int(x)) for x in rng.integers(start, end+1, N)]
cust = [f'C{i:06d}' for i in range(1, N+1)]
contracts = pd.DataFrame(dict(
    policy_no=[f'P{d:%y%m}{i:05d}' for i, d in enumerate(cdates, 1)],
    customer_id=cust, contract_date=[d.isoformat() for d in cdates],
    age=rng.integers(20, 71, N), gender=rng.choice(['M','F'], N),
    product_type=rng.choice(list(PROD), N, p=PROD_P),
    sum_insured=rng.choice([10,20,30,40,50], N, p=[.15,.25,.3,.15,.15])*1_000_000,
    channel=rng.choice(['설계사','GA','TM'], N, p=[.5,.35,.15])))

# ---- 청약
app_cust = [f'N{i:06d}' for i in range(1, A+1)]
apps = pd.DataFrame(dict(app_no=[f'A2610{i:05d}' for i in range(1, A+1)], customer_id=app_cust,
    app_date=[date(2026,10,int(d)).isoformat() for d in rng.integers(1,10,A)],
    age=rng.integers(20,71,A), gender=rng.choice(['M','F'],A),
    product_type=rng.choice(list(PROD),A,p=PROD_P),
    sum_insured=rng.choice([10,20,30,40,50],A)*1_000_000, channel=rng.choice(['설계사','GA','TM'],A)))

# ---- 신용정보 (계약자 + 청약자)
ids = cust + app_cust
bds = [date(d.year if d.month>1 else d.year-1, d.month-1 if d.month>1 else 12, 1).isoformat() for d in cdates] + ['2026-10-01']*A
score = np.clip(rng.normal(780, 130, len(ids)), 250, 1000).astype(int)
# 상위%: 점수 높을수록 상위. 계약자 모집단 기준 순위 → 청약자는 같은 기준으로 환산
order = np.lexsort((rng.random(N), -score[:N]))           # 점수 내림차순, 동점은 무작위
pct = np.empty(len(ids)); pct[order] = (np.arange(N) + 1) / N * 100
ref = np.sort(score[:N])
pct[N:] = [100 * (1 - np.searchsorted(ref, s, side='right') / N) for s in score[N:]]
pct = np.clip(pct, 0.1, 100.0).round(1)
decile = np.ceil(pct / 10).astype(int).clip(1, 10)          # 1분위 = 상위 10%(우량)
income = np.clip(rng.lognormal(np.log(4500) + (score-780)/1300, 0.45), 1200, 30000).round(-1).astype(int)
credit = pd.DataFrame(dict(customer_id=ids, base_date=bds, credit_score=score,
                           credit_pct=pct, credit_decile=decile, income_amt=income))
grade = np.array([rng.choice(4, p=delinq_p(sc)) for sc in score])   # 잠재 연체수준 (생성용, CSV에는 미포함)
ages = np.concatenate([contracts.age.values, apps.age.values])
def ri(lo, hi): return int(rng.integers(lo, hi+1))
drows = []
for cid, bd, g, ag in zip(ids, bds, grade, ages):
    d = dict(customer_id=cid, base_date=bd, default_kcis_cnt=0, default_cb_cnt=0, cb_delinq_cnt=0,
             cb_delinq_consumer_cnt=0, soho_delinq_cnt=0, default_loanbiz_cnt=0)
    soho = rng.random() < 0.10                                     # 개인사업자 약 10%
    if g == 1:                                                     # 연체 1건
        if soho and rng.random() < 0.3: d['soho_delinq_cnt'] = 1
        else: d['cb_delinq_cnt'] = 1
        d['cb_delinq_consumer_cnt'] = int(d['cb_delinq_cnt'] and rng.random() < 0.4)
    elif g == 2:                                                   # 다중연체 2건 이상
        d['cb_delinq_cnt'] = ri(2, 5); d['cb_delinq_consumer_cnt'] = ri(0, d['cb_delinq_cnt'])
        if soho: d['soho_delinq_cnt'] = ri(0, 2)
    elif g == 3:                                                   # 채무불이행 등록
        d['default_kcis_cnt'] = ri(1, 3)
        d['default_cb_cnt'] = ri(0, d['default_kcis_cnt'])         # 같은 건이 두 경로로 들어올 수 있음
        d['default_loanbiz_cnt'] = int(rng.random() < 0.35) * ri(1, 2)
        d['cb_delinq_cnt'] = ri(0, 5); d['cb_delinq_consumer_cnt'] = ri(0, d['cb_delinq_cnt'])
        if soho: d['soho_delinq_cnt'] = ri(0, 3)
    thin = rng.random() < (0.25 if ag < 30 else 0.05)              # 신용이력 짧은 고객(thin file)
    h12 = ri(1, 11) if thin else 12; h36 = ri(h12, 35) if thin else 36
    d.update(score_hist36_cnt=h36, summary_hist36_cnt=h36 if rng.random() > .02 else h36-1,
             score_hist12_cnt=h12, summary_hist12_cnt=h12)
    drows.append(d)
delinq = pd.DataFrame(drows)
delinq['lat_g'] = grade   # 생성 검증용, 저장 시 제외

# ---- 손해율 실적
m = contracts.merge(credit, on='customer_id').merge(delinq[['customer_id','lat_g']], on='customer_id')
rows = []
for r in m.itertuples():
    exp_m = max(1, months_between(date.fromisoformat(r.contract_date), BASE))
    af = np.exp(0.03*(r.age-45)); pf = PROD[r.product_type]
    rp = int(round(r.sum_insured*BASE_RATE*af*pf*exp_m/1000)*1000)
    lam = DECILE_RATE(r.credit_decile) * DELINQ_F[r.lat_g] * income_f(r.income_amt) * af * pf * exp_m / 12
    n = rng.poisson(lam)
    sev = rng.lognormal(np.log(SEV_MEAN)-0.5*0.5**2, 0.5, n) if n else []
    paid = int(sum(min(s, r.sum_insured) for s in sev)//1000*1000)
    rc = int(rp*rng.uniform(0, 0.10)//1000*1000)
    rows.append(dict(policy_no=r.policy_no, exposure_months=exp_m, risk_premium=rp,
                     claim_paid=paid, reserve_change=rc, claim_cnt=int(n)))
loss = pd.DataFrame(rows)

uw = pd.DataFrame([
 dict(rel_min=0.0,rel_max=1.0,decision='표준인수',limit_ratio=1.0,exclusion='N',note='전체 평균 이하 위험'),
 dict(rel_min=1.0,rel_max=1.3,decision='한도축소',limit_ratio=0.7,exclusion='N',note='가입금액 70%까지'),
 dict(rel_min=1.3,rel_max=1.6,decision='부담보+한도축소',limit_ratio=0.5,exclusion='Y',note='부담보 부가, 가입금액 50%'),
 dict(rel_min=1.6,rel_max=99.0,decision='심사역검토',limit_ratio=0.0,exclusion='Y',note='자동인수 불가')])

if __name__ == '__main__':
    import os; os.makedirs('dummy', exist_ok=True)
    for name, df in [('contracts',contracts),('credit_info',credit),('credit_delinq',delinq.drop(columns='lat_g')),
                     ('loss_experience',loss),('applications',apps),('uw_rules',uw)]:
        df.to_csv(f'dummy/{name}.csv', index=False, encoding='utf-8-sig')
