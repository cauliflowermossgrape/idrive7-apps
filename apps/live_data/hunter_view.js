'use strict';
/**
 * hunter_view.js - the Signal Hunter tab's pages (Settings > Advanced > Signal Hunter tab), drawn from what
 * hunter_tab.js hands over (s). Where the kit runs the screen (s.own) the bottom line of each page is left free for
 * its buttons, so the lists there are a row shorter and the hints go:
 *
 *   What changed   since "Mark before": each member that moved, before -> now, how often, a trace for numbers
 *   Live           what is moving right now (rows light up as they change), the busiest interfaces, changes a second
 *   Found          what you labelled (door, window, climate ...), counted by label
 *   Playback       a saved window stepped through change by change: the timeline, the step, the state at that moment
 *   How it works   in plain words, and what it can and cannot see
 *
 *   draw(cv, t, page, s)
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { shortName, stateAtStep } = require('./hunter');

const GO = '#2fd27a', BLUE = '#5aa9ff', VIOLET = '#c77dff', PINK = '#ff7aa2', TEAL = '#7ee0d0';
const LABELS = ['door', 'window', 'climate', 'wiper', 'light', 'button', 'mode', 'other'];
const isNum = (x) => typeof x === 'number' && isFinite(x);
const two = (n) => (n < 10 ? '0' : '') + n;
const clock = (ms) => { const d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()); };
const ago = (ms) => (ms < 1000 ? 'now' : ms < 60000 ? Math.round(ms / 1000) + ' s ago' : Math.round(ms / 60000) + ' min ago');

function val(v) {
    if (v === null || v === undefined) return '-';
    if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    return String(v);
}
/** s cut to w px at size, with ".." at the end when cut. */
function fit(cv, s, size, w, opt) {
    s = String(s);
    if (cv.textWidth(s, size, opt) <= w) return s;
    let n = s.length;
    while (n > 1 && cv.textWidth(s.slice(0, n) + '..', size, opt) > w) n--;
    return s.slice(0, n) + '..';
}
/** A long member name kept readable: the start of it (the interface) and its end (the member) with ".." between. */
function fitName(cv, s, size, w, opt) {
    s = String(s);
    if (cv.textWidth(s, size, opt) <= w) return s;
    let a = Math.ceil(s.length / 2), b = Math.floor(s.length / 2);
    while (a + b > 4 && cv.textWidth(s.slice(0, a) + '..' + s.slice(s.length - b), size, opt) > w) { if (a > b) a--; else b--; }
    return s.slice(0, a) + '..' + s.slice(s.length - b);
}
function ifaceColor(t, key) {
    const i = key.split('|')[0];
    let h = 0;
    for (let k = 0; k < i.length; k++) h = (h * 31 + i.charCodeAt(k)) >>> 0;
    return [t.accent, GO, t.warn, BLUE, VIOLET, PINK, TEAL][h % 7];
}
function spark(cv, x, y, w, h, hist, c) {
    const pts = (hist || []).filter(isNum);
    if (pts.length < 2) return false;
    let lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts);
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const p = pts.map((v, i) => [x + (i / (pts.length - 1)) * w, y + h - ((v - lo) / (hi - lo)) * h]);
    cv.fillUnder(p, y + h, withAlpha(c, 0.15));
    cv.polyline(p, 2, c);
    return true;
}
/** Changes a second as bars, the newest on the right. */
function rate(cv, t, x, y, w, h, per) {
    const max = Math.max(4, Math.max.apply(null, per)), bw = w / per.length;
    cv.fillRect(x, y + h, w, 1, withAlpha(t.tick, 0.6));
    per.forEach((n, i) => { if (n) cv.fillRect(x + i * bw + 1, y + h - (n / max) * h, Math.max(1, bw - 2), (n / max) * h, withAlpha(t.accent, 0.35 + 0.65 * (i / per.length))); });
    cv.text(String(max), x - 6, y + 12, 14, t.dim, { align: 'right' });
    cv.text('0', x - 6, y + h, 14, t.dim, { align: 'right' });
}

