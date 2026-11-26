'use strict';
/**
 * view.js - Diagnose's pages, drawn from what engine.js keeps (it never computes, only reads and lays out).
 *   draw(cv, t, page, s)   s = { e: Engine, now, items (anomalies, newest first), sel, settings, note, demo, act }
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const qr = require('./kit/qr');
const { CHANNELS, CHECKS, CH } = require('./engine');
const { Z_ODD, Z_OK } = require('./kit/analyse');

const GO = '#2fd27a';
const isNum = (v) => typeof v === 'number' && isFinite(v);
const two = (n) => (n < 10 ? '0' : '') + n;
const clock = (ms) => { const d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()); };
const day = (ms) => { const d = new Date(ms); return d.getDate() + '.' + two(d.getMonth() + 1) + '. ' + two(d.getHours()) + ':' + two(d.getMinutes()); };
const val = (id, v) => (isNum(v) ? v.toFixed(CH[id] ? CH[id].d : 1) + (CH[id] && CH[id].unit ? ' ' + CH[id].unit : '') : '--');
const LEVEL = { ok: ['FINE', GO], learning: ['LEARNING', null], odd: ['OFF', null], off: ['NOT NOW', null] };
const lvColor = (t, l) => (l === 'ok' ? GO : l === 'odd' ? t.crit : l === 'learning' ? t.warn : t.dim);
const secs = (ms) => (ms >= 0 ? '+' : '-') + Math.abs(ms / 1000).toFixed(1) + ' s';

/** Words cut into lines no wider than w at size. */
function wrap(cv, text, size, w, opt) {
    const out = [];
    let line = '';
    String(text).split(' ').forEach((word) => {
        const tryLine = line ? line + ' ' + word : word;
        if (line && cv.textWidth(tryLine, size, opt) > w) { out.push(line); line = word; } else line = tryLine;
    });
    if (line) out.push(line);
    return out;
}
function para(cv, t, text, x, y, size, w, color, gap, opt) {
    const lines = wrap(cv, text, size, w, opt);
    lines.forEach((l, i) => cv.text(l, x, y + i * (gap || size * 1.3), size, color || t.dim, opt));
    return lines.length * (gap || size * 1.3);
}

/* A z bar: the middle is the usual line, the soft band is normal wander (Z_OK), the outer marks where it counts as off. */
function zBar(cv, t, x, y, w, h, z, level) {
    const span = 8, X = (v) => x + w / 2 + G.clamp(v / span, -1, 1) * w / 2;
    cv.roundRect(x, y, w, h, h / 2, t.track);
    cv.roundRect(X(-Z_OK), y, X(Z_OK) - X(-Z_OK), h, h / 2, withAlpha(GO, 0.28));
    [-Z_ODD, Z_ODD].forEach((v) => cv.fillRect(X(v) - 1, y - 3, 2, h + 6, withAlpha(t.crit, 0.8)));
    cv.fillRect(x + w / 2 - 1, y - 2, 2, h + 4, withAlpha(t.text, 0.5));
    if (isNum(z)) { cv.circle(X(z), y + h / 2, h * 0.9, lvColor(t, level)); cv.circle(X(z), y + h / 2, h * 0.35, t.bg); }
}

