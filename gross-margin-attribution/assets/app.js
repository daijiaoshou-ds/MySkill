(function () {
  'use strict';

  var D = window.GM_DATA;
  var GM = window.GM;
  var PERIOD0 = cleanPeriod(D.meta.base);
  var PERIOD1 = cleanPeriod(D.meta.current);
  var Y0 = '上期';
  var Y1 = '本期';
  var model = null;
  var currentOrderData = null;
  var quadPoints = [];

  var state = {
    dim: 'customer',
    search: '',
    groups: { pos: { open: true, all: false }, neg: { open: true, all: false } },
    supportDim: 'customer',
    supportPeriod: 'current',
    supportGroups: { pos: { open: true }, neg: { open: true } },
    supportOpenKey: null,
    supportFold: false,
    quadLevel: 'customer',
    quadMode: 'current',
    quadPeriod: 'current',
    openKey: null
  };

  // 结论截断规则：累计到 80% 或达到数量上限，先到先止。
  var SUPPORT_FOLD = 0.0001; // |pull| < 0.01pp 的小值可显式折叠

  var PARETO = {
    threshold: 0.8,
    customers: 7,
    orders: 15
  };

  var Q_META = {
    TL: { short: '右下', name: '暴利区', color: '#a9791f' },
    TR: { short: '右上', name: '附加值区', color: '#45628f' },
    BL: { short: '左下', name: '走量区', color: '#2f7d7a' },
    BR: { short: '左上', name: '失血区', color: '#a14f45' }
  };

  function cleanPeriod(s) {
    return String(s == null ? '' : s).replace(/年度$/, '').trim();
  }

  function $(s) { return document.querySelector(s); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function pct(v, d) {
    if (v == null || !isFinite(v)) return '—';
    d = d == null ? 2 : d;
    var x = v * 100;
    if (Math.abs(x) < 0.5 * Math.pow(10, -d)) x = 0;
    return x.toFixed(d) + '%';
  }

  function spct(v, d) {
    if (v == null || !isFinite(v)) return '—';
    d = d == null ? 2 : d;
    var x = v * 100;
    if (Math.abs(x) < 0.5 * Math.pow(10, -d)) x = 0;
    var s = x.toFixed(d) + '%';
    return x > 0 ? '+' + s : s;
  }

  function pp(v, d) {
    if (v == null || !isFinite(v)) return '—';
    d = d == null ? 2 : d;
    var x = v * 100;
    if (Math.abs(x) < 0.5 * Math.pow(10, -d)) x = 0;
    return x.toFixed(d) + '%';
  }

  function spp(v, d) {
    if (v == null || !isFinite(v)) return '—';
    d = d == null ? 2 : d;
    var x = v * 100;
    if (Math.abs(x) < 0.5 * Math.pow(10, -d)) x = 0;
    var s = x.toFixed(d) + '%';
    return x > 0 ? '+' + s : s;
  }

  function fmtPpDelta(v) {
    if (v == null || !isFinite(v)) return '—';
    var x = v * 100;
    if (Math.abs(x) < 0.005) return '0.00%';
    return (x > 0 ? '↑ +' : '↓ −') + Math.abs(x).toFixed(2) + '%';
  }

  function cls(v) {
    if (v == null || !isFinite(v) || Math.abs(v * 100) < 0.005) return '';
    return v > 0 ? 'pos' : 'neg';
  }

  function fmtNum(v, d) {
    if (v == null || !isFinite(v)) return '—';
    return v.toFixed(d == null ? 2 : d);
  }

  function fmtWan(v, d) {
    if (v == null || !isFinite(v)) return '—';
    var x = v / 1e4;
    var ax = Math.abs(x);
    var digits = d == null ? (ax >= 0.01 || ax === 0 ? 2 : 3) : d;
    if (ax < 0.0005) x = 0;
    return x.toLocaleString('zh-CN', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
  }

  function fmtMoney(v) {
    if (v == null || !isFinite(v)) return '—';
    return fmtWan(v) + ' 万元';
  }

  // 统一涨跌色：增加 = 绿，减少 = 红。
  // 不按“成本越低越好”翻转，保证经营大盘里所有指标同一套规则。
  function trendCls(v) {
    if (v == null || !isFinite(v) || Math.abs(v * 100) < 0.005) return '';
    return v > 0 ? 'pos' : 'neg';
  }

  function chgChip(v) {
    if (v == null || !isFinite(v)) return '<span class="chg">—</span>';
    return '<span class="chg ' + trendCls(v) + '">' + spp(v) + '</span>';
  }

  function fmtQty(v) {
    if (v == null || !isFinite(v)) return '—';
    if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + ' 万';
    return Math.round(v).toLocaleString('zh-CN');
  }

  function fmtAxis(v) {
    if (v >= 10000) return trim(v / 10000) + '万';
    if (v >= 1000) return trim(v / 1000) + '千';
    if (v >= 1) return trim(v);
    if (v >= 0.1) return String(Math.round(v * 10) / 10);
    return String(Math.round(v * 100) / 100);
  }
  function trim(n) { return String(Number(n.toFixed(1))); }

  function sumBy(arr, fn) {
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += fn(arr[i]);
    return s;
  }

  function statusText(s) { return s === 'new' ? '新增' : s === 'lost' ? '流失' : '两期'; }
  function statusBadge(s) {
    if (s === 'new') return '<span class="badge new">新增</span>';
    if (s === 'lost') return '<span class="badge lost">流失</span>';
    return '';
  }
  function orderTag(s) {
    if (s === 'new') return '<span class="tag new">仅本期</span>';
    if (s === 'lost') return '<span class="tag lost">仅上期</span>';
    return '<span class="tag both">两期</span>';
  }
  function orderKeyHTML(key) {
    return esc(key) + (/^ROW-/.test(String(key)) ? ' <span class="tag row">行号</span>' : '');
  }

  function qShort(k) {
    return { TL: '右下', TR: '右上', BL: '左下', BR: '左上', NEW: '新增', LOST: '流失', UNPLACED: '未定位' }[k] || k;
  }
  function qLong(k) {
    return {
      TL: '右下 · 暴利区', TR: '右上 · 附加值区', BL: '左下 · 走量区', BR: '左上 · 失血区',
      NEW: '上期无收入（新增）', LOST: '本期无收入（流失）', UNPLACED: '未定位'
    }[k] || k;
  }
  function qName(k) {
    if (k === 'NEW') return '新增';
    if (k === 'LOST') return '流失';
    if (k === 'UNPLACED') return '未定位';
    var m = Q_META[k];
    return m ? m.short + ' · ' + m.name : k;
  }

  function renderIntro() {
    var t = model.totals;
    var dir = t.dGM >= 0 ? '上升' : '下降';
    $('#period-pill').textContent = Y0 + ' ' + PERIOD0 + ' → ' + Y1 + ' ' + PERIOD1;
    $('#hero-line').innerHTML = Y1 + '毛利率 <b>' + pct(t.R1) + '</b>，较' + Y0 +
      ' <b>' + pct(t.R0) + '</b> ' + dir + ' <b class="hero-delta ' + cls(t.dGM) + '">' +
      pp(Math.abs(t.dGM)) + '</b>。';
    var delta = $('#hero-delta');
    delta.textContent = spp(t.dGM);
    delta.className = 'hero-stat-v ' + cls(t.dGM);
    $('#hero-sub').textContent = pct(t.R0) + ' → ' + pct(t.R1);
    $('#hero-pills').innerHTML =
      '<span>价格拉力 <b class="' + cls(t.price1) + '">' + spp(t.price1) + '</b></span>' +
      '<span>成本拉力 <b class="' + cls(t.cost1) + '">' + spp(t.cost1) + '</b></span>';
    var src = (GM.D.meta && GM.D.meta.source) || '当前数据';
    var q = (GM.D.meta && GM.D.meta.quality) || {};
    var quality = [];
    if (q.skippedInvalidRows) quality.push('跳过 ' + q.skippedInvalidRows + ' 行');
    if (q.generatedOrderRows) quality.push('行号订单 ' + q.generatedOrderRows + ' 行');
    $('#source').textContent = '数据：' + src + ' · ' + model.checks.rowCount.toLocaleString('zh-CN') +
      ' 行 · ' + Y0 + ' ' + PERIOD0 + ' vs ' + Y1 + ' ' + PERIOD1 + ' · 总额单位：万元' +
      (quality.length ? ' · 数据质量：' + quality.join('，') : '');
  }

  function dimensionTabsHTML(dims, active, attr) {
    var html = '';
    var diag = (GM.D.meta && GM.D.meta.dimDiagnostics) || {};
    for (var i = 0; i < dims.length; i++) {
      var d = dims[i];
      var note = '';
      var title = d.label;
      if (d.role === 'slice') {
        note = ' <span class="tab-note">切片</span>';
        title += '：时间切片，只做汇总和导出，不做象限 / 迁移';
      } else if (diag[d.key] && diag[d.key].recommendation === 'not_recommended') {
        note = ' <span class="tab-note warn">弱</span>';
        title += '：' + ((diag[d.key].reasons || []).join('；'));
      } else if (diag[d.key] && diag[d.key].recommendation === 'needs_reason') {
        note = ' <span class="tab-note warn">需理由</span>';
        title += '：' + ((diag[d.key].reasons || []).join('；'));
      }
      title = String(title).replace(/pp/g, '%');
      html += '<button data-' + attr + '="' + esc(d.key) + '"' +
        (d.key === active ? ' class="active"' : '') + ' title="' + esc(title) + '">' +
        esc(d.label) + note + '</button>';
    }
    return html;
  }

  function renderDimAlert() {
    var el = $('#dim-alert');
    if (!el) return;
    var diag = (GM.D.meta && GM.D.meta.dimDiagnostics) || {};
    var weak = (model.entityDims || []).filter(function (d) {
      var x = diag[d.key];
      return x && (x.recommendation === 'not_recommended' || x.recommendation === 'needs_reason');
    });
    if (!weak.length) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    var parts = [];
    for (var i = 0; i < weak.length; i++) {
      var d = weak[i];
      var x = diag[d.key];
      var rs = (x.reasons || []).slice(0, 2).join('；');
      parts.push(esc(d.label) + '（' +
        (x.recommendation === 'not_recommended' ? '不建议' : '需理由') +
        (rs ? '：' + esc(rs) : '') + '）');
    }
    el.hidden = false;
    el.innerHTML = '<b>维度提示</b> ' + parts.join(' · ') +
      '。这些维度仍可切换，但不要把单极维度的差异写成主结论。';
  }

  function renderDimensionTabs() {
    $('#dim-tabs').innerHTML = dimensionTabsHTML(model.entityDims, state.dim, 'dim');
    renderDimAlert();
    var quadDims = model.quadDims || [];
    if (!quadDims.length) {
      $('#quad-section').hidden = true;
      return;
    }
    $('#quad-section').hidden = false;
    var hasLevel = false;
    for (var i = 0; i < quadDims.length; i++) {
      if (quadDims[i].key === state.quadLevel) hasLevel = true;
    }
    if (!hasLevel) state.quadLevel = quadDims[0].key;
    $('#quad-tabs').innerHTML = dimensionTabsHTML(quadDims, state.quadLevel, 'level');
  }

  function paretoTake(list, total, cap) {
    var items = [], cum = 0, reached = false, need = 0;
    var target = Math.abs(total) * PARETO.threshold;
    for (var i = 0; i < list.length; i++) {
      items.push(list[i]);
      cum += list[i].delta;
      if (Math.abs(cum) >= target - 1e-12) { reached = true; break; }
      if (items.length >= cap) break;
    }
    var c = 0;
    for (var k = 0; k < list.length; k++) {
      c += list[k].delta;
      need++;
      if (Math.abs(c) >= target - 1e-12) break;
    }
    var capped = items.length >= cap && !reached && items.length < list.length;
    return {
      items: items,
      sum: cum,
      coverage: total ? cum / total : 0,
      reached: reached,
      capped: capped,
      need: need
    };
  }

  function renderConclusion() {
    var t = model.totals;
    var primaryDim = model.primaryDim;
    var dimLabel = GM.dimLabel(primaryDim);
    var cust = model.byDim[primaryDim];
    var custPos = cust.filter(function (p) { return p.delta > 0; }).sort(function (a, b) { return b.delta - a.delta; });
    var custNeg = cust.filter(function (p) { return p.delta < 0; }).sort(function (a, b) { return a.delta - b.delta; });
    var posTotal = sumBy(custPos, function (p) { return p.delta; });
    var negTotal = sumBy(custNeg, function (p) { return p.delta; });

    function orderInfo(p) {
      var orders = GM.ordersFor(model, primaryDim, p.key);
      var same = orders.filter(function (o) { return p.delta > 0 ? o.delta > 0 : o.delta < 0; });
      same.sort(function (a, b) { return p.delta > 0 ? b.delta - a.delta : a.delta - b.delta; });
      var total = sumBy(same, function (o) { return o.delta; });
      var pick = paretoTake(same, total, PARETO.orders);
      return {
        orders: pick.items, count: same.length, total: total,
        need: pick.need, coverage: pick.coverage, capped: pick.capped
      };
    }

    var posPick = paretoTake(custPos, posTotal, PARETO.customers);
    var negPick = paretoTake(custNeg, negTotal, PARETO.customers);
    var posTop = posPick.items;
    var negTop = negPick.items;
    var posShown = posPick.sum;
    var negShown = negPick.sum;
    var topPos = custPos[0] || { key: '—', delta: 0 };
    var topNeg = custNeg[0] || { key: '—', delta: 0 };

    function ledger(list, total, shown, positive, pick) {
      var html = '';
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        var oi = orderInfo(p);
        var chips = '';
        for (var j = 0; j < oi.orders.length; j++) {
          var o = oi.orders[j];
          chips += '<span class="order-chip">' + orderKeyHTML(o.key) + ' <b class="' + cls(o.delta) + '">' +
            spp(o.delta) + '</b></span>';
        }
        if (!chips) chips = '<span class="order-chip">—</span>';
        var share = total ? Math.abs(p.delta) / Math.abs(total) : 0;
        var meta;
        if (!oi.count) {
          meta = '无同向订单，' + dimLabel + '净额由反向订单抵消';
        } else if (oi.orders.length >= oi.count) {
          meta = (positive ? '拉高' : '拉低') + '订单 ' + oi.count + ' 张 · 全部列出（覆盖 100.00%）';
        } else {
          meta = (positive ? '拉高' : '拉低') + '订单 ' + oi.count + ' 张 · 列出 ' +
            oi.orders.length + ' 张（覆盖 ' + pct(oi.coverage) + '）· ' +
            (oi.capped ? '80% 需 ' + oi.need + ' 张，按 ' + PARETO.orders + ' 张上限截断' : '达到 80% 停止');
        }
        html += '<div class="ledger-item">' +
          '<div class="ledger-line"><span class="ledger-name">' + esc(p.key) + '</span>' +
          '<b class="' + cls(p.delta) + '">' + spp(p.delta) + '</b>' +
          '<span class="ledger-share">占' + (positive ? '正向' : '负向') + ' ' + pct(share) + '</span></div>' +
          '<div class="ledger-orders">' + chips + '</div>' +
          '<div class="ledger-meta">' + meta + '</div>' +
          '</div>';
      }
      var cov = total ? shown / total : 0;
      var foot = '前 ' + list.length + ' 大' + dimLabel + '合计 ' + spp(shown) +
        ' · 覆盖' + (positive ? '正向' : '负向') + ' ' + pct(cov);
      if (pick.capped) foot += '（未达 80%，按前 ' + PARETO.customers + ' 大截断）';
      return '<div class="ledger-col ' + (positive ? 'pos' : 'neg') + '">' +
        '<div class="ledger-head"><span>' + (positive ? '拉高毛利率' : '拉低毛利率') + '</span>' +
        '<b class="' + cls(total) + '">' + spp(total) + '</b></div>' +
        html + '<div class="ledger-foot">' + foot + '</div></div>';
    }

    var move = Math.abs(t.dGM) < 0.00005
      ? '基本持平'
      : (t.dGM > 0 ? '上升 ' : '下降 ') + pp(Math.abs(t.dGM));
    $('#conclusion-title').innerHTML = '本期毛利率<b class="' + cls(t.dGM) + '">' + move +
      '</b>：' + esc(topPos.key) + ' ' + spp(topPos.delta) + ' 拉高最多，' +
      esc(topNeg.key) + ' ' + spp(topNeg.delta) + ' 拉低最多。';
    $('#conclusion-lead').innerHTML = '正向 ' + posTop.length + ' 个' + dimLabel + '覆盖 ' +
      pct(posTotal ? posShown / posTotal : 0) + '，负向 ' + negTop.length + ' 个覆盖 ' +
      pct(negTotal ? negShown / negTotal : 0) + '。' +
      dimLabel + '累计到 80% 或前 ' + PARETO.customers + ' 大即停；订单累计到 80% 或前 ' +
      PARETO.orders + ' 张即停。';
    $('#conclusion-grid').innerHTML =
      ledger(posTop, posTotal, posShown, true, posPick) +
      ledger(negTop, negTotal, negShown, false, negPick);
    $('#conclusion-boundary').innerHTML =
      '订单条数按“累计 80% 或前 ' + PARETO.orders + ' 张”截断；括号内为已列订单覆盖的拉力比例。' +
      '点' + dimLabel + '可看全部订单；' + dimLabel + '净额会被反向订单抵消，订单小计不一定等于' + dimLabel + '净额。';
  }


  function supportDims() {
    return (model.entityDims || []).filter(function (d) {
      return d.key === 'customer' || d.key === 'product';
    });
  }

  function supportOrderDetailHTML(parent, dim, period) {
    var isBase = period === 'base';
    var label = isBase ? Y0 : Y1;
    var orders = GM.ordersFor(model, dim, parent.key).filter(function (o) {
      var s = isBase ? o.s0 : o.s1;
      var k = isBase ? o.k0 : o.k1;
      return Math.abs(s) > 1e-9 || Math.abs(k) > 1e-9;
    });
    orders.sort(function (a, b) {
      var av = isBase ? a.s0 : a.s1;
      var bv = isBase ? b.s0 : b.s1;
      return bv - av;
    });
    var sumS = 0, sumK = 0, sumP = 0;
    var rows = '';
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      var s = isBase ? o.s0 : o.s1;
      var k = isBase ? o.k0 : o.k1;
      var gm = isBase ? o.gm0 : o.gm1;
      var w = isBase ? o.w0 : o.w1;
      var pull = isBase ? o.pull0 : o.pull1;
      sumS += s; sumK += k; sumP += pull;
      rows += '<tr>' +
        '<td><b>' + orderKeyHTML(o.key) + '</b></td>' +
        '<td>' + orderTag(o.status) + '</td>' +
        '<td class="r">' + (Math.abs(s) < 1e-9 ? '—' : fmtWan(s)) + '</td>' +
        '<td class="r">' + (Math.abs(k) < 1e-9 ? '—' : fmtWan(k)) + '</td>' +
        '<td class="r">' + (gm == null ? '—' : pct(gm)) + '</td>' +
        '<td class="r">' + pct(w) + '</td>' +
        '<td class="r"><b class="' + cls(pull) + '">' + spp(pull) + '</b></td>' +
        '</tr>';
    }
    if (!rows) rows = '<tr><td colspan="7" class="empty">该期间没有订单。</td></tr>';
    return '<div class="inline-detail-head"><div>' +
      '<div class="detail-kicker">订单级明细 · ' + label + ' · ' + GM.dimLabel(dim) + '</div>' +
      '<div class="detail-title">' + esc(parent.key) + ' · ' + orders.length + ' 张订单</div>' +
      '<div class="detail-sub">' + label + '销售收入 ' + fmtWan(sumS) + ' 万元 · 销售成本 ' +
      fmtWan(sumK) + ' 万元 · 拉力 ' + spp(sumP) + '</div></div>' +
      '<button class="icon-btn" data-close-support-detail aria-label="关闭">×</button></div>' +
      '<div class="detail-summary">共 ' + orders.length + ' 张 · 销售收入 ' + fmtWan(sumS) +
      ' 万元 · 销售成本 ' + fmtWan(sumK) + ' 万元 · 拉力合计 ' + spp(sumP) + '</div>' +
      '<div class="order-table-scroll"><table class="data-table order-table support-order-table">' +
      '<colgroup><col style="width:18%"><col style="width:9%"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:14%"></colgroup>' +
      '<thead><tr><th>订单号</th><th>类型</th><th class="r">销售收入</th><th class="r">销售成本</th>' +
      '<th class="r">毛利率</th><th class="r">销售占比</th><th class="r">拉力</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
      '<div class="mini-note detail-note">金额单位：万元；销售占比 = 订单收入 ÷ 当期总收入；按所选期间销售收入排序。</div>';
  }


  function closeSupportDetail() {
    var rows = document.querySelectorAll('#support-groups .detail-row');
    for (var i = 0; i < rows.length; i++) rows[i].parentNode.removeChild(rows[i]);
    var open = document.querySelectorAll('#support-groups tr[data-support-key].open');
    for (var j = 0; j < open.length; j++) {
      open[j].classList.remove('open');
      open[j].setAttribute('aria-expanded', 'false');
    }
    state.supportOpenKey = null;
  }

  function openSupportDetail(tr, parent) {
    var key = parent.key;
    var wasOpen = state.supportOpenKey === key;
    closeSupportDetail();
    if (wasOpen) return;
    state.supportOpenKey = key;
    tr.classList.add('open');
    tr.setAttribute('aria-expanded', 'true');
    var detail = document.createElement('tr');
    detail.className = 'detail-row';
    var td = document.createElement('td');
    td.colSpan = 6;
    td.innerHTML = '<div class="inline-detail">' +
      supportOrderDetailHTML(parent, state.supportDim, state.supportPeriod) + '</div>';
    detail.appendChild(td);
    tr.parentNode.insertBefore(detail, tr.nextSibling);
    requestAnimationFrame(function () {
      detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  function foldSupportList(list, isBase) {
    if (!state.supportFold) return { list: list, folded: 0 };
    var big = [], small = [];
    for (var i = 0; i < list.length; i++) {
      var pull = isBase ? list[i].pull0 : list[i].pull1;
      if (Math.abs(pull) < SUPPORT_FOLD) small.push(list[i]);
      else big.push(list[i]);
    }
    if (small.length < 2) return { list: list, folded: 0 };
    var agg = {
      key: '其余 ' + small.length + ' 个小值', folded: true, foldedCount: small.length,
      status: '', s0: 0, k0: 0, q0: 0, s1: 0, k1: 0, q1: 0,
      pull0: 0, pull1: 0, w0: 0, w1: 0
    };
    for (var j = 0; j < small.length; j++) {
      var x = small[j];
      agg.s0 += x.s0; agg.k0 += x.k0; agg.q0 += x.q0;
      agg.s1 += x.s1; agg.k1 += x.k1; agg.q1 += x.q1;
      agg.pull0 += x.pull0; agg.pull1 += x.pull1;
      agg.w0 += x.w0; agg.w1 += x.w1;
    }
    agg.gm0 = agg.s0 > 1e-9 ? 1 - agg.k0 / agg.s0 : null;
    agg.gm1 = agg.s1 > 1e-9 ? 1 - agg.k1 / agg.s1 : null;
    big.push(agg);
    return { list: big, folded: small.length };
  }

  function supportRow(p, dim, period) {
    var isBase = period === 'base';
    var s = isBase ? p.s0 : p.s1;
    var k = isBase ? p.k0 : p.k1;
    var gm = isBase ? p.gm0 : p.gm1;
    var w = isBase ? p.w0 : p.w1;
    var pull = isBase ? p.pull0 : p.pull1;
    var isOpen = state.supportOpenKey === p.key;
    var folded = !!p.folded;
    var name = folded ? esc(p.key) : esc(p.key) + statusBadge(p.status);
    var extra = folded
      ? '<span class="fold-tag">小值合计</span>'
      : '<span class="row-link">' + (isOpen ? '收起' : '查看') + '</span>';
    return '<tr' + (folded ? ' class="is-folded"' : ' data-support-key="' + esc(p.key) + '" tabindex="0" class="' + (isOpen ? 'open' : '') + '" aria-expanded="' + isOpen + '"') + '>' +
      '<td class="name"><div class="name"><span class="txt" title="' + esc(p.key) + '">' + name +
      '</span>' + extra + '</div></td>' +
      '<td class="r">' + (Math.abs(s) < 1e-9 ? '—' : fmtWan(s)) + '</td>' +
      '<td class="r">' + (Math.abs(k) < 1e-9 ? '—' : fmtWan(k)) + '</td>' +
      '<td class="r">' + (gm == null ? '—' : pct(gm)) + '</td>' +
      '<td class="r">' + pct(w) + '</td>' +
      '<td class="r"><b class="' + cls(pull) + '">' + spp(pull) + '</b></td>' +
      '</tr>' +
      (!folded && isOpen ? '<tr class="detail-row"><td colspan="6"><div class="inline-detail">' +
        supportOrderDetailHTML(p, dim, period) + '</div></td></tr>' : '');
  }

  function supportGroupHTML(kind, list, total, dim, period, sourceCount, folded) {
    if (!list.length) return '';
    var isPos = kind === 'pos';
    var open = state.supportGroups[kind].open;
    var title = isPos ? '正向拉力' : '负向拉力';
    var sub = isPos ? '撑在上面' : '拖在下面';
    var rows = '';
    for (var i = 0; i < list.length; i++) rows += supportRow(list[i], dim, period);
    return '<div class="group ' + kind + (open ? ' open' : '') + '">' +
      '<div class="group-head" data-support-group="' + kind + '" role="button" tabindex="0" aria-expanded="' + open + '">' +
      '<div class="group-left"><span class="group-title">' + title + '</span><span class="group-sub">' +
      (period === 'base' ? Y0 : Y1) + ' · ' + sub + ' · 按拉力' + (isPos ? '从大到小' : '从小到大') +
      ' · 共 ' + sourceCount + ' 个' + (folded ? '（小值折叠 ' + folded + ' 个）' : '') + '</span></div>' +
      '<div class="group-right"><span class="group-total ' + cls(total) + '">合计 ' + spp(total) +
      '</span><span class="chevron">' + (open ? '收起 ⌃' : '展开 ⌄') + '</span></div></div>' +
      '<div class="group-body"' + (open ? '' : ' hidden') + '><div class="group-scroll' +
      (list.length > 20 ? ' is-scroll' : '') + '">' +
      '<table class="data-table loc-table support-table">' +
      '<colgroup><col style="width:26%"><col style="width:16%"><col style="width:16%"><col style="width:14%"><col style="width:14%"><col style="width:14%"></colgroup>' +
      '<thead><tr><th>对象</th><th class="r">销售收入</th><th class="r">销售成本</th>' +
      '<th class="r">毛利率</th><th class="r">销售占比</th><th class="r">拉力</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div></div>';
  }

  function renderSupport() {
    var dims = supportDims();
    if (!dims.length) {
      $('#support-section').hidden = true;
      return;
    }
    $('#support-section').hidden = false;
    var hasDim = dims.some(function (d) { return d.key === state.supportDim; });
    if (!hasDim) state.supportDim = dims[0].key;
    var dim = state.supportDim;
    var isBase = state.supportPeriod === 'base';
    var list = (model.byDim[dim] || []).filter(function (p) {
      var s = isBase ? p.s0 : p.s1;
      var k = isBase ? p.k0 : p.k1;
      // Revenue can be zero while cost is not (returns / accruals); such an
      // object still has a real pull and must stay in the composition total.
      return Math.abs(s) > 1e-9 || Math.abs(k) > 1e-9;
    });
    var pos = list.filter(function (p) { return (isBase ? p.pull0 : p.pull1) > 0; })
      .sort(function (a, b) { return (isBase ? b.pull0 - a.pull0 : b.pull1 - a.pull1); });
    var neg = list.filter(function (p) { return (isBase ? p.pull0 : p.pull1) <= 0; })
      .sort(function (a, b) { return (isBase ? a.pull0 - b.pull0 : a.pull1 - b.pull1); });
    var posTotal = sumBy(pos, function (p) { return isBase ? p.pull0 : p.pull1; });
    var negTotal = sumBy(neg, function (p) { return isBase ? p.pull0 : p.pull1; });
    var net = posTotal + negTotal;
    var periodLabel = isBase ? Y0 : Y1;
    var posView = foldSupportList(pos, isBase);
    var negView = foldSupportList(neg, isBase);

    $('#support-dim-tabs').innerHTML = dimensionTabsHTML(dims, dim, 'support-dim');
    Array.prototype.forEach.call(document.querySelectorAll('#support-period button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-support-period') === state.supportPeriod);
    });

    if (isBase) {
      $('#support-equation').innerHTML = '上期毛利率 <b>' + pct(model.totals.R0) +
        '</b> · 上期拉力合计 <b class="' + cls(net) + '">' + spp(net) + '</b>（基期）';
    } else {
      var eqSign = net >= 0 ? ' + ' : ' − ';
      $('#support-equation').innerHTML = '本期毛利率 <b>' + pct(model.totals.R1) +
        '</b> = 上期 <b>' + pct(model.totals.R0) + '</b>' + eqSign + '本期拉力合计 <b class="' +
        cls(net) + '">' + pp(Math.abs(net)) + '</b>';
    }

    $('#support-summary').innerHTML =
      '<div class="sum-item"><div class="sum-k">正向拉力</div><div class="sum-v ' + cls(posTotal) + '">' +
      spp(posTotal) + '</div><div class="sum-m">' + pos.length + ' 个</div></div>' +
      '<div class="sum-item"><div class="sum-k">负向拉力</div><div class="sum-v ' + cls(negTotal) + '">' +
      spp(negTotal) + '</div><div class="sum-m">' + neg.length + ' 个</div></div>' +
      '<div class="sum-item"><div class="sum-k">拉力合计</div><div class="sum-v ' + cls(net) + '">' +
      spp(net) + '</div><div class="sum-m">' + (isBase ? '基期为 0' : '= 毛利率变化') + '</div></div>';

    $('#support-groups').innerHTML = supportGroupHTML('pos', posView.list, posTotal, dim, state.supportPeriod, pos.length, posView.folded) +
      supportGroupHTML('neg', negView.list, negTotal, dim, state.supportPeriod, neg.length, negView.folded) ||
      '<div class="empty">当前维度没有可列示的拉力。</div>';

    $('#support-fold').classList.toggle('active', state.supportFold);
    $('#support-fold').setAttribute('aria-pressed', String(state.supportFold));
    $('#support-fold').textContent = state.supportFold ? '显示全部' : '折叠 <0.01pp';

    var note = '按' + periodLabel + '拉力排序；所选期间有收入或成本的全部 ' + list.length + ' 个对象已列示，未按帕累托截断。' +
      '拉力是水平值，不是差值：正数表示把' + periodLabel + '毛利率撑在基准之上，负数表示拖在基准之下。';
    if (state.supportFold) {
      note += ' 已把 |拉力| < 0.01pp 的对象折叠为“其余小值”，合计不变；点“显示全部”可恢复。';
    }
    if (state.supportPeriod === 'base') note += ' 基期逐行拉力合计为 0。';
    $('#support-note').textContent = note;
  }

  function renderOverview() {
    var t = model.totals;
    var costRate0 = t.K0 / t.S0;
    var costRate1 = t.K1 / t.S1;
    var kpis = [
      {
        label: '销售收入', value: fmtWan(t.S1), unit: '万元',
        delta: t.S1 / t.S0 - 1, foot: '上期 ' + fmtWan(t.S0) + ' 万元', tone: 'rev'
      },
      {
        label: '毛利', value: fmtWan(t.gross1), unit: '万元',
        delta: t.gross1 / t.gross0 - 1, foot: '上期 ' + fmtWan(t.gross0) + ' 万元', tone: 'gross'
      },
      {
        label: '毛利率', value: pct(t.R1), unit: '',
        delta: t.dGM, foot: '上期 ' + pct(t.R0), tone: 'margin'
      },
      {
        label: '成本率', value: pct(costRate1), unit: '',
        delta: costRate1 - costRate0, foot: '上期 ' + pct(costRate0), tone: 'cost'
      }
    ];
    var kpiHtml = '';
    for (var k = 0; k < kpis.length; k++) {
      var x = kpis[k];
      kpiHtml += '<div class="kpi kpi-' + x.tone + '">' +
        '<div class="kpi-head"><span class="kpi-label">' + x.label + '</span>' +
        '<span class="kpi-chip ' + trendCls(x.delta) + '">较' + Y0 + ' ' + spp(x.delta) + '</span></div>' +
        '<div class="kpi-value">' + x.value + (x.unit ? '<span class="kpi-unit">' + x.unit + '</span>' : '') + '</div>' +
        '<div class="kpi-foot">' + x.foot + '</div>' +
        '</div>';
    }
    $('#overview-kpis').innerHTML = kpiHtml;

    function boardRow(label, a, b, change, clsName) {
      return '<tr>' +
        '<td class="metric"><span class="metric-dot ' + (clsName || '') + '"></span>' + label + '</td>' +
        '<td class="r">' + a + '</td>' +
        '<td class="r strong">' + b + '</td>' +
        '<td class="r">' + chgChip(change) + '</td>' +
        '</tr>';
    }

    var rows = '';
    rows += '<tr class="board-group"><td colspan="4">金额 · 万元</td></tr>';
    rows += boardRow('销售收入', fmtWan(t.S0), fmtWan(t.S1), t.S1 / t.S0 - 1, 'rev');
    rows += boardRow('销售成本', fmtWan(t.K0), fmtWan(t.K1), t.K1 / t.K0 - 1, 'cost');
    rows += boardRow('毛利', fmtWan(t.gross0), fmtWan(t.gross1), t.gross1 / t.gross0 - 1, 'gross');
    rows += '<tr class="board-group"><td colspan="4">效率 · 比率 / 单价 / 数量</td></tr>';
    rows += boardRow('毛利率', pct(t.R0), pct(t.R1), t.dGM, 'margin');
    rows += boardRow('成本率', pct(costRate0), pct(costRate1), costRate1 - costRate0, 'cost');
    rows += boardRow('销量（万）', fmtWan(t.Q0, 2), fmtWan(t.Q1, 2), t.Q1 / t.Q0 - 1, 'qty');
    rows += boardRow('均价（元）', fmtNum(t.P0), fmtNum(t.P1), t.P1 / t.P0 - 1, 'price');
    rows += boardRow('单位成本（元）', fmtNum(t.C0), fmtNum(t.C1), t.C1 / t.C0 - 1, 'cost');

    var board = '<div class="mini-card board-card">' +
      '<div class="mini-head">' +
      '<div><div class="mini-title">经营大盘</div><div class="mini-sub">总额统一为万元，单价与单位成本保留元</div></div>' +
      '<span class="mini-badge">' + PERIOD0 + ' → ' + PERIOD1 + '</span>' +
      '</div>' +
      '<table class="data-table board-table">' +
      '<thead><tr><th>指标</th><th class="r">' + Y0 + '</th><th class="r">' + Y1 + '</th><th class="r">变化</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table>' +
      '<div class="board-note">毛利率变化 ' + spp(t.dGM) + '，收入增长 ' + spct(t.S1 / t.S0 - 1) +
      '；成本率变化 ' + spp(costRate1 - costRate0) + '。</div>' +
      '</div>';

    var stack = '<div class="stack-block">' +
      '<div class="mini-title-row"><div class="mini-title">本期毛利结构</div>' +
      '<span class="mini-tag">收入 ' + fmtWan(t.S1) + ' 万元</span></div>' +
      '<div class="stack-bar" aria-label="本期收入中成本与毛利的占比">' +
      '<i class="stack-cost" style="width:' + (costRate1 * 100).toFixed(2) + '%"></i>' +
      '<i class="stack-gross" style="width:' + (t.R1 * 100).toFixed(2) + '%"></i>' +
      '<b class="stack-prior" style="left:' + (costRate0 * 100).toFixed(2) + '%" title="上期成本率 ' + pct(costRate0) + '"></b>' +
      '</div>' +
      '<div class="stack-legend">' +
      '<span><i class="sw cost"></i>成本 ' + pct(costRate1) + '</span>' +
      '<span><i class="sw gross"></i>毛利 ' + pct(t.R1) + '</span>' +
      '<span class="prior-mark"><i></i>上期成本率 ' + pct(costRate0) + '</span>' +
      '</div></div>';

    var maxNeg = Math.max(Math.abs(Math.min(t.price1, 0)), Math.abs(Math.min(t.cost1, 0)), 0.01);
    var maxPos = Math.max(Math.max(t.price1, 0), Math.max(t.cost1, 0), 0.01);
    var range = maxNeg + maxPos;
    var zeroPct = range > 0 ? maxNeg / range * 100 : 50;
    function pullRow(label, v) {
      var w = Math.abs(v) / range * 100;
      var side = v < 0 ? 'left:0;' : 'left:' + zeroPct.toFixed(2) + '%;';
      return '<div class="pull-row">' +
        '<div class="pull-row-head"><span>' + label + '</span>' +
        '<b class="' + cls(v) + '">' + spp(v) + '</b></div>' +
        '<div class="pull-track"><i class="' + cls(v) + '" style="' + side + 'width:' + w.toFixed(2) + '%"></i>' +
        '<span class="pull-zero" style="left:' + zeroPct.toFixed(2) + '%"></span></div>' +
        '</div>';
    }
    var pull = '<div class="pull-block">' +
      '<div class="mini-title-row"><div class="mini-title">本期拉力构成</div>' +
      '<span class="mini-tag">合计 <b class="' + cls(t.dGM) + '">' + spp(t.dGM) + '</b></span></div>' +
      '<div class="pull-scale"><span>' + spp(-maxNeg) + '</span><span class="zero" style="left:' +
      zeroPct.toFixed(2) + '%">0</span><span>' + spp(maxPos) + '</span></div>' +
      pullRow('价格拉力', t.price1) +
      pullRow('成本拉力', t.cost1) +
      '<div class="pull-net"><span>净拉力</span><b class="' + cls(t.dGM) + '">' + spp(t.dGM) + '</b>' +
      '<em>= 毛利率变化</em></div>' +
      '<div class="mini-note">以' + Y0 + '公司均价 ' + fmtNum(t.P0) + ' 元、平均单位成本 ' +
      fmtNum(t.C0) + ' 元为基准。两项是相对基准的拉力，不是价格 / 成本涨跌幅；结构变化会同时进入两项，常大幅对冲。</div>' +
      '</div>';

    var audit = '<div class="audit-line"><span class="audit-dot"></span>' +
      '逐行恒等 · ' + model.checks.rowCount.toLocaleString('zh-CN') + ' 行 · ' +
      (model.checks.maxRowCheck < 1e-12 ? '误差 &lt; 1e-12' : '误差 ' + model.checks.maxRowCheck.toExponential(1)) +
      ' · ' + Y0 + '合计 0.00%</div>';

    var right = '<div class="mini-card pull-card">' + stack +
      '<div class="panel-divider"></div>' + pull + audit + '</div>';

    $('#overview-grid').innerHTML = board + right;
  }

  function filteredParents() {
    var all = model.byDim[state.dim];
    var q = state.search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(function (p) { return String(p.key).toLowerCase().indexOf(q) >= 0; });
  }

  function renderLocate() {
    currentOrderData = null;
    var label = GM.dimLabel(state.dim);
    var list = filteredParents();
    var pos = list.filter(function (p) { return p.delta > 0; }).sort(function (a, b) { return b.delta - a.delta; });
    var neg = list.filter(function (p) { return p.delta <= 0; }).sort(function (a, b) { return a.delta - b.delta; });
    var posSum = sumBy(pos, function (p) { return p.delta; });
    var negSum = sumBy(neg, function (p) { return p.delta; });
    var net = posSum + negSum;
    var isSearch = !!state.search;

    $('#loc-summary').innerHTML =
      '<div class="sum-item"><div class="sum-k">正向拉力（拉高）</div><div class="sum-v ' + cls(posSum) + '">' + spp(posSum) + '</div><div class="sum-m">' + pos.length + ' 个' + label + '</div></div>' +
      '<div class="sum-item"><div class="sum-k">负向拉力（拉低）</div><div class="sum-v ' + cls(negSum) + '">' + spp(negSum) + '</div><div class="sum-m">' + neg.length + ' 个' + label + '</div></div>' +
      '<div class="sum-item"><div class="sum-k">' + (isSearch ? '当前结果净拉力' : '净拉力') + '</div><div class="sum-v ' + cls(net) + '">' + spp(net) + '</div><div class="sum-m">' + (isSearch ? '筛选结果' : '= 毛利率变化') + '</div></div>';

    $('#loc-meta').textContent = (state.search ? '搜索到 ' : '共 ') + list.length + ' 个' + label +
      ' · 正向 ' + pos.length + ' / 负向 ' + neg.length;

    var html = '';
    if (pos.length) html += groupHTML('pos', '拉高毛利率', '按拉力差值从大到小', pos, posSum, label);
    if (neg.length) html += groupHTML('neg', '拉低毛利率', '按拉力差值从小到大', neg, negSum, label);
    if (!html) html = '<div class="empty">没有匹配的' + label + '。</div>';
    $('#loc-groups').innerHTML = html;

    if (state.openKey) {
      var detail = $('#loc-groups .detail-row');
      if (detail) {
        var row = detail.previousElementSibling;
        if (row) row.classList.add('open');
      }
    }
  }

  function groupHTML(kind, title, sub, list, total, label) {
    var g = state.groups[kind];
    var open = g.open;
    var all = g.all;
    var preview = all ? list : list.slice(0, 6);
    var more = list.length > 6;
    var scroll = all && list.length > 12;
    var rows = '';
    for (var i = 0; i < preview.length; i++) {
      var p = preview[i];
      var gm0 = p.gm0 == null ? '—' : pct(p.gm0);
      var gm1 = p.gm1 == null ? '—' : pct(p.gm1);
      var dgm = p.dgm == null ? '—' : spp(p.dgm);
      var isOpen = state.openKey === p.key;
      rows += '<tr data-key="' + esc(p.key) + '" tabindex="0" class="' + (isOpen ? 'open' : '') + '" aria-expanded="' + isOpen + '">' +
        '<td class="m-name" data-label="' + label + '"><div class="name"><span class="txt" title="' + esc(p.key) + '">' + esc(p.key) + '</span>' + statusBadge(p.status) + '</div></td>' +
        '<td class="r" data-label="' + Y0 + '毛利率">' + gm0 + '</td>' +
        '<td class="r" data-label="' + Y1 + '毛利率">' + gm1 + '</td>' +
        '<td class="r ' + cls(p.dgm) + '" data-label="毛利率变化">' + dgm + '</td>' +
        '<td class="r c-pull" data-label="拉力差值"><b class="' + cls(p.delta) + '">' + spp(p.delta) + '</b></td>' +
        '<td class="r muted" data-label="' + Y1 + '收入占比">' + pct(p.w1) + '</td>' +
        '<td class="r c-action"><span class="row-link">' + (isOpen ? '收起' : '查看') + '</span></td>' +
        '</tr>';
      if (isOpen) {
        rows += '<tr class="detail-row"><td colspan="7"><div class="inline-detail">' +
          orderDetailHTML(p, state.dim, { drawer: false }) + '</div></td></tr>';
      }
    }

    var foot = '';
    if (more) {
      foot = '<div class="group-foot"><button class="link" data-group-more="' + kind + '">' +
        (all ? '收起至前 6 个' : '展开全部 ' + list.length + ' 个') + '</button>' +
        '<span class="group-foot-note">' + (all ? '当前显示全部' : '当前显示前 6 个') + '</span></div>';
    }

    return '<div class="group ' + kind + '">' +
      '<div class="group-head" data-group="' + kind + '" role="button" tabindex="0" aria-expanded="' + open + '">' +
      '<div class="group-left"><span class="group-title">' + title + '</span><span class="group-sub">' + sub + ' · ' + list.length + ' 个</span></div>' +
      '<div class="group-right"><span class="group-total ' + cls(total) + '">合计 ' + spp(total) + '</span><span class="chevron">' + (open ? '收起 ⌃' : '展开 ⌄') + '</span></div>' +
      '</div>' +
      '<div class="group-body" data-group-body="' + kind + '"' + (open ? '' : ' hidden') + '>' +
      '<div class="group-scroll' + (scroll ? ' is-scroll' : '') + '" data-scroll="' + kind + '">' +
      '<table class="data-table loc-table">' +
      '<colgroup><col style="width:24%"><col style="width:11%"><col style="width:11%"><col style="width:12%"><col style="width:14%"><col style="width:11%"><col style="width:9%"></colgroup>' +
      '<thead><tr><th>' + label + '</th><th class="r">' + Y0 + '毛利率</th><th class="r">' + Y1 + '毛利率</th><th class="r">毛利率变化</th><th class="r">拉力差值</th><th class="r">' + Y1 + '收入占比</th><th class="r">明细</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' + foot + '</div></div>';
  }

  function orderTableHTML(orders) {
    var rows = '';
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      rows += '<tr>' +
        '<td><b>' + orderKeyHTML(o.key) + '</b></td>' +
        '<td>' + orderTag(o.status) + '</td>' +
        '<td class="r">' + (Math.abs(o.s0) < 1e-9 ? '—' : fmtWan(o.s0)) + '</td>' +
        '<td class="r">' + (Math.abs(o.s1) < 1e-9 ? '—' : fmtWan(o.s1)) + '</td>' +
        '<td class="r"><b class="' + cls(o.delta) + '">' + spp(o.delta) + '</b></td>' +
        '<td class="r ' + cls(o.dprice) + '">' + spp(o.dprice) + '</td>' +
        '<td class="r ' + cls(o.dcost) + '">' + spp(o.dcost) + '</td>' +
        '</tr>';
    }
    return '<div class="order-table-scroll"><table class="data-table order-table">' +
      '<colgroup><col style="width:18%"><col style="width:9%"><col style="width:12%"><col style="width:12%"><col style="width:13%"><col style="width:13%"><col style="width:13%"></colgroup>' +
      '<thead><tr><th>订单号</th><th>类型</th><th class="r">' + Y0 + '收入(万元)</th><th class="r">' + Y1 + '收入(万元)</th><th class="r">拉力差值</th><th class="r">价格拉力差值</th><th class="r">成本拉力差值</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>';
  }

  function orderDetailHTML(parent, dim, opts) {
    dim = dim || state.dim;
    var orders = GM.ordersFor(model, dim, parent.key);
    var label = GM.dimLabel(dim);
    var pos = orders.filter(function (o) { return o.delta > 0; });
    var neg = orders.filter(function (o) { return o.delta <= 0; });
    var posSum = sumBy(pos, function (o) { return o.delta; });
    var negSum = sumBy(neg, function (o) { return o.delta; });
    var drawer = !!(opts && opts.drawer);
    var sub = '拉力差值 ' + spp(parent.delta) + ' = 价格 ' + spp(parent.dprice) + ' + 成本 ' + spp(parent.dcost);
    var title = dim === 'order' ? '订单 ' + parent.key : parent.key;

    currentOrderData = { parent: parent, dim: dim, orders: orders };
    var actions = '<div class="detail-actions"><button class="btn btn-sm" data-export-orders>导出订单</button>' +
      (drawer ? '' : '<button class="icon-btn" data-close-detail aria-label="关闭">×</button>') + '</div>';

    var head = '';
    if (!drawer) {
      head = '<div class="inline-detail-head"><div>' +
        '<div class="detail-kicker">订单级明细 · ' + label + '</div>' +
        '<div class="detail-title">' + esc(title) + ' · ' + orders.length + ' 张订单</div>' +
        '<div class="detail-sub">' + sub + '</div></div>' + actions + '</div>';
    } else {
      head = '<div class="drawer-sub">' + sub + '</div>' + actions;
    }

    var summary = '<div class="detail-summary">共 ' + orders.length + ' 张 · 正向 ' + spp(posSum) +
      '（' + pos.length + ' 张） · 负向 ' + spp(negSum) + '（' + neg.length + ' 张） · 净 ' + spp(parent.delta) + '</div>';
    var note = '<div class="mini-note detail-note">缺失年份按 0 计；仅本期 / 仅上期的差值等于该订单单期拉力。按 |拉力差值| 排序。</div>';
    return head + summary + orderTableHTML(orders) + note;
  }

  function openInlineDetail(tr, parent) {
    closeDrawer();
    var existing = document.querySelectorAll('#loc-groups .detail-row');
    for (var i = 0; i < existing.length; i++) existing[i].parentNode.removeChild(existing[i]);
    var wasOpen = state.openKey === parent.key;
    var rows = document.querySelectorAll('#loc-groups tr[data-key]');
    for (var j = 0; j < rows.length; j++) rows[j].classList.remove('open');
    if (wasOpen) {
      state.openKey = null;
      currentOrderData = null;
      return;
    }
    state.openKey = parent.key;
    tr.classList.add('open');
    tr.setAttribute('aria-expanded', 'true');
    var detail = document.createElement('tr');
    detail.className = 'detail-row';
    var td = document.createElement('td');
    td.colSpan = 7;
    td.innerHTML = '<div class="inline-detail">' + orderDetailHTML(parent, state.dim, { drawer: false }) + '</div>';
    detail.appendChild(td);
    tr.parentNode.insertBefore(detail, tr.nextSibling);
    requestAnimationFrame(function () {
      detail.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  }

  function closeInlineDetail() {
    var existing = document.querySelectorAll('#loc-groups .detail-row');
    for (var i = 0; i < existing.length; i++) existing[i].parentNode.removeChild(existing[i]);
    var rows = document.querySelectorAll('#loc-groups tr[data-key]');
    for (var j = 0; j < rows.length; j++) {
      rows[j].classList.remove('open');
      rows[j].setAttribute('aria-expanded', 'false');
    }
    state.openKey = null;
    currentOrderData = null;
  }

  function pointMetric(label, value, tone) {
    return '<div class="point-metric"><span>' + label + '</span>' +
      '<b class="' + (tone || '') + '">' + value + '</b></div>';
  }

  function pointDetailHTML(parent, dim, period) {
    var isBase = period === 'base';
    var s = isBase ? parent.s0 : parent.s1;
    var k = isBase ? parent.k0 : parent.k1;
    var p = isBase ? parent.p0 : parent.p1;
    var c = isBase ? parent.c0 : parent.c1;
    var w = isBase ? parent.w0 : parent.w1;
    var perLabel = isBase ? Y0 : Y1;
    return '<div class="point-snapshot">' +
      '<div class="detail-kicker">单点详情 · ' + perLabel + ' · ' + GM.dimLabel(dim) + '</div>' +
      '<div class="point-title">' + esc(parent.key) + '</div>' +
      '<div class="point-sub">' + perLabel + '单价 ' + fmtNum(p) + ' 元 · 单位成本 ' + fmtNum(c) +
      ' 元 · 收入占比 ' + pct(w) + '</div>' +
      '<div class="point-metrics">' +
      pointMetric('收入', fmtMoney(s), '') +
      pointMetric('成本', fmtMoney(k), '') +
      pointMetric('拉力差值', spp(parent.delta), cls(parent.delta)) +
      pointMetric('价格拉力', spp(parent.dprice), cls(parent.dprice)) +
      pointMetric('成本拉力', spp(parent.dcost), cls(parent.dcost)) +
      '</div>' +
      '<div class="point-note">拉力差值为两期对比（' + Y1 + ' − ' + Y0 + '），不随上方“' +
      Y0 + ' / ' + Y1 + '”切换改变；价格拉力 + 成本拉力 = 拉力差值。</div>' +
      '</div>';
  }

  function openPointDrawer(parent, dim, period) {
    closeInlineDetail();
    var perLabel = period === 'base' ? Y0 : Y1;
    $('#drawer-title').textContent = parent.key + ' · ' + perLabel;
    $('#drawer-body').innerHTML = pointDetailHTML(parent, dim, period) +
      '<div class="drawer-divider"></div>' +
      '<div class="drawer-detail-head">订单级明细</div>' +
      orderDetailHTML(parent, dim, { drawer: true });
    $('#drawer-mask').classList.add('show');
    $('#order-drawer').classList.add('show');
    $('#order-drawer').setAttribute('aria-hidden', 'false');
    document.body.classList.add('drawer-open');
    $('#drawer-body').scrollTop = 0;
  }

  function closeDrawer() {
    $('#drawer-mask').classList.remove('show');
    $('#order-drawer').classList.remove('show');
    $('#order-drawer').setAttribute('aria-hidden', 'true');
    document.body.classList.remove('drawer-open');
  }

  function buildQuadItems(parents, t) {
    var P0 = t.P0, C0 = t.C0;
    var out = [];
    for (var i = 0; i < parents.length; i++) {
      var p = parents[i];
      var has0 = p.status !== 'new' && p.p0 != null && p.c0 != null && p.p0 >= 0 && p.c0 >= 0;
      var has1 = p.status !== 'lost' && p.p1 != null && p.c1 != null && p.p1 >= 0 && p.c1 >= 0;
      var q0 = has0 ? GM.quadOf(p.p0, p.c0, P0, C0) : null;
      var q1 = has1 ? GM.quadOf(p.p1, p.c1, P0, C0) : null;
      out.push({
        p: p, has0: has0, has1: has1, q0: q0, q1: q1,
        x0: has0 ? Math.max(p.p0, 0.05) : null, y0: has0 ? Math.max(p.c0, 0.05) : null,
        x1: has1 ? Math.max(p.p1, 0.05) : null, y1: has1 ? Math.max(p.c1, 0.05) : null,
        zeroC0: has0 && p.c0 === 0, zeroP0: has0 && p.p0 === 0,
        zeroC1: has1 && p.c1 === 0, zeroP1: has1 && p.p1 === 0,
        rev0: p.s0, rev1: p.s1
      });
    }
    return out;
  }

  function migrationCallout(cc, flows, level) {
    var q4 = cc.filter(function (q) { return !!Q_META[q.key]; });
    var up = null, down = null;
    for (var i = 0; i < q4.length; i++) {
      if (!up || q4[i].dw > up.dw) up = q4[i];
      if (!down || q4[i].dw < down.dw) down = q4[i];
    }
    var parts = [];
    if (up && up.dw > 1e-6) {
      parts.push('<span class="mig-callout-item"><b>升幅最大</b> ' +
        qName(up.key) + ' ' + pct(up.w0) + ' → ' + pct(up.w1) +
        ' <em class="mig-callout-delta">' + spp(up.dw) + '</em></span>');
    }
    if (down && down.dw < -1e-6) {
      parts.push('<span class="mig-callout-item"><b>降幅最大</b> ' +
        qName(down.key) + ' ' + pct(down.w0) + ' → ' + pct(down.w1) +
        ' <em class="mig-callout-delta">' + spp(down.dw) + '</em></span>');
    }
    var text = parts.length
      ? parts.join('<span class="mig-callout-sep">；</span>')
      : '四个象限收入占比与' + Y0 + '持平。';

    var driver = '';
    if (level !== 'order' && parts.length) {
      var q = Math.abs(down.dw) >= Math.abs(up.dw) ? down : up;
      var out = null, inflow = null, stay = null;
      for (var k = 0; k < flows.paths.length; k++) {
        var f = flows.paths[k];
        if (f.from === q.key && f.to === q.key) stay = f;
        if (f.from === q.key && f.to !== q.key && (!out || f.w0 > out.w0)) out = f;
        if (f.to === q.key && f.from !== q.key && (!inflow || f.w1 > inflow.w1)) inflow = f;
      }
      var dim = GM.dimLabel(level);
      if (q.dw < -1e-6 && out) {
        driver = '降幅最大的是' + qName(q.key) + '：主要被「' + qName(out.from) + '→' +
          qName(out.to) + '」拖低，' + out.n + ' 个' + dim + '，' +
          pct(out.w0) + ' → ' + pct(out.w1) + '；';
        if (stay) {
          driver += '留在本象限 ' + stay.n + ' 个，' + pct(stay.w0) + ' → ' +
            pct(stay.w1) + '，' + (stay.dw > 0 ? '部分抵消' : '继续拖低') + '。';
        }
      } else if (q.dw > 1e-6 && inflow) {
        driver = '升幅最大的是' + qName(q.key) + '：主要来自「' + qName(inflow.from) + '→' +
          qName(inflow.to) + '」，' + inflow.n + ' 个' + dim + '，' +
          pct(inflow.w0) + ' → ' + pct(inflow.w1) + '；';
        if (stay) {
          driver += '留在本象限 ' + stay.n + ' 个，' + pct(stay.w0) + ' → ' +
            pct(stay.w1) + '，' + (stay.dw > 0 ? '继续推高' : '部分抵消') + '。';
        }
      }
    }
    return '<div class="mig-callout"><span class="mig-callout-k">收入浓度变化</span><div>' +
      '<p>' + text + '。</p>' +
      (driver ? '<p class="mig-callout-driver">' + driver + '</p>' : '') +
      '</div></div>';
  }

  function migrationSvg(cc) {
    var rows = cc.filter(function (q) { return !!Q_META[q.key]; })
      .sort(function (a, b) { return b.w1 - a.w1; });
    if (!rows.length) return '<div class="empty">没有可展示的象限数据。</div>';

    var W = 1200, x0 = 300, x1 = 850, plotW = x1 - x0;
    var rowStart = 104, rowH = 66;
    var H = rowStart + (rows.length - 1) * rowH + 52;
    var ticks = [0, 25, 50, 75, 100];

    function xOf(v) { return x0 + Math.max(0, Math.min(1, v)) * plotW; }
    function deltaText(v) { return fmtPpDelta(v); }

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="mig-svg" role="img" ' +
      'aria-label="四象限收入占比两期变化">';
    svg += '<title>四象限收入占比：' + Y0 + ' 与 ' + Y1 + '</title>';
    svg += '<text x="' + x0 + '" y="34" class="mig-head">收入占比</text>';
    svg += '<text x="1000" y="34" class="mig-head">占比变化</text>';

    for (var ti = 0; ti < ticks.length; ti++) {
      var tx = xOf(ticks[ti] / 100);
      svg += '<line x1="' + tx.toFixed(1) + '" y1="58" x2="' + tx.toFixed(1) + '" y2="' + (H - 26) +
        '" stroke="#f1ece2" stroke-width="1"/>';
      svg += '<text x="' + tx.toFixed(1) + '" y="50" text-anchor="middle" class="mig-tick">' +
        ticks[ti] + '%</text>';
    }

    for (var i = 0; i < rows.length; i++) {
      var q = rows[i];
      var y = rowStart + i * rowH;
      var meta = Q_META[q.key] || { color: '#667085' };
      var xp = xOf(q.w0), xc = xOf(q.w1);
      var sep = Math.abs(xc - xp) < 14;
      var yp = y - (sep ? 4 : 0), yc = y + (sep ? 4 : 0);

      svg += '<line x1="' + x0 + '" y1="' + y + '" x2="' + x1 + '" y2="' + y +
        '" stroke="#eee7da" stroke-width="2"/>';
      svg += '<line x1="' + xp.toFixed(1) + '" y1="' + yp + '" x2="' + xc.toFixed(1) + '" y2="' + yc +
        '" stroke="' + meta.color + '" stroke-width="5" stroke-linecap="round" opacity=".55"/>';
      if (Math.abs(xc - xp) > 26) {
        var adir = xc > xp ? 1 : -1;
        var ax = xp + (xc - xp) * 0.62;
        svg += '<path d="M ' + (ax - adir * 5).toFixed(1) + ' ' + (y - 4) +
          ' L ' + (ax + adir * 4).toFixed(1) + ' ' + y +
          ' L ' + (ax - adir * 5).toFixed(1) + ' ' + (y + 4) +
          ' z" fill="' + meta.color + '"/>';
      }
      svg += '<circle cx="' + xp.toFixed(1) + '" cy="' + yp + '" r="7.5" fill="#fffefa" stroke="' +
        meta.color + '" stroke-width="2.2"/>';
      svg += '<circle cx="' + xc.toFixed(1) + '" cy="' + yc + '" r="8.5" fill="' + meta.color +
        '" stroke="#fffefa" stroke-width="2"/>';

      svg += '<text x="34" y="' + (y - 3) + '" class="mig-name">' + qName(q.key) + '</text>';
      svg += '<text x="34" y="' + (y + 19) + '" class="mig-count">对象 ' + q.n0 + ' → ' + q.n1 + ' 个</text>';

      svg += '<text x="892" y="' + (y + 4) + '" text-anchor="end" class="mig-prior">' + pct(q.w0) + '</text>';
      svg += '<text x="906" y="' + (y + 4) + '" class="mig-arrow-glyph">→</text>';
      svg += '<text x="980" y="' + (y + 4) + '" text-anchor="end" class="mig-current">' + pct(q.w1) + '</text>';
      svg += '<text x="1000" y="' + (y + 4) + '" class="mig-delta">' + deltaText(q.dw) + '</text>';
    }

    svg += '<line x1="872" y1="62" x2="872" y2="' + (H - 26) + '" stroke="#eee7da" stroke-width="1"/>';
    svg += '</svg>';
    return svg;
  }

  function migrationPathBlock(flows) {
    var limit = 8;
    var top = flows.paths.slice(0, limit);
    var rest = flows.paths.slice(limit);
    var rows = '';

    function rowHTML(f, other) {
      var from = other ? '其他 ' + rest.length + ' 条路径' : qName(f.from);
      var to = other ? '' : qName(f.to);
      var path = other
        ? '<span class="mig-path-other">' + from + '</span>'
        : '<span class="mig-path-from">' + from + '</span>' +
          '<span class="mig-path-arrow">→</span><span class="mig-path-to">' + to + '</span>';
      return '<tr><td class="mig-path-cell">' + path + '</td>' +
        '<td class="r">' + f.n.toLocaleString('zh-CN') + '</td>' +
        '<td class="r">' + (f.from === 'NEW' && !other ? '<span class="zero">—</span>' : pct(f.w0)) + '</td>' +
        '<td class="r">' + (f.to === 'LOST' && !other ? '<span class="zero">—</span>' : pct(f.w1)) + '</td>' +
        '<td class="r"><b class="mig-path-dw">' + spp(f.dw) + '</b></td></tr>';
    }

    for (var i = 0; i < top.length; i++) rows += rowHTML(top[i], false);
    if (rest.length) {
      var n = sumBy(rest, function (f) { return f.n; });
      var w0 = sumBy(rest, function (f) { return f.w0; });
      var w1 = sumBy(rest, function (f) { return f.w1; });
      var dw = sumBy(rest, function (f) { return f.dw; });
      rows += rowHTML({ from: 'OTHER', to: 'OTHER', n: n, w0: w0, w1: w1, dw: dw }, true);
    }

    var nAll = sumBy(flows.paths, function (f) { return f.n; });
    var w0All = sumBy(flows.paths, function (f) { return f.w0; });
    var w1All = sumBy(flows.paths, function (f) { return f.w1; });
    var dwAll = sumBy(flows.paths, function (f) { return f.dw; });
    rows += '<tr class="total"><td>合计</td><td class="r">' + nAll.toLocaleString('zh-CN') + '</td>' +
      '<td class="r">' + pct(w0All) + '</td><td class="r">' + pct(w1All) + '</td>' +
      '<td class="r">' + spp(dwAll) + '</td></tr>';

    return '<div class="mig-path-block">' +
      '<div class="mig-path-head"><div class="block-title">迁移路径 · 两期占比对照</div>' +
      '<span class="mig-path-sub">按“本路径变化”绝对值排序；单条路径 ≠ 象限净变化</span></div>' +
      '<div class="mig-path-hint">表格可左右滑动 →</div>' +
      '<div class="mig-path-scroll"><table class="data-table mig-path-table">' +
      '<colgroup><col style="width:42%"><col style="width:10%"><col style="width:15%"><col style="width:15%"><col style="width:18%"></colgroup>' +
      '<thead><tr><th>上期 → 本期</th><th class="r">对象数</th><th class="r">上期占比</th><th class="r">本期占比</th><th class="r">本路径变化</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
      '<div class="table-note">“本路径变化”= 本期该路径占比 − 上期；' +
      (rest.length ? '只列绝对值前 ' + limit + ' 条，其余合并为“其他”。' : '共 ' + flows.paths.length + ' 条路径。') +
      ' 同一象限有进有出，单条路径变化可超过象限净变化；未定位对象也计入路径表。</div></div>';
  }

  function renderMigration(level, label, parents, t) {
    quadPoints = [];
    var cc = GM.quadrantConcentration(parents, t);
    var flows = GM.migrationFlow(parents, t);
    $('#quad-title').textContent = label + '象限浓度迁移 · ' + Y0 + ' → ' + Y1;
    $('#quad-desc').textContent = '收入占比 = 象限收入 ÷ 当期总收入；空心 = ' + Y0 +
      '，实心 = ' + Y1 + '，连线方向就是占比升降（单位：%）。';
    $('#quad-legend').innerHTML =
      '<span><i class="mig-dot prior"></i>' + Y0 + '占比</span>' +
      '<span><i class="mig-dot current"></i>' + Y1 + '占比</span>' +
      '<span><i class="mig-line-mark"></i>连线 = 升降方向</span>';
    var note = '共 ' + parents.length + ' 个对象；四象限占比按当期总收入计算，' +
      '占比变化单位为 %。下方路径表解释占比为什么此消彼长。';
    if (level === 'order') {
      var op = D.meta && D.meta.quality && D.meta.quality.orderPeriods;
      if (op && op.crossPeriod > 0) {
        note += ' 有 ' + op.crossPeriod.toLocaleString('zh-CN') +
          ' 个订单号两期都出现；其余“新增 / 流失”是单期订单。';
      } else {
        note += ' 没有订单号跨期；订单层“新增 / 流失”都是单期订单。';
      }
    }
    $('#quad-note').textContent = note;
    $('#quad-chart').innerHTML = migrationCallout(cc, flows, level) + migrationSvg(cc);
    $('#quad-table').innerHTML = migrationPathBlock(flows);
  }

  function renderQuadrant() {
    if (!model.quadDims || !model.quadDims.length) return;
    var level = state.quadLevel;
    var mode = state.quadMode;
    var period = state.quadPeriod;
    var label = GM.dimLabel(level);
    var parents = model.byDim[level];
    var t = model.totals;
    if (mode === 'migration') {
      $('#quad-period-group').hidden = true;
      renderMigration(level, label, parents, t);
      return;
    }
    $('#quad-period-group').hidden = false;
    var items = buildQuadItems(parents, t);
    var isBase = period === 'base';
    var perLabel = isBase ? Y0 : Y1;
    function has(d) { return isBase ? d.has0 : d.has1; }
    var totalCount = items.filter(has).length;
    var newCount = parents.filter(function (p) { return p.status === 'new'; }).length;
    var lostCount = parents.filter(function (p) { return p.status === 'lost'; }).length;
    var candidates = items.filter(has);
    candidates.sort(function (a, b) { return Math.abs(b.p.delta) - Math.abs(a.p.delta); });
    var limit = level === 'customer' ? candidates.length : 60;
    var pts = candidates.slice(0, limit);
    quadPoints = pts;

    $('#quad-title').textContent = label + '象限图 · ' + perLabel + ' · 单价 × 单位成本';
    $('#quad-desc').textContent = 'X = 单价，Y = 单位成本；虚线是' + Y0 + '均价 ' + fmtNum(t.P0) +
      ' / 平均单位成本 ' + fmtNum(t.C0) + '。气泡大小=' + perLabel + '收入，颜色=两期拉力差值方向。';

    var qs = GM.quadrantSummary(parents, t);
    var un = qs.filter(function (q) { return q.key === 'UNPLACED'; })[0] || null;
    $('#quad-table').innerHTML = concentrationTable(parents, t);

    $('#quad-legend').innerHTML =
      '<span><i class="dot pos"></i>拉力差值为正</span>' +
      '<span><i class="dot neg"></i>拉力差值为负</span>' +
      '<span><i class="zero-mark"></i>零收入 / 零成本</span>' +
      '<span>气泡大小 = ' + perLabel + '收入</span>';

    var note = perLabel + '有收入的对象 ' + totalCount + ' 个，图中 ' + pts.length + ' 个';
    if (pts.length < totalCount) note += '（按 |拉力差值| 取前 ' + limit + ' 个）';
    if (isBase) {
      note += '；上期无收入（新增）' + newCount + ' 个';
    } else {
      note += '；' + Y1 + '无收入（流失）' + lostCount + ' 个';
      if (un) note += '；另有 ' + un.n + ' 个未定位（数量为 0 或负收入）';
    }
    note += '。坐标轴为对数刻度；颜色 = 两期拉力差值方向。';
    $('#quad-note').textContent = note;

    if (!pts.length) {
      $('#quad-chart').innerHTML = '<div class="empty">没有可定位的对象。</div>';
      return;
    }

    var W = 1200, H = 490, padL = 78, padR = 28, padT = 28, padB = 64;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var xs = [], ys = [];
    for (var i = 0; i < pts.length; i++) {
      if (isBase && pts[i].has0) { xs.push(pts[i].x0); ys.push(pts[i].y0); }
      if (!isBase && pts[i].has1) { xs.push(pts[i].x1); ys.push(pts[i].y1); }
    }
    xs.push(t.P0); ys.push(t.C0);
    var lx0 = Math.log10(Math.max(0.03, Math.min.apply(null, xs)));
    var lx1 = Math.log10(Math.max(0.05, Math.max.apply(null, xs)));
    var ly0 = Math.log10(Math.max(0.03, Math.min.apply(null, ys)));
    var ly1 = Math.log10(Math.max(0.05, Math.max.apply(null, ys)));
    var padX = Math.max(0.08, (lx1 - lx0) * 0.08);
    var padY = Math.max(0.08, (ly1 - ly0) * 0.08);
    lx0 -= padX; lx1 += padX; ly0 -= padY; ly1 += padY;

    function sx(v) { return padL + (Math.log10(v) - lx0) / (lx1 - lx0) * plotW; }
    function sy(v) { return padT + (1 - (Math.log10(v) - ly0) / (ly1 - ly0)) * plotH; }

    var x0 = sx(t.P0), y0 = sy(t.C0);
    var ticks = [0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000, 3000, 10000, 30000, 100000];
    var xt = ticks.filter(function (v) { return v >= Math.pow(10, lx0) && v <= Math.pow(10, lx1); });
    var yt = ticks.filter(function (v) { return v >= Math.pow(10, ly0) && v <= Math.pow(10, ly1); });
    if (xt.length < 3) xt = [Math.pow(10, lx0), Math.pow(10, (lx0 + lx1) / 2), Math.pow(10, lx1)];
    if (yt.length < 3) yt = [Math.pow(10, ly0), Math.pow(10, (ly0 + ly1) / 2), Math.pow(10, ly1)];

    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + label + '单价与单位成本象限图">';
    svg += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#fff"/>';
    svg += '<rect x="' + padL + '" y="' + padT + '" width="' + (x0 - padL) + '" height="' + (y0 - padT) + '" fill="#fef5f4"/>';
    svg += '<rect x="' + x0 + '" y="' + padT + '" width="' + (padL + plotW - x0) + '" height="' + (y0 - padT) + '" fill="#fafbfc"/>';
    svg += '<rect x="' + padL + '" y="' + y0 + '" width="' + (x0 - padL) + '" height="' + (padT + plotH - y0) + '" fill="#fafbfc"/>';
    svg += '<rect x="' + x0 + '" y="' + y0 + '" width="' + (padL + plotW - x0) + '" height="' + (padT + plotH - y0) + '" fill="#f3fbf6"/>';

    for (var xi = 0; xi < xt.length; xi++) {
      var gx = sx(xt[xi]);
      svg += '<line x1="' + gx.toFixed(1) + '" y1="' + padT + '" x2="' + gx.toFixed(1) + '" y2="' + (padT + plotH) + '" stroke="#eef2f6" stroke-width="1"/>';
      svg += '<text x="' + gx.toFixed(1) + '" y="' + (padT + plotH + 21) + '" text-anchor="middle" class="tick">' + fmtAxis(xt[xi]) + '</text>';
    }
    for (var yi = 0; yi < yt.length; yi++) {
      var gy = sy(yt[yi]);
      svg += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (padL + plotW) + '" y2="' + gy.toFixed(1) + '" stroke="#eef2f6" stroke-width="1"/>';
      svg += '<text x="' + (padL - 10) + '" y="' + (gy + 4).toFixed(1) + '" text-anchor="end" class="tick">' + fmtAxis(yt[yi]) + '</text>';
    }

    svg += '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (padT + plotH) + '" stroke="#d7dde5" stroke-width="1"/>';
    svg += '<line x1="' + padL + '" y1="' + (padT + plotH) + '" x2="' + (padL + plotW) + '" y2="' + (padT + plotH) + '" stroke="#d7dde5" stroke-width="1"/>';
    svg += '<line x1="' + padL + '" y1="' + y0.toFixed(1) + '" x2="' + (padL + plotW) + '" y2="' + y0.toFixed(1) + '" class="ref-line"/>';
    svg += '<line x1="' + x0.toFixed(1) + '" y1="' + padT + '" x2="' + x0.toFixed(1) + '" y2="' + (padT + plotH) + '" class="ref-line"/>';
    svg += '<text x="' + (padL + plotW / 2) + '" y="' + (H - 12) + '" text-anchor="middle" class="axis-title">单价（对数刻度）</text>';
    svg += '<text x="18" y="' + (padT + plotH / 2) + '" text-anchor="middle" transform="rotate(-90 18 ' + (padT + plotH / 2) + ')" class="axis-title">单位成本（对数刻度）</text>';

    svg += '<text x="' + (padL + 14) + '" y="' + (padT + 22) + '" class="q-label">失血区</text>';
    svg += '<text x="' + (padL + 14) + '" y="' + (padT + 38) + '" class="q-sub">低单价 / 高成本</text>';
    svg += '<text x="' + (padL + plotW - 14) + '" y="' + (padT + 22) + '" text-anchor="end" class="q-label">附加值区</text>';
    svg += '<text x="' + (padL + plotW - 14) + '" y="' + (padT + 38) + '" text-anchor="end" class="q-sub">高单价 / 高成本</text>';
    var yb = Math.min(y0 + 24, padT + plotH - 27);
    svg += '<text x="' + (padL + 14) + '" y="' + yb + '" class="q-label">走量区</text>';
    svg += '<text x="' + (padL + 14) + '" y="' + (yb + 16) + '" class="q-sub">低单价 / 低成本</text>';
    svg += '<text x="' + (padL + plotW - 14) + '" y="' + yb + '" text-anchor="end" class="q-label">暴利区</text>';
    svg += '<text x="' + (padL + plotW - 14) + '" y="' + (yb + 16) + '" text-anchor="end" class="q-sub">高单价 / 低成本</text>';

    var maxRev = 0;
    for (var k = 0; k < pts.length; k++) {
      var rv = isBase ? pts[k].rev0 : pts[k].rev1;
      maxRev = Math.max(maxRev, Math.abs(rv));
    }
    function bubbleRadius(rev) { return 4 + 10 * Math.sqrt(Math.max(0, rev) / Math.max(1, maxRev)); }
    for (var q = 0; q < pts.length; q++) {
      var c = pts[q];
      var cx = isBase ? sx(c.x0) : sx(c.x1);
      var cy = isBase ? sy(c.y0) : sy(c.y1);
      var rev = isBase ? c.rev0 : c.rev1;
      var rr = bubbleRadius(rev);
      var zero = isBase ? (c.zeroC0 || c.zeroP0) : (c.zeroC1 || c.zeroP1);
      var col = c.p.delta > 0 ? '#067647' : (c.p.delta < 0 ? '#b42318' : '#98a2b3');
      svg += '<circle class="bubble" cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + rr.toFixed(1) +
        '" fill="' + col + '" fill-opacity=".74" stroke="' + (zero ? '#d97706' : '#fff') + '" stroke-width="' +
        (zero ? '1.6' : '1') + '"' + (zero ? ' stroke-dasharray="2 2"' : '') + ' data-idx="' + q + '"/>';
    }
    svg += '</svg>';
    $('#quad-chart').innerHTML = svg;
  }

  function concentrationTable(parents, t) {
    var cs = GM.quadrantConcentration(parents, t);
    var qs = GM.quadrantSummary(parents, t);
    var un = qs.filter(function (q) { return q.key === 'UNPLACED'; })[0];
    var rows = '';
    for (var i = 0; i < cs.length; i++) {
      var q = cs[i];
      if (!q.n0 && !q.n1) continue;
      rows += '<tr><td>' + esc(q.label) + '</td>' +
        '<td class="r">' + q.n0 + '</td><td class="r">' + q.n1 + '</td>' +
        '<td class="r">' + pct(q.w0) + '</td><td class="r">' + pct(q.w1) + '</td>' +
        '<td class="r">' + spp(q.dw) + '</td></tr>';
    }
    var note = '<div class="table-note">' + Y0 + '分布含本期流失对象，' + Y1 + '分布含本期新增对象；分母分别为当期总收入；占比变化单位为 %。';
    if (un && un.reasons) {
      note += ' 未定位 ' + un.n + ' 个：数量为 0 ' + un.reasons.zeroQty +
        ' 个、负收入 ' + un.reasons.negative + ' 个；零成本 / 零收入仍可定位。';
    }
    note += '</div>';
    return '<div class="quad-block"><div class="block-title">象限收入浓度 · ' + Y0 + ' vs ' + Y1 + '</div>' +
      '<table class="data-table quad-table"><colgroup><col style="width:27%"><col style="width:12%"><col style="width:12%"><col style="width:17%"><col style="width:17%"><col style="width:15%"></colgroup>' +
      '<thead><tr><th>象限</th><th class="r">' + Y0 + '对象数</th><th class="r">' + Y1 + '对象数</th><th class="r">' + Y0 + '收入占比</th><th class="r">' + Y1 + '收入占比</th><th class="r">变化(%)</th></tr></thead>' +
      '<tbody>' + rows +
      '<tr class="total"><td>合计</td><td class="r">' + sumBy(cs, function (x) { return x.n0; }) +
      '</td><td class="r">' + sumBy(cs, function (x) { return x.n1; }) +
      '</td><td class="r">' + pct(sumBy(cs, function (x) { return x.w0; })) +
      '</td><td class="r">' + pct(sumBy(cs, function (x) { return x.w1; })) +
      '</td><td class="r">0.00%</td></tr>' +
      '</tbody></table>' + note + '</div>';
  }

  function showTip(e, idx) {
    var d = quadPoints[idx];
    if (!d) return;
    var p = d.p;
    var lines = '';
    if (d.has0) {
      lines += '<div class="tip-row">' + Y0 + '：单价 ' + fmtNum(p.p0) + ' · 单位成本 ' + fmtNum(p.c0) +
        ' · ' + qShort(d.q0) + (d.zeroP0 || d.zeroC0 ? '（零值）' : '') + '</div>';
    }
    if (d.has1) {
      lines += '<div class="tip-row">' + Y1 + '：单价 ' + fmtNum(p.p1) + ' · 单位成本 ' + fmtNum(p.c1) +
        ' · ' + qShort(d.q1) + (d.zeroP1 || d.zeroC1 ? '（零值）' : '') + '</div>';
    }
    if (d.q0 && d.q1 && d.q0 !== d.q1) {
      lines += '<div class="tip-row">迁移：' + qLong(d.q0) + ' → ' + qLong(d.q1) + '</div>';
    }
    if (!d.has1) lines += '<div class="tip-row">' + Y1 + '无收入（流失）</div>';
    var isBase = state.quadPeriod === 'base';
    var perLabel = isBase ? Y0 : Y1;
    var rev = isBase ? p.s0 : p.s1;
    var cost = isBase ? p.k0 : p.k1;
    var w = isBase ? p.w0 : p.w1;
    var tip = $('#tooltip');
    tip.innerHTML = '<div class="tip-name">' + esc(p.key) + ' · ' + statusText(p.status) + '</div>' +
      lines +
      '<div class="tip-row">拉力差值 <b class="' + cls(p.delta) + '">' + spp(p.delta) + '</b>（价格 ' + spp(p.dprice) + ' / 成本 ' + spp(p.dcost) + '）</div>' +
      '<div class="tip-row">' + perLabel + '：收入 ' + fmtMoney(rev) + ' · 成本 ' + fmtMoney(cost) + ' · 占比 ' + pct(w) + '</div>' +
      '<div class="tip-row" style="color:#94a3b8">点击查看点详情</div>';
    tip.classList.add('show');
    positionTip(e);
  }

  function positionTip(e) {
    var tip = $('#tooltip');
    var x = e.clientX + 14;
    var y = e.clientY + 14;
    var rect = tip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 12) x = e.clientX - rect.width - 14;
    if (y + rect.height > window.innerHeight - 12) y = e.clientY - rect.height - 14;
    tip.style.left = Math.max(8, x) + 'px';
    tip.style.top = Math.max(8, y) + 'px';
  }

  function hideTip() { $('#tooltip').classList.remove('show'); }

  function openMethod() {
    var t = model.totals;
    $('#method-body').innerHTML =
      '<p><b>拉力</b>衡量某个对象把总毛利率往上拉还是往下拉。它不解释业务原因，只把“变化”分摊到对象上。</p>' +
      '<div class="formula">拉力 = (' + Y1 + '毛利率 − ' + Y0 + '总体毛利率) × ' + Y1 + '收入占比\n' +
      '     = ((1 − R0) × 当期收入 − 当期成本) / 当期总收入</div>' +
      '<p>其中 R0 = ' + Y0 + '总体毛利率 ' + pct(t.R0) + '。' + Y0 + '年每一行的拉力之和为 0；' + Y1 + '年之和为 ' + spp(t.dGM) + '，正好等于毛利率变化。</p>' +
      '<h3>每一行用哪个分母？</h3>' +
      '<p><b>' + Y0 + '行用' + Y0 + '总收入 ' + fmtWan(t.S0) + ' 万元，' + Y1 + '行用' + Y1 + '总收入 ' + fmtWan(t.S1) + ' 万元。</b>不是所有行都除以' + Y1 + '总收入。Excel 里如果用同一个分母复算上期行，结果会整体放大 ' + spct(t.S1 / t.S0 - 1) + '，看起来就像“算错了”。</p>' +
      '<h3>价格拉力和成本拉力</h3>' +
      '<div class="formula">价格拉力 = (1 − R0) × (当期收入 − ' + Y0 + '均价 × 当期数量) / 当期总收入\n' +
      '成本拉力 = (' + Y0 + '平均单位成本 × 当期数量 − 当期成本) / 当期总收入\n' +
      '拉力 = 价格拉力 + 成本拉力</div>' +
      '<div class="formula">等价写法：价格拉力 = 上期平均单位成本 × (计算单价 / 上期均价 − 1) × 数量 / 当期总收入\n' +
      '计算单价 = 销售收入 / 数量</div>' +
      '<p>两种写法完全等价。导出里的“计算单价”按收入 ÷ 数量计算；原始“单位售价”可能有四舍五入，直接拿原始单价复算会出现尾差。这样写也不除以订单收入，赠品、零收入、退货行都不会出现除零错误。</p>' +
      '<p>基准均价 = ' + Y0 + '总收入 ÷ ' + Y0 + '总数量，基准单位成本 = ' + Y0 + '总成本 ÷ ' + Y0 + '总数量，都是加权值，不是对行单价 / 行单位成本做简单平均。</p>' +
      '<h3>为什么价格 / 成本会很大？</h3>' +
      '<p>基准是' + Y0 + '公司均价 ' + fmtNum(t.P0) + ' 元、平均单位成本 ' + fmtNum(t.C0) + ' 元，不是每个对象自己的上期价格。结构变化（高价 / 低价产品占比）会同时进入价格与成本，所以两项经常大幅对冲。本案' + Y1 + '价格拉力 ' + spp(t.price1) + '、成本拉力 ' + spp(t.cost1) + '，相抵后 ' + spp(t.dGM) + '。看结论时看“拉力差值”，不要单独看价格或成本。</p>' +
      '<p><b>注意：</b>这两个数不是价格指数、成本指数，不能当成“价格指数 ' + spp(t.price1) + '、成本指数 ' + spp(t.cost1) + '”来读。它们是把结构变化折算到价格、成本两个维度后的拉力贡献。</p>' +
      '<h3>拉力差值</h3>' +
      '<div class="formula">拉力差值 = ' + Y1 + '拉力 − ' + Y0 + '拉力</div>' +
      '<p>按当前维度汇总后，所有对象的拉力差值相加 = 毛利率变化 ' + spp(t.dGM) + '。订单级同理；某张订单只在一期出现时，缺失年份按 0 计，差值就等于该订单单期拉力。</p>' +
      '<h3>毛利率构成：拉力水平</h3>' +
      '<p>“毛利率构成分析”列的是所选期间的拉力水平，不是拉力差值。' + Y1 + '毛利率 = ' + Y0 + '毛利率 + ' + Y1 + '拉力合计；' + Y0 + '逐行拉力合计为 0。拉力水平回答“谁撑起本期毛利率”，拉力差回答“谁让毛利率变了”，两者排序可能完全不同。</p>' +
      '<h3>复核</h3>' +
      '<p>逐行校验：拉力 − 价格拉力 − 成本拉力 的最大误差为 ' + model.checks.maxRowCheck.toExponential(1) + '；' + Y0 + '逐行拉力合计 0.00%，' + Y1 + '合计 ' + spp(t.dGM) + '。</p>' +
      '<p>导出明细已补齐：基准毛利率、上期均价、上期平均单位成本、当期总收入、计算单价 / 单位成本、金额口径的三项拉力、校验差。Excel 按上面的公式可以直接复算，不需要自己猜分母。</p>' +
      '<h3>结论的帕累托阈值</h3>' +
      '<p><b>客户：累计到 80% 或前 7 大，先到先止。订单：累计到 80% 或前 15 张，先到先止。</b>两条规则是“或”的关系，不是先取 7 个再补到 80%。如果先触顶，页面会明确写“覆盖 xx%，未达 80%”，不会把截断说成达标。这样数据很散时最多 7 个客户、每个客户最多 15 张订单，页面不会被数十个对象撑爆。</p>' +
      '<h3>象限、零值与未定位</h3>' +
      '<p>象限按上期均价 / 平均单位成本切分：零成本可以定位（低成本），零收入也可以定位（低单价、高成本）。只有数量为 0、或负收入 / 负成本，单价或单位成本无法计算，才列为“未定位”。</p>' +
      '<p>单期分布可切“上期 / 本期”：X = 单价，单价越高越靠右；Y = 单位成本，成本越高越靠上。气泡大小 = 所选期间收入，颜色 = 两期拉力差值方向；点开可看该期收入 / 成本、拉力差值、价格拉力、成本拉力。</p>' +
      '<p>“两期迁移”不画散点，直接比较四个象限的收入占比：空心点是上期占比，实心点是本期占比，连线方向就是占比升降。下方“迁移路径”按上期 → 本期汇总对象数、两期占比和本路径变化；同一象限有进有出，单条路径变化不等同于象限净变化。</p>' +
      '<h3>为什么不做结构拉力？</h3>' +
      '<p>按当前口径，结构变化已经体现在价格与成本中，不再单列结构项。这样每一行只有价格、成本两项，公式简单、可逐行复核。</p>' +
      '<div class="audit-export"><button class="btn btn-sm" data-export-audit>下载复核底稿（全精度）</button>' +
      '<span>页面保留 2 位小数；导出主明细 6 位小数；底稿保留全精度，供逐行复算。</span></div>' +
      '<p class="muted">本页只做数据归因，不解释业务原因。业务原因请沿着当前维度 / 订单继续查。</p>';
    $('#method-modal').classList.add('show');
    $('#modal-mask').classList.add('show');
  }

  function closeMethod() {
    $('#method-modal').classList.remove('show');
    $('#modal-mask').classList.remove('show');
  }

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function downloadCSV(filename, rows) {
    var text = rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    var blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('已导出 ' + (rows.length - 1) + ' 行');
  }

  function safeName(s) { return String(s).replace(/[\\/:*?"<>|]/g, '_'); }

  function fx(v, d) {
    if (v == null || !isFinite(v)) return '';
    var x = Number(v);
    if (Math.abs(x) < 0.5 * Math.pow(10, -d)) x = 0;
    return x.toFixed(d);
  }

  function exportAll(precise) {
    var t = model.totals;
    var p = !!precise;
    var dims = (D.meta && D.meta.dims && D.meta.dims.length) ? D.meta.dims : model.dims;
    var data = [];
    for (var i = 0; i < D.rows.length; i++) {
      var r = model.rows[i];
      var S = r.year === 0 ? t.S0 : t.S1;
      var dimVals = [];
      for (var di = 0; di < dims.length; di++) dimVals.push(r[dims[di].key] == null ? '' : r[dims[di].key]);
      data.push({
        year: r.year,
        period: r.year === 0 ? PERIOD0 : PERIOD1,
        dims: dimVals,
        qty: r.qty, unitPrice: r.unitPrice,
        calcPrice: r.qty > 0 ? r.rev / r.qty : null,
        rev: r.rev, cost: r.cost,
        calcCost: r.qty > 0 ? r.cost / r.qty : null,
        gm: r.rev > 0 ? (1 - r.cost / r.rev) * 100 : null,
        R0: t.R0 * 100, P0: t.P0, C0: t.C0, S: S,
        pull: r.pull * 100, price: r.price * 100, costPull: r.costPull * 100,
        pullAmt: r.pull * S, priceAmt: r.price * S, costAmt: r.costPull * S,
        check: (r.pull - r.price - r.costPull) * 100
      });
    }

    // 6 位小数版：最大余数法把尾差归集到价格 / 成本，拉力由两项相加，保证逐行恒等。
    function adjust(key, target, year) {
      var scale = 1e6;
      var idx = [];
      for (var i = 0; i < data.length; i++) if (data[i].year === year) idx.push(i);
      var vals = idx.map(function (i) { return data[i][key]; });
      var rounded = vals.map(function (v) { return Math.round(v * scale) / scale; });
      var sum = rounded.reduce(function (a, b) { return a + b; }, 0);
      var diff = Math.round((target - sum) * scale);
      if (diff !== 0) {
        var errs = vals.map(function (v, i) { return { i: i, e: v - rounded[i] }; });
        errs.sort(diff > 0
          ? function (a, b) { return b.e - a.e; }
          : function (a, b) { return a.e - b.e; });
        for (var k = 0; k < Math.abs(diff) && k < errs.length; k++) {
          rounded[errs[k].i] += diff > 0 ? 1 / scale : -1 / scale;
        }
      }
      for (var j = 0; j < idx.length; j++) data[idx[j]][key] = rounded[j];
    }
    if (!p) {
      adjust('price', 0, 0); adjust('costPull', 0, 0);
      adjust('price', t.price1 * 100, 1);
      adjust('costPull', t.cost1 * 100, 1);
      for (var q = 0; q < data.length; q++) {
        data[q].pull = Math.round((data[q].price + data[q].costPull) * 1e6) / 1e6;
      }
    }

    var nd = 6;
    var qd = p ? 6 : nd;
    var pd = p ? 10 : nd;
    var gd = p ? 12 : nd;
    var bd = p ? 12 : nd;
    var td = p ? 12 : nd;
    var ad = p ? 6 : nd;
    var amd = p ? 6 : nd;
    var head = ['期间'].concat(dims.map(function (d) { return d.label; })).concat([
      '数量',
      '原始单位售价(元)', '计算单价(元/单位)', '销售收入(元)', '销售成本(元)', '计算单位成本(元/单位)',
      '毛利率(%)', '基准-上期毛利率(%)', '基准-上期均价(元)', '基准-上期平均单位成本(元)',
      '口径-当期总收入(元)',
      '拉力(百分点)', '价格拉力(百分点)', '成本拉力(百分点)',
      '拉力(元)', '价格拉力(元)', '成本拉力(元)', '校验差(百分点)', '业务原因（请补充）'
    ]);
    var rows = [head];
    for (var m = 0; m < data.length; m++) {
      var d = data[m];
      var row = [d.period].concat(d.dims).concat([
        fx(d.qty, qd),
        fx(d.unitPrice, qd), fx(d.calcPrice, pd), fx(d.rev, ad), fx(d.cost, ad), fx(d.calcCost, pd),
        d.gm == null ? '' : fx(d.gm, gd),
        fx(d.R0, bd), fx(d.P0, bd), fx(d.C0, bd), fx(d.S, ad),
        fx(d.pull, td), fx(d.price, td), fx(d.costPull, td),
        fx(d.pullAmt, amd), fx(d.priceAmt, amd), fx(d.costAmt, amd),
        fx(d.check, td), ''
      ]);
      rows.push(row);
    }
    var fn = p
      ? '毛利率归因_全部明细_复核底稿_全精度_' + safeName(PERIOD0) + '_' + safeName(PERIOD1) + '.csv'
      : '毛利率归因_全部明细_6位小数_' + safeName(PERIOD0) + '_' + safeName(PERIOD1) + '.csv';
    downloadCSV(fn, rows);
  }

  function exportDim() {
    var list = filteredParents();
    var label = GM.dimLabel(state.dim);
    var rows = [[
      '维度', '名称', '状态', Y0 + '毛利率(%)', Y1 + '毛利率(%)', '毛利率变化(百分点)',
      '拉力差值(百分点)', '价格拉力差值(百分点)', '成本拉力差值(百分点)', '校验差(百分点)',
      Y0 + '收入(元)', Y1 + '收入(元)', Y1 + '收入占比(%)', '业务原因（请补充）'
    ]];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      rows.push([
        label, p.key, statusText(p.status),
        p.gm0 == null ? '' : fx(p.gm0 * 100, 6),
        p.gm1 == null ? '' : fx(p.gm1 * 100, 6),
        p.dgm == null ? '' : fx(p.dgm * 100, 6),
        fx(p.delta * 100, 6),
        fx(p.dprice * 100, 6),
        fx(p.dcost * 100, 6),
        fx((p.delta - p.dprice - p.dcost) * 100, 6),
        fx(p.s0, 6), fx(p.s1, 6), fx(p.w1 * 100, 6), ''
      ]);
    }
    downloadCSV('毛利率归因_' + label + '_6位小数_' + safeName(PERIOD0) + '_' + safeName(PERIOD1) + '.csv', rows);
  }

  function exportOrders() {
    if (!currentOrderData) return;
    var d = currentOrderData;
    var rows = [[
      '订单号', '类型', Y0 + '收入(元)', Y1 + '收入(元)',
      '拉力差值(百分点)', '价格拉力差值(百分点)', '成本拉力差值(百分点)', '校验差(百分点)', '业务原因（请补充）'
    ]];
    for (var i = 0; i < d.orders.length; i++) {
      var o = d.orders[i];
      rows.push([
        o.key, statusText(o.status), fx(o.s0, 6), fx(o.s1, 6),
        fx(o.delta * 100, 6),
        fx(o.dprice * 100, 6),
        fx(o.dcost * 100, 6),
        fx((o.delta - o.dprice - o.dcost) * 100, 6),
        fx(0, 6), ''
      ]);
    }
    downloadCSV('毛利率归因_' + safeName(d.parent.key) + '_订单明细_6位小数.csv', rows);
  }

  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  function resetGroups() {
    state.groups = { pos: { open: true, all: false }, neg: { open: true, all: false } };
  }

  function bind() {
    $('#support-dim-tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-support-dim]');
      if (!b) return;
      var d = b.getAttribute('data-support-dim');
      if (d === state.supportDim) return;
      state.supportDim = d;
      state.supportOpenKey = null;
      state.supportGroups = { pos: { open: true }, neg: { open: true } };
      renderSupport();
    });

    $('#support-period').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-support-period]');
      if (!b) return;
      var p = b.getAttribute('data-support-period');
      if (p === state.supportPeriod) return;
      state.supportPeriod = p;
      state.supportOpenKey = null;
      state.supportGroups = { pos: { open: true }, neg: { open: true } };
      renderSupport();
    });

    $('#support-fold').addEventListener('click', function () {
      state.supportFold = !state.supportFold;
      state.supportOpenKey = null;
      renderSupport();
    });

    $('#support-groups').addEventListener('click', function (e) {
      if (e.target.closest('[data-close-support-detail]')) {
        closeSupportDetail();
        return;
      }
      var head = e.target.closest('[data-support-group]');
      if (head) {
        var k = head.getAttribute('data-support-group');
        state.supportGroups[k].open = !state.supportGroups[k].open;
        state.supportOpenKey = null;
        renderSupport();
        return;
      }
      var tr = e.target.closest('tr[data-support-key]');
      if (!tr) return;
      var parent = model.byDim[state.supportDim].find(function (p) { return p.key === tr.getAttribute('data-support-key'); });
      if (parent) openSupportDetail(tr, parent);
    });

    $('#support-groups').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var head = e.target.closest('[data-support-group]');
      if (head) {
        e.preventDefault();
        var k = head.getAttribute('data-support-group');
        state.supportGroups[k].open = !state.supportGroups[k].open;
        state.supportOpenKey = null;
        renderSupport();
        return;
      }
      var tr = e.target.closest('tr[data-support-key]');
      if (!tr) return;
      e.preventDefault();
      var parent = model.byDim[state.supportDim].find(function (p) { return p.key === tr.getAttribute('data-support-key'); });
      if (parent) openSupportDetail(tr, parent);
    });

    $('#dim-tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-dim]');
      if (!b) return;
      var d = b.getAttribute('data-dim');
      if (d === state.dim) return;
      state.dim = d;
      state.search = '';
      state.openKey = null;
      resetGroups();
      $('#search').value = '';
      $('#search').placeholder = '搜索' + GM.dimLabel(d) + '…';
      Array.prototype.forEach.call(document.querySelectorAll('#dim-tabs button'), function (x) {
        x.classList.toggle('active', x === b);
      });
      closeDrawer();
      renderLocate();
    });

    $('#search').addEventListener('input', function (e) {
      state.search = e.target.value.trim();
      state.openKey = null;
      state.groups.pos.all = false;
      state.groups.neg.all = false;
      renderLocate();
    });

    $('#loc-groups').addEventListener('click', function (e) {
      if (e.target.closest('[data-close-detail]')) {
        closeInlineDetail();
        return;
      }
      if (e.target.closest('[data-export-orders]')) {
        exportOrders();
        return;
      }
      var more = e.target.closest('[data-group-more]');
      if (more) {
        var mk = more.getAttribute('data-group-more');
        state.groups[mk].all = !state.groups[mk].all;
        state.openKey = null;
        renderLocate();
        return;
      }
      var head = e.target.closest('[data-group]');
      if (head) {
        var hk = head.getAttribute('data-group');
        state.groups[hk].open = !state.groups[hk].open;
        state.openKey = null;
        renderLocate();
        return;
      }
      var tr = e.target.closest('tr[data-key]');
      if (!tr) return;
      var key = tr.getAttribute('data-key');
      var parent = model.byDim[state.dim].find(function (p) { return p.key === key; });
      if (parent) openInlineDetail(tr, parent);
    });

    $('#loc-groups').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var head = e.target.closest('[data-group]');
      if (head) {
        e.preventDefault();
        var hk = head.getAttribute('data-group');
        state.groups[hk].open = !state.groups[hk].open;
        state.openKey = null;
        renderLocate();
        return;
      }
      var tr = e.target.closest('tr[data-key]');
      if (!tr) return;
      e.preventDefault();
      var key = tr.getAttribute('data-key');
      var parent = model.byDim[state.dim].find(function (p) { return p.key === key; });
      if (parent) openInlineDetail(tr, parent);
    });

    $('#quad-tabs').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-level]');
      if (!b) return;
      var level = b.getAttribute('data-level');
      if (level === state.quadLevel) return;
      state.quadLevel = level;
      Array.prototype.forEach.call(document.querySelectorAll('#quad-tabs button'), function (x) {
        x.classList.toggle('active', x === b);
      });
      hideTip();
      renderQuadrant();
    });

    $('#quad-mode').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-mode]');
      if (!b) return;
      var mode = b.getAttribute('data-mode');
      if (mode === state.quadMode) return;
      state.quadMode = mode;
      Array.prototype.forEach.call(document.querySelectorAll('#quad-mode button'), function (x) {
        x.classList.toggle('active', x === b);
      });
      hideTip();
      renderQuadrant();
    });

    $('#quad-period').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-period]');
      if (!b) return;
      var period = b.getAttribute('data-period');
      if (period === state.quadPeriod) return;
      state.quadPeriod = period;
      Array.prototype.forEach.call(document.querySelectorAll('#quad-period button'), function (x) {
        x.classList.toggle('active', x === b);
      });
      hideTip();
      renderQuadrant();
    });

    $('#quad-chart').addEventListener('mouseover', function (e) {
      var c = e.target.closest('circle[data-idx]');
      if (!c) return;
      showTip(e, Number(c.getAttribute('data-idx')));
    });
    $('#quad-chart').addEventListener('mousemove', function (e) {
      if ($('#tooltip').classList.contains('show')) positionTip(e);
    });
    $('#quad-chart').addEventListener('mouseout', function (e) {
      var c = e.target.closest('circle[data-idx]');
      if (c) hideTip();
    });
    $('#quad-chart').addEventListener('click', function (e) {
      var c = e.target.closest('circle[data-idx]');
      if (!c) return;
      var d = quadPoints[Number(c.getAttribute('data-idx'))];
      if (d) {
        hideTip();
        openPointDrawer(d.p, state.quadLevel, state.quadPeriod);
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-section-toggle]'), function (btn) {
      btn.addEventListener('click', function () {
        var card = btn.closest('.card');
        if (!card) return;
        var collapsed = card.classList.toggle('collapsed');
        btn.textContent = collapsed ? '展开 ⌄' : '收起 ⌃';
        btn.setAttribute('aria-expanded', String(!collapsed));
      });
    });

    $('#btn-method').addEventListener('click', openMethod);
    $('#btn-close-method').addEventListener('click', closeMethod);
    $('#modal-mask').addEventListener('click', closeMethod);
    $('#drawer-mask').addEventListener('click', closeDrawer);
    $('#drawer-close').addEventListener('click', closeDrawer);
    $('#btn-export-all').addEventListener('click', function () { exportAll(false); });
    $('#btn-export-dim').addEventListener('click', exportDim);
    $('#method-body').addEventListener('click', function (e) {
      if (e.target.closest('[data-export-audit]')) exportAll(true);
    });

    $('#order-drawer').addEventListener('click', function (e) {
      if (e.target.closest('[data-export-orders]')) exportOrders();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeMethod();
        closeDrawer();
        hideTip();
        closeInlineDetail();
      }
    });
  }

  function init() {
    if (!window.GM_DATA || !GM) {
      document.body.innerHTML = '<div style="padding:40px;font:15px/1.7 sans-serif;">数据或计算内核未加载。</div>';
      return;
    }
    model = GM.build();
    if (model.error) {
      document.body.innerHTML = '<div style="padding:40px;font:15px/1.7 sans-serif;">' + esc(model.error) + '</div>';
      return;
    }
    state.dim = model.primaryDim;
    state.supportDim = model.primaryDim;
    var qd = model.quadDims || [];
    state.quadLevel = qd.some(function (d) { return d.key === model.primaryDim; })
      ? model.primaryDim
      : (qd[0] ? qd[0].key : model.primaryDim);
    $('#search').placeholder = '搜索' + GM.dimLabel(state.dim) + '…';
    renderDimensionTabs();
    renderSupport();
    renderIntro();
    renderConclusion();
    renderOverview();
    renderLocate();
    renderQuadrant();
    bind();
  }

  init();
})();