/* ---------- What changed ---------- */
function changedPage(cv, t, s) {
    const H = s.hunter, list = s.changed, now = s.now;
    const top = G.panel(cv, t, 24, 44, 1552, 104, null);
    if (!H.markAt) {
        cv.text('Press Mark before, then do one thing in the car', 48, 88, 28, t.text, { font: 'bold' });
        cv.text('(open a door, switch the A/C, press a button): what it changed shows here.', 48, 124, 20, t.dim);
    } else {
        cv.text(list.length + (list.length === 1 ? ' value moved' : ' values moved'), 48, 92, 34, list.length ? t.text : t.dim, { font: 'bold' });
        cv.text('since Mark before at ' + clock(H.markAt) + ' (' + ago(now - H.markAt) + ')', 48, 126, 20, t.dim);
    }
    // the right side: what it listens to, and the changes a second
    const learn = H.learning();
    cv.text(H.size() + ' values on ' + H.ifaceCount() + ' interfaces' + (s.noisyHidden ? ', ' + H.noisyCount() + ' noisy hidden' : ''), 1080, 76, 18, t.dim, { align: 'right' });
    if (learn) G.pill(cv, t, 780, 92, 300, 32, 'LEARNING THE NOISE', { color: t.warn, size: 16 });
    rate(cv, t, 1120, 62, 432, 64, H.perSecond(60));
    cv.text('changes a second, last minute', 1552, 142, 14, t.dim, { align: 'right' });

    const p = G.panel(cv, t, 24, 162, 1552, 350, H.markAt ? 'Before and now' : 'Changed since the app started');
    const cols = [['VALUE', 48], ['BEFORE', 690], ['NOW', 900], ['TIMES', 1110], ['TRACE', 1200], ['LAST', 1552]];
    cols.forEach((c) => cv.text(c[0], c[1], 226, 14, t.dim, { font: 'bold', spacing: 1.5, align: c[0] === 'LAST' ? 'right' : 'left' }));
    if (!list.length) {
        cv.text(H.markAt ? 'Nothing has changed yet. Do it now: open a door, press a button.' : 'Waiting for the car to send something.', 48, 290, 22, t.dim);
        return;
    }
    const per = s.own ? 5 : 6, sel = Math.min(s.sel, list.length - 1), first = Math.max(0, Math.min(sel - 2, list.length - per));
    list.slice(first, first + per).forEach((r, k) => {
        const i = first + k, y = 236 + k * 41, on = i === sel, fresh = now - r.t < 1500;
        if (on) { cv.roundRect(36, y, 1528, 37, 8, withAlpha(t.accent, 0.18)); cv.roundRect(36, y, 5, 37, 2, t.accent); }
        else if (fresh) cv.roundRect(36, y, 1528, 37, 8, withAlpha(GO, 0.12 * (1 - (now - r.t) / 1500)));
        const c = ifaceColor(t, r.key);
        cv.circle(54, y + 18, 6, c);
        const lab = s.found[r.key];
        const nameW = lab ? 500 : 610;
        cv.text(fitName(cv, r.name, 19, nameW), 70, y + 25, 19, t.text);
        if (lab) G.pill(cv, t, 580, y + 6, 96, 24, lab.label.toUpperCase(), { color: GO, size: 13, spacing: 1 });
        cv.text(fit(cv, val(r.old), 19, 196), 690, y + 25, 19, t.dim);
        cv.text(fit(cv, val(r.val) + (r.back ? '  (back)' : ''), 19, 196), 900, y + 25, 19, r.back ? t.dim : t.text, { font: 'bold' });
        cv.text(String(r.n), 1110, y + 25, 19, r.n > 10 ? t.warn : t.text);
        spark(cv, 1200, y + 7, 200, 22, r.hist, c);
        cv.text(ago(now - r.t), 1552, y + 25, 17, fresh ? GO : t.dim, { align: 'right' });
    });
    if (!s.own) cv.text((sel + 1) + ' of ' + list.length + '. Previous / Next picks a row, Label it names it as "' + s.label + '" (Settings > Signal Hunter: label).', 48, 500, 16, t.dim);
}