/* ---------------- Anomalies ---------------- */
function anomalies(cv, t, s) {
    const e = s.e;
    G.panel(cv, t, 24, 44, 1552, 104, null);
    cv.text('CHECKS RIGHT NOW', 48, 74, 17, t.dim, { font: 'bold', spacing: 2 });
    cv.text(s.note || 'Each check learns this car first; red means it left its usual line', 1552, 74, 17, s.note ? t.warn : t.dim, { align: 'right' });
    const cw = 1504 / CHECKS.length;
    CHECKS.forEach((ck, i) => {
        const st = e.A.state(ck.id), x = 48 + i * cw, L = LEVEL[st.level] || LEVEL.off;
        cv.text(ck.short, x, 112, 22, t.text, { font: 'bold' });
        G.pill(cv, t, x + cw - 136, 92, 118, 26, L[0], { color: lvColor(t, st.level), size: 14 });
        zBar(cv, t, x, 128, cw - 18, 8, st.z, st.level);
    });

    const p = G.panel(cv, t, 24, 160, 1000, 352, 'What is compared with what');
    cv.text('the dot: now, the middle: the usual line here, red marks: off', p.x + p.w - 20, 202, 16, t.dim, { align: 'right' });
    CHECKS.forEach((ck, i) => {
        const st = e.A.state(ck.id), y = 222 + i * 57;
        cv.text(ck.name, 48, y + 22, 21, t.text, { font: 'bold' });
        const cond = st.level === 'off' ? 'not now: ' + (ck.id === 'steer' ? 'needs 30 km/h and steering' : ck.id === 'warm' ? 'needs the engine running' : 'needs load and speed')
            : st.level === 'learning' ? 'learning ' + st.bucket + ' (' + st.n + ' of 60)' : st.bucket;
        cv.text(cond, 48, y + 46, 16, t.dim);
        if (st.level === 'ok' || st.level === 'odd') {
            cv.text(val(ck.y, st.actual), 610, y + 22, 21, lvColor(t, st.level), { align: 'right', font: 'bold' });
            cv.text('usual ' + val(ck.y, st.expected), 610, y + 46, 16, t.dim, { align: 'right' });
        }
        zBar(cv, t, 640, y + 20, 360, 12, st.level === 'ok' || st.level === 'odd' ? st.z : null, st.level);
    });

    const q = G.panel(cv, t, 1040, 160, 536, 352, 'Anomalies found (' + s.items.length + ')');
    G.button(cv, t, q.x + q.w - 20 - 150, 172, 150, 40, 'Freeze', s.act.freeze, { key: 'freeze' });
    if (!s.items.length) {
        para(cv, t, 'Nothing has left its usual line yet. Each check first learns this car (about a minute of each gear or rev band), then a moment far off the line shows up here with its 30 s. Freeze keeps the last 30 s any time you noticed something.', 1064, 250, 19, 488);
        return;
    }
    s.items.slice(0, 6).forEach((it, i) => {
        const y = 226 + i * 47;
        if (i === s.sel) cv.roundRect(1052, y, 512, 43, 8, withAlpha(t.accent, 0.16));
        cv.text(clock(it.t), 1064, y + 28, 18, t.dim);
        cv.text(it.name, 1160, y + 20, 18, it.check === 'freeze' ? t.accent : t.text, { font: 'bold' });
        cv.text(it.bucket, 1160, y + 39, 14, t.dim);
        const n = s.e.caught.filter((c) => c.check === it.check && c.bucket === it.bucket).length;
        if (it.check !== 'freeze') G.pill(cv, t, 1452, y + 9, 100, 26, n >= 3 ? 'REPEATS' : 'ONCE', { color: n >= 3 ? t.crit : t.warn, size: 13 });
    });
}

