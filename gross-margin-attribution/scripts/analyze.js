#!/usr/bin/env node
/* Build a machine-readable analysis summary for the agent's written report. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const dataPath = path.resolve(arg('--data', 'work/data.js'));
const corePath = path.resolve(arg('--core', path.join(__dirname, '..', 'assets', 'core.js')));
const outPath = path.resolve(arg('--out', 'work/analysis.json'));

global.window = global;
vm.runInThisContext(fs.readFileSync(dataPath, 'utf8'), { filename: dataPath });
const GM = require(corePath);
const m = GM.build();
if (m.error) {
  console.error(m.error);
  process.exit(1);
}
const t = m.totals;
const D = global.GM_DATA;
const orderDim = m.orderDim;
const orderLabel = orderDim ? GM.dimLabel(orderDim) : '订单';

function take(list, total, cap) {
  const target = Math.abs(total) * 0.8;
  const items = [];
  let cum = 0, reached = false, need = 0;
  for (const p of list) {
    items.push(p);
    cum += p.delta;
    if (Math.abs(cum) >= target - 1e-12) { reached = true; break; }
    if (items.length >= cap) break;
  }
  let c = 0;
  for (const p of list) {
    c += p.delta; need++;
    if (Math.abs(c) >= target - 1e-12) break;
  }
  return {
    items, sum: cum, coverage: total ? cum / total : 0,
    reached, capped: items.length >= cap && !reached && items.length < list.length, need
  };
}

function orderInfo(p, dim, cap) {
  const orders = GM.ordersFor(m, dim, p.key);
  const same = orders.filter(o => p.delta > 0 ? o.delta > 0 : o.delta < 0)
    .sort((a, b) => p.delta > 0 ? b.delta - a.delta : a.delta - b.delta);
  const total = same.reduce((s, o) => s + o.delta, 0);
  const picked = take(same, total, cap);
  return {
    allCount: orders.length,
    sameSignCount: same.length,
    count: same.length, // 兼容旧字段：count 等于同向订单数
    total,
    need: picked.need,
    coverage: picked.coverage,
    capped: picked.capped,
    top: picked.items.slice(0, cap).map(o => ({
      key: o.key, delta: o.delta, dprice: o.dprice, dcost: o.dcost,
      s0: o.s0, s1: o.s1, status: o.status
    }))
  };
}

function itemOut(p, share, dim, cap, negative) {
  return {
    key: p.key,
    delta: p.delta,
    dprice: p.dprice,
    dcost: p.dcost,
    s0: p.s0, k0: p.k0, q0: p.q0,
    s1: p.s1, k1: p.k1, q1: p.q1,
    p0: p.p0, c0: p.c0, p1: p.p1, c1: p.c1,
    gm0: p.gm0, gm1: p.gm1, dgm: p.dgm,
    w0: p.w0, w1: p.w1,
    pull0: p.pull0, pull1: p.pull1,
    shareOfPositive: negative ? undefined : share,
    shareOfNegative: negative ? share : undefined,
    orders: orderInfo(p, dim, cap)
  };
}


function pullItem(p) {
  return {
    key: p.key, status: p.status,
    pull0: p.pull0, pull1: p.pull1,
    w0: p.w0, w1: p.w1,
    gm0: p.gm0, gm1: p.gm1
  };
}

// 拉力水平：回答“谁撑起了本期毛利率”，排序用 pull1，不是 delta。
function supportFor(dim, full) {
  const list = m.byDim[dim] || [];
  const pos = list.filter(p => p.pull1 > 0).sort((a, b) => b.pull1 - a.pull1);
  const neg = list.filter(p => p.pull1 < 0).sort((a, b) => a.pull1 - b.pull1);
  const posTotal = pos.reduce((s, p) => s + p.pull1, 0);
  const negTotal = neg.reduce((s, p) => s + p.pull1, 0);
  const out = {
    dim, label: GM.dimLabel(dim),
    positiveCount: pos.length,
    negativeCount: neg.length,
    positiveTotal: posTotal,
    negativeTotal: negTotal,
    net: posTotal + negTotal,
    truncated: { positive: pos.length > 7, negative: neg.length > 7 },
    positive: pos.slice(0, 7).map(pullItem),
    negative: neg.slice(0, 7).map(pullItem)
  };
  if (full) out.all = pos.concat(neg).map(pullItem);
  return out;
}

const entityDims = m.entityDims;
const dims = entityDims.map(d => {
  const list = m.byDim[d.key] || [];
  const pos = list.filter(p => p.delta > 0).sort((a, b) => b.delta - a.delta);
  const neg = list.filter(p => p.delta < 0).sort((a, b) => a.delta - b.delta);
  const posTotal = pos.reduce((s, p) => s + p.delta, 0);
  const negTotal = neg.reduce((s, p) => s + p.delta, 0);
  const pp = take(pos, posTotal, 7);
  const np = take(neg, negTotal, 7);
  const diag = (D.meta.dimDiagnostics || {})[d.key] || {};
  return {
    key: d.key, label: d.label, role: d.role, count: list.length,
    recommendation: diag.recommendation || null,
    missingRate: diag.missingRate == null ? null : diag.missingRate,
    positiveTotal: posTotal, negativeTotal: negTotal,
    positiveCoverage: posTotal ? pp.sum / posTotal : 0,
    negativeCoverage: negTotal ? np.sum / negTotal : 0,
    truncated: { positive: pp.capped, negative: np.capped },
    pullLevels: supportFor(d.key, d.key === 'customer' || d.key === 'product'),
    // Small dimensions (channel, trade, season) can carry their complete delta
    // list cheaply; product is covered by pullLevels.all instead.
    all: list.length <= 200 ? list.map(p => ({
      key: p.key, delta: p.delta, pull0: p.pull0, pull1: p.pull1,
      s0: p.s0, s1: p.s1, k0: p.k0, k1: p.k1
    })) : undefined,
    positive: pp.items.map(p => itemOut(p, posTotal ? p.delta / posTotal : 0, d.key, 15, false)),
    negative: np.items.map(p => itemOut(p, negTotal ? Math.abs(p.delta / negTotal) : 0, d.key, 15, true))
  };
});

const primary = m.primaryDim;
const plist = m.byDim[primary] || [];
const ppos = plist.filter(p => p.delta > 0).sort((a, b) => b.delta - a.delta);
const pneg = plist.filter(p => p.delta < 0).sort((a, b) => a.delta - b.delta);
const pposTotal = ppos.reduce((s, p) => s + p.delta, 0);
const pnegTotal = pneg.reduce((s, p) => s + p.delta, 0);
const pPick = take(ppos, pposTotal, 7);
const nPick = take(pneg, pnegTotal, 7);

const conclusion = {
  primaryDim: primary,
  primaryLabel: GM.dimLabel(primary),
  headline: '本期毛利率' + (t.dGM >= 0 ? '上升 ' : '下降 ') +
    (Math.abs(t.dGM) * 100).toFixed(2) + 'pp：' +
    (ppos[0] ? ppos[0].key + ' 拉高最多，' : '') +
    (pneg[0] ? pneg[0].key + ' 拉低最多。' : ''),
  positiveTotal: pposTotal,
  negativeTotal: pnegTotal,
  positive: pPick.items.map(p => itemOut(p, pposTotal ? p.delta / pposTotal : 0, primary, 15, false)),
  negative: nPick.items.map(p => itemOut(p, pnegTotal ? Math.abs(p.delta / pnegTotal) : 0, primary, 15, true)),
  positiveCoverage: pposTotal ? pPick.sum / pposTotal : 0,
  negativeCoverage: pnegTotal ? nPick.sum / pnegTotal : 0,
  positiveCapped: pPick.capped,
  negativeCapped: nPick.capped
};

const qc = GM.quadrantConcentration(plist, t);
const qf = GM.migrationFlow(plist, t);
const quadrants = {
  concentration: qc.map(q => ({
    key: q.key, label: q.label, n0: q.n0, n1: q.n1,
    w0: q.w0, w1: q.w1, dw: q.dw
  })),
  paths: qf.paths.slice(0, 12).map(p => ({
    from: p.from, to: p.to, n: p.n, w0: p.w0, w1: p.w1, dw: p.dw,
    memberCount: p.memberCount || p.n,
    members: p.members || []
  }))
};

let orderSummary = null;
if (orderDim) {
  const olist = m.byDim[orderDim] || [];
  const opos = olist.filter(p => p.delta > 0);
  const oneg = olist.filter(p => p.delta < 0);
  orderSummary = {
    count: olist.length,
    positiveCount: opos.length,
    positiveTotal: opos.reduce((s, p) => s + p.delta, 0),
    negativeCount: oneg.length,
    negativeTotal: oneg.reduce((s, p) => s + p.delta, 0)
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  source: D.meta.source,
  sheet: D.meta.sheet,
  periods: { base: D.meta.base, current: D.meta.current },
  rowCount: m.checks.rowCount,
  primaryDim: { key: primary, label: GM.dimLabel(primary) },
  units: D.meta.units || {
    pull: 'fraction of period revenue; 0.0191 = 1.91pp',
    pricePull: 'fraction of period revenue; 0.0191 = 1.91pp',
    costPull: 'fraction of period revenue; 0.0191 = 1.91pp'
  },
  unitPriceNote: D.meta.unitPriceNote || null,
  support: supportFor(primary, true),
  dims,
  dimDiagnostics: D.meta.dimDiagnostics || {},
  orderSummary,
  totals: {
    S0: t.S0, K0: t.K0, S1: t.S1, K1: t.K1,
    R0: t.R0, R1: t.R1, dGM: t.dGM,
    P0: t.P0, P1: t.P1, C0: t.C0, C1: t.C1,
    price1: t.price1, cost1: t.cost1,
    gross0: t.gross0, gross1: t.gross1
  },
  conclusion,
  quadrants,
  quality: D.meta.quality || {},
  checks: {
    rowCount: m.checks.rowCount,
    maxRowCheck: m.checks.maxRowCheck,
    byDim: m.checks.byDim
  }
};

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify({
  out: outPath,
  primary: primary,
  dGM: t.dGM,
  dims: entityDims.map(d => d.key + ':' + d.label),
  positive: conclusion.positive.map(p => p.key),
  negative: conclusion.negative.map(p => p.key)
}, null, 2));