/* ---------- Live ---------- */
function livePage(cv, t, s) {
    const H = s.hunter, now = s.now, rows = H.recent(8000, { noisy: !s.noisyHidden }).slice(0, s.own ? 7 : 8);
    G.panel(cv, t, 24, 44, 904, 468, 'Moving right now');
    cv.text('the last 8 s, newest on top; a row lights up as it changes', 48, 112, 17, t.dim);
    if (!rows.length) cv.text(H.size() ? 'All quiet. Do something in the car.' : 'Waiting for the car to send something.', 48, 170, 22, t.dim);
    rows.forEach((r, k) => {
        const y = 128 + k * 46, age = now - r.t, glow = Math.max(0, 1 - age / 1200), c = ifaceColor(t, r.key);
        cv.roundRect(36, y, 880, 42, 8, withAlpha(c, 0.06 + 0.3 * glow));
        cv.roundRect(36, y, 5, 42, 2, c);
        cv.text(fitName(cv, r.name, 19, 470), 54, y + 28, 19, t.text);
        cv.text(fit(cv, val(r.old), 17, 130), 540, y + 28, 17, t.dim);
        cv.text('>', 680, y + 28, 17, t.dim);
        cv.text(fit(cv, val(r.val), 19, 140), 700, y + 28, 19, glow > 0.3 ? GO : t.text, { font: 'bold' });
        cv.text(ago(age), 904, y + 28, 16, t.dim, { align: 'right' });
    });
    G.panel(cv, t, 944, 44, 632, 232, 'Busiest, last 30 s');
    const busy = H.busiest(30000, 5), bmax = busy.length ? busy[0][1] : 1;
    if (!busy.length) cv.text('No changes in the last 30 s', 968, 140, 20, t.dim);
    busy.forEach((b, k) => {
        const y = 102 + k * 34, name = b[0].split('.').pop(), c = ifaceColor(t, b[0] + '|');
        cv.text(fit(cv, name, 17, 220), 968, y + 18, 17, t.text);
        cv.roundRect(1196, y + 4, 300 * (b[1] / bmax), 18, 5, c);
        cv.text(String(b[1]), 1556, y + 18, 17, t.text, { align: 'right' });
    });
    G.panel(cv, t, 944, 292, 632, 220, 'Changes a second');
    const per = H.perSecond(60), tot = per.reduce((a, b) => a + b, 0);
    rate(cv, t, 1000, 350, 552, 110, per);
    cv.text('60 s ago', 1000, 482, 14, t.dim);
    cv.text('now', 1552, 482, 14, t.dim, { align: 'right' });
    cv.text(tot + ' in the last minute' + (s.noisyHidden ? ', noise counted too' : ''), 968, 502, 15, t.dim);
}

/* ---------- Found ---------- */
function foundPage(cv, t, s) {
    const items = Object.keys(s.found).map((k) => Object.assign({ key: k }, s.found[k])).sort((a, b) => b.at - a.at);
    G.panel(cv, t, 24, 44, 560, 468, 'Found so far (' + items.length + ')');
    const by = {};
    items.forEach((x) => { by[x.label] = (by[x.label] || 0) + 1; });
    const max = Math.max(1, Math.max.apply(null, LABELS.map((l) => by[l] || 0)));
    LABELS.forEach((l, k) => {
        const y = 104 + k * 44, n = by[l] || 0;
        cv.text(l, 48, y + 22, 20, n ? t.text : t.dim, { font: n ? 'bold' : 'label' });
        cv.roundRect(170, y + 8, 340, 18, 6, t.track);
        if (n) cv.roundRect(170, y + 8, Math.max(18, 340 * n / max), 18, 6, l === s.label ? t.accent : GO);
        cv.text(String(n), 560, y + 22, 20, t.text, { align: 'right' });
    });
    if (!s.own) cv.text('the label Label it uses now: ' + s.label, 48, 500, 16, t.dim);
    G.panel(cv, t, 600, 44, 976, 468, 'Your labels');
    if (!items.length) {
        ['Nothing labelled yet.', '', 'On What changed, pick the row that moved when you did', 'something, choose its label in Settings (Signal Hunter: label),', 'press Label it. It is kept here and written to the app\'s', 'log, so Settings > QR log carries your list too.']
            .forEach((x, i) => cv.text(x, 624, 120 + i * 32, 21, i ? t.dim : t.text, { font: i ? 'label' : 'bold' }));
        return;
    }
    const sel = Math.min(s.fsel, items.length - 1), per = s.own ? 7 : 8, first = Math.max(0, Math.min(sel - 3, items.length - per));
    items.slice(first, first + per).forEach((x, k) => {
        const i = first + k, y = 96 + k * 50;
        if (i === sel) cv.roundRect(612, y, 952, 44, 8, withAlpha(t.accent, 0.18));
        G.pill(cv, t, 624, y + 10, 104, 26, x.label.toUpperCase(), { color: GO, size: 14, spacing: 1 });
        cv.text(fitName(cv, shortName(x.key), 19, 520), 744, y + 30, 19, t.text);
        cv.text(fit(cv, val(x.old) + ' > ' + val(x.val), 17, 190), 1290, y + 30, 17, t.dim);
        cv.text(clock(x.at), 1552, y + 30, 16, t.dim, { align: 'right' });
    });
}