/* ---------------- Timeline ---------------- */
const LANES = ['torque', 'boost', 'steer', 'gear', 'gLong', 'speed', 'rpm', 'gLat'];
function timeline(cv, t, s) {
    const it = s.items[s.sel];
    if (!it) {
        G.panel(cv, t, 24, 44, 1552, 468, 'Timeline');
        para(cv, t, 'No anomaly yet. When one is found (or you press Freeze), this page shows its 30 seconds: a lane per value, what the driver and the engine asked for on top, what came of it below, and in what order things went off.', 48, 130, 22, 1100);
        return;
    }
    const p = G.panel(cv, t, 24, 44, 1100, 468, it.name + ', ' + it.bucket + ', ' + clock(it.t));
    const x0 = 196, x1 = 1104, tMin = -25000, tMax = 5000, X = (ms) => x0 + (ms - tMin) / (tMax - tMin) * (x1 - x0);
    const top = 122, laneH = 42;
    const movers = it.movers || [], order = movers.filter((m) => m.at !== null);
    LANES.forEach((id, i) => {
        const y = top + i * laneH + (i >= 4 ? 16 : 0), pts = (it.data && it.data[id]) || [];
        if (i === 4) { cv.fillRect(48, y - 6, 1056, 1, withAlpha(t.tick, 0.5)); cv.text('RESULTS (WHAT CAME OF IT)', x0, y + 8, 12, t.dim, { font: 'bold', spacing: 2 }); }
        if (i === 0) cv.text('CAUSES (WHAT WAS ASKED FOR)', x0, y - 4, 12, t.dim, { font: 'bold', spacing: 2 });
        cv.text(CH[id].name, 48, y + 26, 17, t.text);
        cv.fillRect(x0, y + laneH - 6, x1 - x0, 1, withAlpha(t.tick, 0.25));
        if (pts.length > 1) {
            let lo = Infinity, hi = -Infinity;
            pts.forEach((q) => { lo = Math.min(lo, q[1]); hi = Math.max(hi, q[1]); });
            if (hi - lo < (CH[id].minSpread || 1)) { const m = (hi + lo) / 2; lo = m - CH[id].minSpread; hi = m + CH[id].minSpread; }
            const Y = (v) => y + laneH - 8 - (v - lo) / (hi - lo) * (laneH - 14);
            cv.polyline(pts.filter((q) => q[0] >= tMin && q[0] <= tMax).map((q) => [X(q[0]), Y(q[1])]), 2, i < 4 ? t.accent : GO);
            cv.text(val(id, pts[pts.length - 1][1]), 190, y + 26, 13, t.dim, { align: 'right' });
        } else cv.text('no data', x0 + 8, y + 26, 15, t.dim);
        // where this lane went off: its own move (a ring) or its check's line (a filled dot, numbered by order)
        movers.filter((m) => m.at !== null && m.channel === id).forEach((m) => {
            const n = order.indexOf(m) + 1, mx = X(m.at), my = y + laneH / 2 - 2;
            if (m.kind === 'check') { cv.circle(mx, my, 12, t.crit); cv.text(String(n), mx, my + 6, 15, '#ffffff', { align: 'center', font: 'bold' }); }
            else { cv.arc(mx, my, 9, 12, 0, 360, t.warn); cv.text(String(n), mx + 18, my + 6, 14, t.warn, { font: 'bold' }); }
        });
    });
    const zx = X(0);
    cv.fillRect(zx - 1, top, 3, 8 * laneH + 16, withAlpha(t.crit, 0.7));
    cv.text('FOUND', zx - 6, top + 8 * laneH + 12, 13, t.crit, { align: 'right', font: 'bold', spacing: 1.5 });
    [-25, -20, -15, -10, -5, 0, 5].forEach((sec) => cv.text((sec > 0 ? '+' : '') + sec + ' s', X(sec * 1000), 492, 14, t.dim, { align: 'center' }));

    const q = G.panel(cv, t, 1140, 44, 436, 468, 'What went off first');
    if (!order.length) para(cv, t, 'Nothing stood out before it: a Freeze, or a change too quick to order.', 1164, 120, 19, 390);
    order.slice(0, 7).forEach((m, i) => {
        const y = 102 + i * 46, ck = m.kind === 'check' ? CHECKS.find((c) => c.id === m.id) : null;
        if (m.kind === 'check') { cv.circle(1176, y + 10, 13, t.crit); cv.text(String(i + 1), 1176, y + 16, 15, '#ffffff', { align: 'center', font: 'bold' }); }
        else { cv.arc(1176, y + 10, 10, 13, 0, 360, t.warn); cv.text(String(i + 1), 1176, y + 16, 14, t.warn, { align: 'center', font: 'bold' }); }
        cv.text(ck ? CH[ck.y].name + ' off its line' : CH[m.id].name + ' changed', 1200, y + 10, 18, t.text, { font: 'bold' });
        cv.text((ck ? 'against ' + CH[ck.x === 'turn' ? 'steer' : ck.x].name.toLowerCase() + ', ' : '') + secs(m.at), 1200, y + 30, 15, t.dim);
    });
    const ck = CHECKS.find((c) => c.id === it.check);
    if (ck) para(cv, t, ck.hint, 1164, 438, 14, 392, t.dim, 17);
    cv.text((s.sel + 1) + ' of ' + s.items.length + ': Previous / Next', 1556, 76, 14, t.dim, { align: 'right' });
}

