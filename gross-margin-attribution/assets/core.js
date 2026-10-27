(function (root) {
  'use strict';

  var D = root.GM_DATA;
  var EPS = 1e-9;

  // 固定列只保留分析必需字段；其余维度全部由 meta.dims 动态声明。
  var ROW = { year: 0, order: 1, product: 2, customer: 3, qty: 4, rev: 5, cost: 6 };
  var DIMS = {};
  var DIM_LIST = [];

  function fallbackDims() {
    return [
      { key: 'customer', label: '客户', rowIndex: 3, role: 'entity' },
      { key: 'product', label: '产品', rowIndex: 2, role: 'entity' },
      { key: 'order', label: '订单', rowIndex: 1, role: 'order' }
    ];
  }

  function initDims() {
    DIMS = {};
    DIM_LIST = (D.meta && D.meta.dims && D.meta.dims.length)
      ? D.meta.dims.slice()
      : fallbackDims();
    for (var i = 0; i < DIM_LIST.length; i++) DIMS[DIM_LIST[i].key] = DIM_LIST[i];
  }
  initDims();

  function dimLabel(dim) { return (DIMS[dim] || {}).label || dim; }

  function resolve(row, dim) {
    var d = DIMS[dim];
    if (!d) return null;
    var arr = D.dict[d.dictKey || dim];
    return arr ? arr[row[d.rowIndex]] : null;
  }

  function present(v) { return Math.abs(v) > EPS; }

  function safeGM(s, k) { return s > EPS ? 1 - k / s : null; }

  function blank() {
    return {
      key: '', s0: 0, k0: 0, q0: 0, n0: 0, pull0: 0, price0: 0, cost0: 0,
      s1: 0, k1: 0, q1: 0, n1: 0, pull1: 0, price1: 0, cost1: 0
    };
  }

  function addRow(o, r) {
    if (r.year === 0) {
      o.s0 += r.rev; o.k0 += r.cost; o.q0 += r.qty;
      o.pull0 += r.pull; o.price0 += r.price; o.cost0 += r.costPull; o.n0++;
    } else {
      o.s1 += r.rev; o.k1 += r.cost; o.q1 += r.qty;
      o.pull1 += r.pull; o.price1 += r.price; o.cost1 += r.costPull; o.n1++;
    }
  }

  function finish(o, key) {
    o.key = key;
    o.delta = o.pull1 - o.pull0;
    o.dprice = o.price1 - o.price0;
    o.dcost = o.cost1 - o.cost0;
    o.gm0 = safeGM(o.s0, o.k0);
    o.gm1 = safeGM(o.s1, o.k1);
    o.dgm = (o.gm0 == null || o.gm1 == null) ? null : o.gm1 - o.gm0;
    o.p0 = o.q0 > EPS ? o.s0 / o.q0 : null;
    o.c0 = o.q0 > EPS ? o.k0 / o.q0 : null;
    o.p1 = o.q1 > EPS ? o.s1 / o.q1 : null;
    o.c1 = o.q1 > EPS ? o.k1 / o.q1 : null;
    o.w0 = o.s0 / o._S0;
    o.w1 = o.s1 / o._S1;
    delete o._S0;
    delete o._S1;
    var b = present(o.s0) || present(o.k0) || present(o.q0);
    var c = present(o.s1) || present(o.k1) || present(o.q1);
    o.status = b && c ? 'both' : (c ? 'new' : 'lost');
    o.check = o.delta - (o.dprice + o.dcost);
    return o;
  }

  function rollup(model, dim) {
    var map = new Map();
    var rows = model.rows;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var key = dim === 'order' ? r.order : r[dim];
      var o = map.get(key);
      if (!o) {
        o = blank();
        o._S0 = model.totals.S0;
        o._S1 = model.totals.S1;
        map.set(key, o);
      }
      addRow(o, r);
    }
    var out = [];
    map.forEach(function (o, key) {
      if (!present(o.s0) && !present(o.k0) && !present(o.q0) &&
          !present(o.s1) && !present(o.k1) && !present(o.q1)) return;
      out.push(finish(o, key));
    });
    out.sort(function (a, b) {
      var d = Math.abs(b.delta) - Math.abs(a.delta);
      return d !== 0 ? d : String(a.key).localeCompare(String(b.key), 'zh-Hans-CN');
    });
    return out;
  }

  function ordersFor(model, dim, key) {
    var map = new Map();
    var rows = model.rows;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r[dim] !== key) continue;
      var o = map.get(r.order);
      if (!o) {
        o = blank();
        o._S0 = model.totals.S0;
        o._S1 = model.totals.S1;
        map.set(r.order, o);
      }
      addRow(o, r);
    }
    var out = [];
    map.forEach(function (o, k) { out.push(finish(o, k)); });
    out.sort(function (a, b) {
      var d = Math.abs(b.delta) - Math.abs(a.delta);
      return d !== 0 ? d : String(a.key).localeCompare(String(b.key), 'zh-Hans-CN');
    });
    return out;
  }

  function quadOf(p, c, P0, C0) {
    if (p == null || c == null || !isFinite(p) || !isFinite(c)) return null;
    if (p < 0 || c < 0) return null;
    if (p > P0 && c <= C0) return 'TL';
    if (p <= P0 && c <= C0) return 'BL';
    if (p > P0 && c > C0) return 'TR';
    return 'BR';
  }

  function quadrantSummary(parents, totals) {
    var P0 = totals.P0, C0 = totals.C0, S0 = totals.S0, S1 = totals.S1;
    var q = {
      TL: { n: 0, s0: 0, s1: 0, delta: 0 },
      TR: { n: 0, s0: 0, s1: 0, delta: 0 },
      BL: { n: 0, s0: 0, s1: 0, delta: 0 },
      BR: { n: 0, s0: 0, s1: 0, delta: 0 },
      LOST: { n: 0, s0: 0, s1: 0, delta: 0 },
      UNPLACED: { n: 0, s0: 0, s1: 0, delta: 0, zeroQty: 0, negative: 0, other: 0 }
    };
    for (var i = 0; i < parents.length; i++) {
      var p = parents[i];
      var key;
      if (p.status === 'lost') {
        key = 'LOST';
      } else {
        var qk = quadOf(p.p1, p.c1, P0, C0);
        if (qk) {
          key = qk;
        } else {
          key = 'UNPLACED';
          if (p.q1 <= EPS && (present(p.s1) || present(p.k1))) q.UNPLACED.zeroQty++;
          else if (p.p1 < 0 || p.c1 < 0) q.UNPLACED.negative++;
          else q.UNPLACED.other++;
        }
      }
      var x = q[key];
      x.n++;
      x.s0 += p.s0;
      x.s1 += p.s1;
      x.delta += p.delta;
    }
    var labels = {
      TL: '右下 · 暴利区', TR: '右上 · 附加值区',
      BL: '左下 · 走量区', BR: '左上 · 失血区',
      LOST: '本期无收入 · 流失', UNPLACED: '未定位'
    };
    var order = ['BR', 'TR', 'BL', 'TL', 'LOST', 'UNPLACED'];
    var out = [];
    for (var j = 0; j < order.length; j++) {
      var k = order[j];
      var v = q[k];
      if (!v.n) continue;
      var row = {
        key: k, label: labels[k], n: v.n,
        s0: v.s0, s1: v.s1, delta: v.delta,
        w0: S0 ? v.s0 / S0 : 0, w1: S1 ? v.s1 / S1 : 0
      };
      if (k === 'UNPLACED') {
        row.reasons = { zeroQty: v.zeroQty, negative: v.negative, other: v.other };
      }
      out.push(row);
    }
    return out;
  }

  function quadrantConcentration(parents, totals) {
    var P0 = totals.P0, C0 = totals.C0, S0 = totals.S0, S1 = totals.S1;
    var keys = ['BR', 'TR', 'BL', 'TL', 'UNPLACED'];
    var labels = {
      TL: '右下 · 暴利区', TR: '右上 · 附加值区', BL: '左下 · 走量区',
      BR: '左上 · 失血区', UNPLACED: '未定位'
    };
    var q = {};
    for (var i = 0; i < keys.length; i++) {
      q[keys[i]] = { n0: 0, n1: 0, s0: 0, s1: 0 };
    }
    for (var k = 0; k < parents.length; k++) {
      var p = parents[k];
      if (p.status !== 'new') {
        var k0 = quadOf(p.p0, p.c0, P0, C0) || 'UNPLACED';
        q[k0].n0++; q[k0].s0 += p.s0;
      }
      if (p.status !== 'lost') {
        var k1 = quadOf(p.p1, p.c1, P0, C0) || 'UNPLACED';
        q[k1].n1++; q[k1].s1 += p.s1;
      }
    }
    var out = [];
    for (var j = 0; j < keys.length; j++) {
      var key = keys[j];
      var v = q[key];
      out.push({
        key: key, label: labels[key],
        n0: v.n0, n1: v.n1, s0: v.s0, s1: v.s1,
        w0: S0 ? v.s0 / S0 : 0, w1: S1 ? v.s1 / S1 : 0,
        dw: (S1 ? v.s1 / S1 : 0) - (S0 ? v.s0 / S0 : 0)
      });
    }
    return out;
  }

  function migrationSummary(parents, totals) {
    var P0 = totals.P0, C0 = totals.C0;
    var rows = ['TL', 'TR', 'BL', 'BR', 'NEW', 'UNPLACED'];
    var cols = ['TL', 'TR', 'BL', 'BR', 'LOST', 'UNPLACED'];
    var matrix = {};
    for (var i = 0; i < rows.length; i++) {
      matrix[rows[i]] = {};
      for (var j = 0; j < cols.length; j++) matrix[rows[i]][cols[j]] = 0;
    }
    for (var k = 0; k < parents.length; k++) {
      var p = parents[k];
      var r;
      if (p.status === 'new') r = 'NEW';
      else r = quadOf(p.p0, p.c0, P0, C0) || 'UNPLACED';
      var c;
      if (p.status === 'lost') c = 'LOST';
      else c = quadOf(p.p1, p.c1, P0, C0) || 'UNPLACED';
      matrix[r][c]++;
    }
    return { rows: rows, cols: cols, matrix: matrix, total: parents.length };
  }

  // 迁移路径：按“上期象限 -> 本期象限”汇总对象数、两期收入与收入占比。
  // dw 是该路径自身的份额变化，所有路径合计为 0；它不等同于某个象限的净变化。
  function migrationFlow(parents, totals) {
    var P0 = totals.P0, C0 = totals.C0, S0 = totals.S0, S1 = totals.S1;
    var map = {};
    for (var k = 0; k < parents.length; k++) {
      var p = parents[k];
      var r;
      if (p.status === 'new') r = 'NEW';
      else r = quadOf(p.p0, p.c0, P0, C0) || 'UNPLACED';
      var c;
      if (p.status === 'lost') c = 'LOST';
      else c = quadOf(p.p1, p.c1, P0, C0) || 'UNPLACED';
      var key = r + '>' + c;
      if (!map[key]) map[key] = { from: r, to: c, n: 0, s0: 0, s1: 0, members: [] };
      map[key].n++;
      map[key].s0 += p.s0;
      map[key].s1 += p.s1;
      map[key].members.push(String(p.key));
    }
    var paths = [];
    Object.keys(map).forEach(function (key) {
      var v = map[key];
      var w0 = S0 ? v.s0 / S0 : 0;
      var w1 = S1 ? v.s1 / S1 : 0;
      paths.push({
        from: v.from, to: v.to, n: v.n, s0: v.s0, s1: v.s1,
        w0: w0, w1: w1, dw: w1 - w0,
        memberCount: v.members.length,
        members: v.members.slice(0, 20)
      });
    });
    paths.sort(function (a, b) {
      var d = Math.abs(b.dw) - Math.abs(a.dw);
      return d !== 0 ? d : Math.max(b.w0, b.w1) - Math.max(a.w0, a.w1);
    });
    return { paths: paths, total: parents.length, s0: S0, s1: S1 };
  }

  function build() {
    var i, r;
    var S0 = 0, K0 = 0, Q0 = 0, S1 = 0, K1 = 0, Q1 = 0;
    for (i = 0; i < D.rows.length; i++) {
      r = D.rows[i];
      if (r[ROW.year] === 0) {
        S0 += r[ROW.rev]; K0 += r[ROW.cost]; Q0 += r[ROW.qty];
      } else {
        S1 += r[ROW.rev]; K1 += r[ROW.cost]; Q1 += r[ROW.qty];
      }
    }
    if (S0 <= EPS || S1 <= EPS) {
      return { error: '基准期或本期收入为 0，无法计算。', totals: null, rows: [], byDim: {} };
    }

    var R0 = (S0 - K0) / S0;
    var R1 = (S1 - K1) / S1;
    var P0 = Q0 > EPS ? S0 / Q0 : 0;
    var C0 = Q0 > EPS ? K0 / Q0 : 0;
    var P1 = Q1 > EPS ? S1 / Q1 : 0;
    var C1 = Q1 > EPS ? K1 / Q1 : 0;

    var totals = {
      S0: S0, K0: K0, Q0: Q0, S1: S1, K1: K1, Q1: Q1,
      R0: R0, R1: R1, P0: P0, C0: C0, P1: P1, C1: C1,
      gross0: S0 - K0, gross1: S1 - K1,
      dGM: R1 - R0,
      pull0: 0, pull1: 0, price0: 0, price1: 0, cost0: 0, cost1: 0
    };

    var rows = new Array(D.rows.length);
    var maxRowCheck = 0;
    for (i = 0; i < D.rows.length; i++) {
      r = D.rows[i];
      var y = r[ROW.year];
      var qty = r[ROW.qty];
      var rev = r[ROW.rev];
      var cost = r[ROW.cost];
      var S = y === 0 ? S0 : S1;
      var pull = ((1 - R0) * rev - cost) / S;
      var price = (1 - R0) * (rev - P0 * qty) / S;
      var costPull = (C0 * qty - cost) / S;
      var check = pull - (price + costPull);
      if (Math.abs(check) > maxRowCheck) maxRowCheck = Math.abs(check);
      var row = {
        i: i, year: y, qty: qty, rev: rev, cost: cost,
        unitPrice: (D.meta && D.meta.unitPriceIndex != null && D.meta.unitPriceIndex >= 0)
          ? r[D.meta.unitPriceIndex]
          : (qty > EPS ? rev / qty : null),
        pull: pull, price: price, costPull: costPull
      };
      for (var di = 0; di < DIM_LIST.length; di++) {
        var dd = DIM_LIST[di];
        var arr = D.dict[dd.dictKey || dd.key];
        row[dd.key] = arr ? arr[r[dd.rowIndex]] : null;
      }
      rows[i] = row;
      if (y === 0) {
        totals.price0 += price; totals.cost0 += costPull;
      } else {
        totals.pull1 += pull; totals.price1 += price; totals.cost1 += costPull;
      }
    }
    totals.pricePull = totals.price1;
    totals.costPull = totals.cost1;

    var byDim = {};
    for (var bd = 0; bd < DIM_LIST.length; bd++) {
      byDim[DIM_LIST[bd].key] = rollup({ rows: rows, totals: totals }, DIM_LIST[bd].key);
    }

    var checks = {
      rowCount: rows.length,
      maxRowCheck: maxRowCheck,
      basePullSum: totals.price0 + totals.cost0,
      curPullSum: totals.pull1,
      dGM: totals.dGM,
      price0Sum: totals.price0,
      cost0Sum: totals.cost0,
      price1Sum: totals.price1,
      cost1Sum: totals.cost1,
      byDim: {}
    };
    DIM_LIST.forEach(function (d) {
      var dim = d.key;
      var sum = 0, maxCheck = 0;
      byDim[dim].forEach(function (p) {
        sum += p.delta;
        if (Math.abs(p.check) > maxCheck) maxCheck = Math.abs(p.check);
      });
      checks.byDim[dim] = {
        count: byDim[dim].length,
        deltaSum: sum,
        diff: sum - totals.dGM,
        maxParentCheck: maxCheck
      };
    });

    var entityDims = DIM_LIST.filter(function (d) { return d.role !== 'order'; });
    var quadDims = DIM_LIST.filter(function (d) { return d.role !== 'order' && d.role !== 'slice'; });
    var primaryDim = (D.meta && D.meta.primaryDim) || (entityDims[0] && entityDims[0].key) || DIM_LIST[0].key;
    return {
      totals: totals, rows: rows, byDim: byDim, checks: checks,
      dims: DIM_LIST, entityDims: entityDims, quadDims: quadDims,
      primaryDim: primaryDim, orderDim: (DIMS.order ? 'order' : null)
    };
  }

  var api = {
    D: D, DIMS: DIMS, ROW: ROW,
    build: build,
    rollup: rollup,
    ordersFor: ordersFor,
    quadOf: quadOf,
    quadrantSummary: quadrantSummary,
    quadrantConcentration: quadrantConcentration,
    migrationSummary: migrationSummary,
    migrationFlow: migrationFlow,
    dimLabel: dimLabel,
    resolve: resolve
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  root.GM = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