/* ---------- Playback ---------- */
function playbackPage(cv, t, s) {
    const wl = s.windows, now = s.now;
    G.panel(cv, t, 24, 44, 420, 468, 'Saved windows (' + wl.length + ')');
    if (!wl.length) {
        ['None yet.', '', 'Press Save window right after', 'something happens: it keeps', s.before + ' s before and ' + s.after + ' s after', '(Settings: window length).']
            .forEach((x, i) => cv.text(x, 48, 120 + i * 32, 21, i ? t.dim : t.text, { font: i ? 'label' : 'bold' }));
    }
    wl.slice(0, 8).forEach((e, k) => {
        const y = 96 + k * 50, on = k === s.wsel;
        if (on) { cv.roundRect(36, y, 396, 44, 8, withAlpha(t.accent, 0.2)); cv.roundRect(36, y, 5, 44, 2, t.accent); }
        cv.text(clock(e.at), 52, y + 30, 20, t.text, { font: on ? 'bold' : 'label' });
        cv.text(Math.round((e.to - e.from) / 1000) + ' s', 210, y + 30, 18, t.dim);
        cv.text(e.n + ' changes', 420, y + 30, 18, e.error ? t.crit : t.dim, { align: 'right' });
    });
    if (s.pending) cv.text('Saving: ' + Math.ceil(s.pending / 1000) + ' s more', 48, 500, 17, t.warn, { font: 'bold' });
    else if (wl.length > 1 && !s.own) cv.text('Next window picks another', 48, 500, 16, t.dim);

    const w = s.win, e = wl[s.wsel];
    const p = G.panel(cv, t, 460, 44, 1116, 468, e ? 'Window from ' + clock(e.at) : 'Playback');
    if (!w) { cv.text(e ? 'This window could not be read.' : 'A saved window plays here, change by change.', 484, 130, 21, t.dim); return; }
    const n = w.changes.length, step = Math.min(s.step, n), span = Math.max(1, w.to - w.from), mark = e.at;
    const X = (tt) => 484 + ((tt - w.from) / span) * 1068;
    // the timeline: a tick per change in its interface's colour, the moment it was saved for, the cursor
    cv.roundRect(484, 100, 1068, 40, 8, withAlpha('#ffffff', 0.05));
    w.changes.forEach((c, i) => cv.fillRect(Math.round(X(c[0])), 104, 2, 32, withAlpha(ifaceColor(t, c[1]), i < step ? 1 : 0.35)));
    if (mark >= w.from && mark <= w.to) { cv.fillRect(Math.round(X(mark)) - 1, 94, 3, 52, t.crit); cv.text('SAVED HERE', X(mark) + 6, 158, 13, t.crit, { font: 'bold', spacing: 1 }); }
    const cur = s.cursor;
    cv.fillRect(Math.round(X(cur)) - 1, 90, 3, 60, t.text);
    cv.text((cur - mark >= 0 ? '+' : '') + ((cur - mark) / 1000).toFixed(1) + ' s', 484, 178, 26, t.text, { font: 'num' });
    G.pill(cv, t, 640, 154, 190, 30, s.playing ? 'PLAYING ' + s.speed + 'x' : 'PAUSED', { color: s.playing ? GO : t.dim, size: 15 });
    cv.text('step ' + step + ' of ' + n, 1552, 178, 20, t.dim, { align: 'right' });
    // the steps around the current one
    cv.text('CHANGES', 484, 214, 14, t.dim, { font: 'bold', spacing: 1.5 });
    const from = Math.max(0, Math.min(step - 3, n - 5));
    w.changes.slice(from, from + 5).forEach((c, k) => {
        const i = from + k, y = 222 + k * 36, on = i === step - 1;
        if (on) cv.roundRect(476, y, 560, 32, 6, withAlpha(t.accent, 0.22));
        cv.circle(492, y + 16, 5, ifaceColor(t, c[1]));
        cv.text(fitName(cv, shortName(c[1]), 16, 300), 506, y + 22, 16, i < step ? t.text : t.dim);
        cv.text(fit(cv, val(c[2]) + ' > ' + val(c[3]), 16, 170), 820, y + 22, 16, i < step ? t.text : t.dim);
        cv.text(((c[0] - mark) / 1000).toFixed(1), 1028, y + 22, 15, t.dim, { align: 'right' });
    });
    // the state then: the members that move in this window, as they were at this step
    cv.text('AT THIS MOMENT', 1060, 214, 14, t.dim, { font: 'bold', spacing: 1.5 });
    const st = stateAtStep(w, step), moving = [];
    w.changes.forEach((c) => { if (moving.indexOf(c[1]) < 0) moving.push(c[1]); });
    moving.slice(0, 7).forEach((k, i) => {
        const y = 222 + i * 36;
        cv.text(fitName(cv, shortName(k), 15, 300), 1060, y + 22, 15, t.dim);
        cv.text(fit(cv, val(st[k]), 16, 150), 1552, y + 22, 16, t.text, { align: 'right', font: 'bold' });
    });
    if (!s.own) cv.text('Previous / Next: one change. Play: at ' + s.speed + 'x (Settings > Signal Hunter: play speed). White line: where the playback is; red: the moment you saved.', p.x + 24, 500, 15, t.dim);
}