/* ---------------- Compare ---------------- */
function compare(cv, t, s) {
    const e = s.e, now = s.now;
    // the check to show: the one furthest off now, else the first that is judging
    const live = CHECKS.map((c) => ({ c, st: e.A.state(c.id) })).filter((o) => o.st.level === 'ok' || o.st.level === 'odd');
    live.sort((a, b) => Math.abs(b.st.z || 0) - Math.abs(a.st.z || 0));
    // the latest anomaly's check when it is being judged now, else one that is off, else the busiest pair in order
    const prefer = (s.items[0] && live.find((o) => o.c.id === s.items[0].check)) || live.find((o) => Math.abs(o.st.z || 0) >= Z_OK)
        || ['pull', 'boost', 'steer', 'ratio', 'warm'].map((id) => live.find((o) => o.c.id === id)).find(Boolean);
    const pick = prefer ? prefer.c : CHECKS[0];
    const p = G.panel(cv, t, 24, 44, 1000, 320, CH[pick.y].name + ' now, against its usual line');
    const exp = (e.exp[pick.id] || []).filter((q) => q[0] >= now - 30000);
    const act = e.A.series(pick.y, now - 30000, now);
    let lo = Infinity, hi = -Infinity;
    act.forEach((q) => { lo = Math.min(lo, q[1]); hi = Math.max(hi, q[1]); });
    exp.forEach((q) => { lo = Math.min(lo, q[1] - 2 * q[2]); hi = Math.max(hi, q[1] + 2 * q[2]); });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    const pad = (hi - lo) * 0.1 || 1;
    const c = G.chart(cv, t, 40, 104, 968, 236, { xMin: -30, xMax: 0, yMin: lo - pad, yMax: hi + pad, xUnit: 's', yUnit: CH[pick.y].unit,
        yFmt: (v) => v.toFixed(CH[pick.y].d), empty: 'Waiting for ' + pick.name.toLowerCase() + ' to be judged (load, speed, a learned condition)',
        series: [{ pts: exp.map((q) => [(q[0] - now) / 1000, q[1]]), color: withAlpha(t.text, 0.55), width: 2, dash: true },
            { pts: act.map((q) => [(q[0] - now) / 1000, q[1]]), color: t.accent, width: 3 }] });
    // the tolerance band: the usual line +-2 of its spreads
    if (exp.length > 1) {
        const up = exp.map((q) => [c.X((q[0] - now) / 1000), c.Y(q[1] + 2 * q[2])]), dn = exp.map((q) => [c.X((q[0] - now) / 1000), c.Y(q[1] - 2 * q[2])]).reverse();
        cv.clip(c.px, c.py, c.pw, c.ph); cv.fill(up.concat(dn), withAlpha(t.text, 0.08)); cv.noclip();
    }
    cv.text('now', 1004, 82, 16, t.accent, { align: 'right', font: 'bold' });
    cv.text('usual here (same ' + (pick.id === 'warm' ? 'coolant band' : pick.id === 'boost' ? 'rev band' : pick.id === 'steer' ? 'speed band' : 'gear') + ') and its normal band', 960, 82, 16, t.dim, { align: 'right' });

    const m = G.panel(cv, t, 24, 376, 1000, 136, 'Moving most right now');
    const mv = e.A.movers(now, 2000).filter((o) => o.score > 0.05).slice(0, 4);
    if (!mv.length) cv.text('Everything is steady', 48, 450, 20, t.dim);
    mv.forEach((o, i) => {
        const x = 48 + i * 244, w = 220;
        cv.text(CH[o.id].name, x, 450, 18, t.text, { font: 'bold' });
        cv.roundRect(x, 464, w, 10, 5, t.track);
        cv.roundRect(x, 464, Math.max(10, w * G.clamp(o.score / 6, 0, 1)), 10, 5, o.score > 4 ? t.warn : t.accent);
        cv.text((o.delta >= 0 ? 'up ' : 'down ') + val(o.id, Math.abs(o.delta)) + ' in 2 s', x, 496, 15, t.dim);
    });
    void m;

    G.panel(cv, t, 1040, 44, 536, 468, 'Every check, now');
    const rows = CHECKS.map((ck) => {
        const st = e.A.state(ck.id), judged = st.level === 'ok' || st.level === 'odd';
        return [ck.short, judged ? { text: val(ck.y, st.actual) } : { text: '--', color: 'dim' }, judged ? val(ck.y, st.expected) : '--',
            judged ? { text: (st.z >= 0 ? '+' : '') + st.z.toFixed(1), color: st.level === 'odd' ? t.crit : Math.abs(st.z) >= Z_OK ? t.warn : GO } : { text: (LEVEL[st.level] || LEVEL.off)[0].toLowerCase(), color: 'dim' }];
    });
    G.table(cv, t, 1064, 104, 488, [{ label: 'Check', w: 120 }, { label: 'Now', w: 130, align: 'right' }, { label: 'Usual', w: 130, align: 'right' }, { label: 'Off by', w: 108, align: 'right' }], rows, { rowH: 36, size: 19 });
    cv.text('Off by: in spreads of what is normal here', 1064, 340, 14, t.dim);
    cv.fillRect(1064, 352, 488, 1, withAlpha(t.tick, 0.4));
    cv.text('DRIFT FROM HEALTHY', 1064, 378, 15, t.dim, { font: 'bold', spacing: 2 });
    if (!e.healthy) {
        para(cv, t, 'Save as healthy when the car runs well: from then on this shows how far each check slowly moves away from it.', 1064, 404, 16, 488);
        G.button(cv, t, 1352, 360, 200, 36, 'Save as healthy', s.act.healthy, { key: 'healthy' });
        return;
    }
    cv.text('saved ' + day(e.healthyAt), 1552, 378, 14, t.dim, { align: 'right' });
    const dr = e.drift();
    if (!dr.length) cv.text('Not enough learned in the same conditions yet', 1064, 412, 16, t.dim);
    dr.slice(0, 4).forEach((d, i) => {
        const y = 396 + i * 28, ck = CHECKS.find((c) => c.id === d.check), a = Math.abs(d.spreads);
        cv.text(ck.short, 1064, y + 14, 16, t.text);
        cv.roundRect(1180, y + 4, 280, 10, 5, t.track);
        cv.roundRect(1180, y + 4, Math.max(10, 280 * G.clamp(a / 4, 0, 1)), 10, 5, a >= 2 ? t.warn : GO);
        cv.text(a.toFixed(1), 1552, y + 14, 16, a >= 2 ? t.warn : t.dim, { align: 'right' });
    });
}

/* ---------------- Tests ---------------- */
function tests(cv, t, s) {
    const e = s.e, T = e.test, last = e.tests[e.tests.length - 1], set = s.settings;
    const showing = T || last;
    const xId = showing ? showing.x : set.get('testX'), yId = showing ? showing.y : set.get('testY');
    const p = G.panel(cv, t, 24, 44, 1000, 468, T ? 'Test running: ' + CH[yId].name.toLowerCase() + ' by ' + CH[xId].name.toLowerCase() : 'Step / sweep test');
    G.button(cv, t, p.x + p.w - 20 - 170, 56, 170, 40, T ? 'Stop test' : 'Start test', s.act.test, { key: 'test', primary: !!T, color: T ? t.crit : null });
    const lt = e.lastTwo(), prev = lt && !T ? lt.a : null;
    const all = (showing ? showing.points : []).concat(prev ? prev.points : []);
    if (!all.length) {
        para(cv, t, 'A test records one value against another while you drive it: a sweep (a slow full pull from low to high revs) or a step (from steady to full throttle). Choose the input, the response and what to keep steady in Settings, press Start test, drive it, press Stop test. Do it again after a change (a part, a clean, a tune) and the two are compared on the right.', 48, 140, 20, 940);
    } else {
        let xl = Infinity, xh = -Infinity, yl = Infinity, yh = -Infinity;
        all.forEach((q) => { xl = Math.min(xl, q[0]); xh = Math.max(xh, q[0]); yl = Math.min(yl, q[1]); yh = Math.max(yh, q[1]); });
        const yp = (yh - yl) * 0.1 || 1;
        const pts = (o) => o.points.filter((q, i) => i % Math.max(1, Math.floor(o.points.length / 400)) === 0);
        G.chart(cv, t, 40, 120, 968, 300, { xMin: Math.floor(xl), xMax: Math.ceil(xh), yMin: yl - yp, yMax: yh + yp, xUnit: CH[xId].unit, yUnit: CH[yId].unit,
            yFmt: (v) => v.toFixed(CH[yId].d),
            series: [prev && { pts: pts(prev), color: withAlpha(t.text, 0.45), width: 2 }, { pts: pts(showing), color: T ? t.warn : t.accent, width: 3 }].filter(Boolean) });
        cv.text(T ? 'now: ' + showing.points.length + ' points' : 'white: ' + showing.name + (prev ? ', grey: ' + prev.name : ''), 790, 82, 16, t.dim, { align: 'right' });
    }
    // the value held steady
    const hold = T ? T.hold : last && last.hold, hy = 452;
    if (hold) {
        const broke = hold.broke, nowV = T ? e.A.last(hold.id) : null;
        G.pill(cv, t, 48, hy, 220, 34, broke ? 'NOT CLEAN' : 'CLEAN', { color: broke ? t.crit : GO, size: 16 });
        cv.text(broke ? CH[hold.id].name + ' moved to ' + val(hold.id, broke.value) + ' (more than ' + hold.band + ' from ' + val(hold.id, hold.start) + '): redo it'
            : CH[hold.id].name + ' kept within ' + hold.band + ' of ' + val(hold.id, hold.start) + (isNum(nowV) ? ', now ' + val(hold.id, nowV) : ''), 288, hy + 24, 17, broke ? t.crit : t.dim);
    } else cv.text('Nothing held steady (Settings > Test: keep this steady)', 48, hy + 24, 17, t.dim);

    const q = G.panel(cv, t, 1040, 44, 536, 468, 'Before and after');
    if (!lt) { para(cv, t, 'Two tests with the same input and response are compared here: where the second is better, the same or worse.', 1064, 124, 19, 488); return; }
    const V = { better: GO, worse: t.crit, same: t.dim };
    cv.text(lt.b.name + ' against ' + lt.a.name, 1552, 82, 17, t.dim, { align: 'right' });
    cv.text(lt.cmp.verdict.toUpperCase(), 1064, 152, 46, V[lt.cmp.verdict] || t.text, { font: 'bold' });
    cv.text(lt.cmp.better + ' better, ' + lt.cmp.same + ' same, ' + lt.cmp.worse + ' worse', 1552, 152, 17, t.dim, { align: 'right' });
    const rows = lt.cmp.rows, mid = 1320, half = 150;
    const maxD = Math.max.apply(null, rows.map((r) => (isNum(r.delta) ? Math.abs(r.delta) : 0)).concat([1e-6]));
    rows.forEach((r, i) => {
        const y = 180 + i * 34;
        cv.text(r.x.toFixed(0) + ' ' + CH[lt.b.x].unit, 1064, y + 20, 15, t.dim);
        if (isNum(r.spread)) cv.fillRect(mid - half * r.spread / maxD, y + 6, 2 * half * r.spread / maxD, 18, withAlpha(t.text, 0.08));
        if (isNum(r.delta)) {
            const w = half * Math.abs(r.delta) / maxD;
            cv.roundRect(r.delta >= 0 ? mid : mid - w, y + 9, Math.max(3, w), 12, 4, V[r.verdict] || t.dim);
        }
        cv.text(isNum(r.delta) ? (r.delta >= 0 ? '+' : '') + r.delta.toFixed(CH[lt.b.y].d) : '--', 1552, y + 20, 15, V[r.verdict] || t.dim, { align: 'right' });
    });
    cv.fillRect(mid, 178, 1, rows.length * 34, withAlpha(t.text, 0.5));
    para(cv, t, 'Grey band: how much the car varies by itself there. A change inside it counts as the same.', 1064, 470, 14, 488, t.dim, 17);
    void q;
}