/* ---------- How it works ---------- */
function helpPage(cv, t, s) {
    G.panel(cv, t, 24, 44, 1552, 468, 'How the Signal Hunter tab works');
    [
        ['1', 'It listens to what the car already sends the head unit.', 'The ' + s.fields + ' status fields the apps here read, on ' + s.ifaces + ' interfaces, split into single values. Not raw CAN: the head unit never shows apps that.'],
        ['2', 'Mark before, do one thing, read what changed.', 'Open a door, switch the A/C, press a button: What changed lists every value that moved since, before and now.'],
        ['3', 'Noise is learned and hidden.', 'Values that change 3 times in the first 10 quiet seconds, and counters, checksums and clocks by name, are left out (Settings > Signal Hunter: show noisy values).'],
        ['4', 'Label what you found, save a window to replay it.', 'Label it keeps a name for a value (and writes it to the log for the QR log). Save window keeps the moment, ' + s.before + ' s before and ' + s.after + ' s after, to step through on Playback.'],
    ].forEach((r, i) => {
        const y = 128 + i * 86;
        cv.circle(66, y - 8, 20, withAlpha(t.accent, 0.3));
        cv.text(r[0], 66, y, 22, t.text, { align: 'center', font: 'bold' });
        cv.text(r[1], 104, y, 23, t.text, { font: 'bold' });
        cv.text(r[2], 104, y + 30, 18, t.dim);
    });
    cv.text('It only reads. Nothing is sent to the car, no control unit is asked anything, nothing is set.', 48, s.own ? 448 : 496, 18, GO);
}

function draw(cv, t, page, s) {
    if (page === 1) livePage(cv, t, s);
    else if (page === 2) foundPage(cv, t, s);
    else if (page === 3) playbackPage(cv, t, s);
    else if (page === 4) helpPage(cv, t, s);
    else changedPage(cv, t, s);
}

module.exports = { draw, LABELS, val, fitName };