/* ---------------- Mechanic ---------------- */
function mechanic(cv, t, s) {
    const e = s.e, f = e.findings();
    G.panel(cv, t, 24, 44, 1060, 468, 'For the workshop');
    if (!f.length) para(cv, t, 'Nothing out of the ordinary found so far. Drive normally; anything that leaves its usual line shows up here in plain words.', 48, 130, 24, 1000, t.text);
    let y = 104;
    f.slice(0, 5).forEach((x, i) => {
        const col = x.level === 'crit' ? t.crit : x.level === 'warn' ? t.warn : GO;
        cv.roundRect(48, y + 2, 8, 30, 3, col);
        const h = para(cv, t, x.text, 72, y + 24, 24, 990, t.text, 30, { font: 'bold' });
        const ck = CHECKS.find((c) => c.id === x.check);
        let h2 = 0;
        if (ck && i < 2) h2 = para(cv, t, 'Worth checking: ' + ck.check.join('; ') + '.', 72, y + 24 + h, 17, 990, t.dim, 22);
        y += h + h2 + 14;
    });
    cv.text('Estimates from the car\'s own signals against how this car usually behaves. Not a diagnosis.', 48, 496, 15, t.dim);

    G.panel(cv, t, 1100, 44, 476, 468, 'Scan with a phone');
    const text = e.findingsText(s.version), bytes = Buffer.from(text, 'utf8');
    let ver = 1;
    while (ver < 30 && qr.capacity(ver, 'L') < bytes.length) ver++;
    const code = qr.encode(bytes.slice(0, qr.capacity(ver, 'L')), { version: ver, ecl: 'L' });
    const box = 360, m = Math.floor(box / (code.size + 4)), side = m * (code.size + 4), ox = 1338 - side / 2, oy = 92;
    cv.fillRect(ox, oy, side, side, '#ffffff');
    for (let yy = 0; yy < code.size; yy++) for (let xx = 0; xx < code.size; xx++) if (code.get(xx, yy)) cv.fillRect(ox + (xx + 2) * m, oy + (yy + 2) * m, m, m, '#000000');
    para(cv, t, 'The findings as plain text: the phone camera reads it, no app needed.', 1124, oy + side + 28, 16, 428, t.dim, 20);
}

/* ---------------- How it works ---------------- */
function help(cv, t) {
    G.panel(cv, t, 24, 44, 1552, 468, 'How Diagnose works');
    [
        ['It learns this car first.', 'Each check is a pair that should move together: torque and forward g in each gear, engine and road speed, torque and boost at each rev band, oil and coolant, steering and sideways g at each speed. It learns the usual line for every condition (about a minute each) and how much the car wanders around it.'],
        ['It flags what leaves the line.', 'A moment far outside the normal wander (4 of its spreads, for 0.4 s) is an anomaly. Its 30 seconds are kept with what went off first and in what order. Seen 3 times in the same condition, it is marked as repeating, not a one-off.'],
        ['It compares like with like.', 'Compare shows now against the same conditions before, a delta of every check and what is moving most. Save as healthy, and slow drift away from that is shown too.'],
        ['It helps with tests and the workshop.', 'Tests records a sweep or a step, warns when the value you hold steady moves, and compares before and after a change. Mechanic sums it up in plain words and as a QR code.'],
        ['It only reads.', 'Nothing is asked of any control unit and nothing is written to one. Boost is in the unit the car\'s sport display sends. These are estimates from the car\'s own signals, not a diagnosis.'],
    ].forEach((r, i) => {
        const y = 124 + i * 76;
        cv.circle(66, y + 4, 20, withAlpha(t.accent, 0.3));
        cv.text(String(i + 1), 66, y + 12, 22, t.text, { align: 'center', font: 'bold' });
        cv.text(r[0], 104, y + 10, 22, t.text, { font: 'bold' });
        para(cv, t, r[1], 104, y + 36, 16, 1440, t.dim, 20);
    });
}

function draw(cv, t, page, s) {
    [anomalies, timeline, compare, tests, mechanic, help][page] && [anomalies, timeline, compare, tests, mechanic, help][page](cv, t, s);
}

module.exports = { draw, wrap, CHANNELS };
