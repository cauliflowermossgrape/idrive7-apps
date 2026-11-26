'use strict';
/**
 * kitpages.js - the pages the kit itself draws for every app (sheets, sheet.js, where the GPU renderer runs the
 * screen; drawn into the page where it doesn't):
 *
 *   safeSheet(o)        safe mode (safeboot.js): what failed, where, the error, a setting it names; Try normal start
 *                       again, Reset settings to defaults (pressed twice), Log as QR.
 *                       o = { title, fails, last: { step, error, at }, setting, tryAgain(), reset(), qr() -> sheet }
 *   historySheet(st)    Settings history: who changed what and when (old -> new), Only my changes, Go back to
 *                       before this (pressed twice; undoable, it is in the history itself)
 *   banner(cv, t, o)    the red "Stopped by Stop all" strip over an app's page; o = { by, resume() }
 */
const { withAlpha } = require('./canvas');
const { list, pill } = require('./sheet');
const G = require('./gauges');

const W = 1600, TOP = 46, BOTTOM = 512, CONFIRM_MS = 5000;
const RED = '#e5332a';
const two = (n) => (n < 10 ? '0' : '') + n;
const when = (ms) => { const d = new Date(ms); return d.getDate() + '.' + two(d.getMonth() + 1) + '. ' + two(d.getHours()) + ':' + two(d.getMinutes()); };
const STEPS = { start: 'while starting', background: 'in its background work', screen: 'drawing its first screen', running: 'soon after starting' };
const WHO = { user: 'You', app: 'The app', rollback: 'Went back', reset: 'Reset to defaults', safe: 'Safe mode reset' };

function wrap(r, s, size, w, max) {
    const words = String(s).split(/\s+/), out = [];
    let line = '';
    words.forEach((wd) => {
        const tryLine = line ? line + ' ' + wd : wd;
        if (r.textWidth(tryLine, size) > w && line) { out.push(line); line = wd; } else line = tryLine;
    });
    if (line) out.push(line);
    if (out.length > max) { out.length = max; out[max - 1] += ' ...'; }
    return out;
}

/* ---------------- safe mode ---------------- */
function safeSheet(o) {
    let armed = 0, note = null;
    const actions = () => [
        { key: 'try', label: 'Try normal start again', primary: true, run: () => { note = 'Starting normally ...'; return o.tryAgain(); } },
        {
            key: 'reset', label: armed && Date.now() - armed < CONFIRM_MS ? 'Press again: reset all settings' : 'Reset settings to defaults', color: RED,
            run: () => {
                if (!armed || Date.now() - armed > CONFIRM_MS) { armed = Date.now(); note = 'Press again within 5 s to reset. Your settings now are kept in Settings history.'; return null; }
                armed = 0;
                const n = o.reset();
                note = 'Settings reset to defaults (' + n + ' changed; the old ones are in Settings history). Now Try normal start again.';
                return null;
            },
        },
        { key: 'qr', label: 'Log as QR', run: () => { const c = o.qr && o.qr(); if (c) sh.child = c; return null; } },
    ];
    const sh = {
        title: 'Safe mode', focus: 0, controller: false, child: null,
        draw(r, t) {
            if (this.child) {
                return (this.child.draw(r, t) || []).map((q) => Object.assign({}, q, { act: () => Promise.resolve(q.act && q.act()).then((v) => { if (v === 'close') this.child = null; return null; }) }));
            }
            r.clear(t.bg);
            const last = o.last || {};
            // left: what happened
            const x = 40, y = TOP + 8, w = 980, h = BOTTOM - y - 4;
            r.roundRect(x, y, w, h, 18, withAlpha('#ffffff', 0.05));
            r.roundRect(x, y, 8, h, 4, RED);
            r.text('SAFE MODE', x + 40, y + 58, 44, RED, { font: 'bold', spacing: 3 });
            wrap(r, (o.title || 'The app') + ' failed to start ' + (o.fails || 2) + ' times in a row, so it started with the basics only.', 26, w - 80, 2)
                .forEach((l, i) => r.text(l, x + 40, y + 102 + i * 34, 26, t.text));
            const rows = [
                ['WHERE IT FAILED', STEPS[last.step] || last.step || 'not known'],
                ['WHEN', last.at ? when(last.at) : '--'],
                ['A SETTING IT NAMES', o.setting || 'none'],
            ];
            rows.forEach((rw, i) => {
                const tx = x + 40 + i * 310;
                r.text(rw[0], tx, y + 196, 18, t.dim, { font: 'bold', spacing: 1.5 });
                r.text(String(rw[1]), tx, y + 230, 26, i === 2 && o.setting ? t.warn : t.text, { font: 'bold' });
            });
            r.text('THE ERROR', x + 40, y + 284, 18, t.dim, { font: 'bold', spacing: 1.5 });
            wrap(r, last.error || 'none was caught (it stopped or hung)', 22, w - 80, 3).forEach((l, i) => r.text(l, x + 40, y + 316 + i * 30, 22, t.warn));
            r.text('Nothing runs in the background now, and your saved settings are untouched until you choose.', x + 40, y + h - 24, 20, t.dim);
            // right: what to do
            const ax = x + w + 24, aw = W - 40 - ax, targets = [];
            r.text('WHAT YOU CAN DO', ax, y + 30, 18, t.dim, { font: 'bold', spacing: 1.5 });
            actions().forEach((a, i) => {
                const by = y + 52 + i * 86;
                pill(r, t, ax, by, aw, 66, a.label, this.controller ? i === this.focus : !!a.primary, { color: a.color });
                targets.push({ x: ax, y: by, w: aw, h: 66, act: () => a.run() });
            });
            if (note) wrap(r, note, 20, aw, 3).forEach((l, i) => r.text(l, ax, y + 334 + i * 28, 20, t.text));
            return targets;
        },
        move(d) { if (this.child) return this.child.move(d); this.controller = true; this.focus = Math.max(0, Math.min(2, this.focus + d)); },
        press() {
            if (this.child) return Promise.resolve(this.child.press()).then((v) => { if (v === 'close') this.child = null; return null; });
            this.controller = true;
            return actions()[this.focus].run();
        },
        back() {
            if (this.child) return Promise.resolve(this.child.back()).then((v) => { if (v === 'close') this.child = null; return null; });
            return null;        // (safe mode stays until the user chooses)
        },
    };
    return sh;
}

/** The safe page's frame (its tab and the SAFE MODE badge), drawn after safeSheet's draw where it is the app's page. */
function safeFrame(cv, t, title) { G.frame(cv, t, [title || 'Safe mode'], 0, [{ text: 'SAFE MODE', color: RED }]); }

/* ---------------- Settings history ---------------- */
function valueText(settings, key, v) {
    const s = settings.item && settings.item(key);
    if (v === undefined) return '(none)';
    if (!s) return String(v);
    if (s.type === 'choice') { const op = (s.options || []).find((x) => x[0] === v); return op ? op[1] : String(v); }
    if (s.type === 'bool') return v ? 'On' : 'Off';
    if (s.type === 'number' && settings.numberText) return settings.numberText(s, v);
    return String(v);
}
function changeText(settings, c) {
    const s = settings.item && settings.item(c.key);
    return (s ? s.label : c.key) + ': ' + valueText(settings, c.key, c.from) + ' > ' + valueText(settings, c.key, c.to);
}

function historySheet(settings) {
    let mine = false, armed = -1, armedAt = 0, note = null;
    const shown = () => settings.history().map((e, i) => ({ e, i })).filter((x) => !mine || x.e.by === 'user');
    const sh = {
        title: 'Settings history', focus: 0, controller: false,
        rows() {
            const out = [{ label: 'Only my changes', kind: 'toggle', on: mine }];
            shown().forEach((x) => {
                const e = x.e, more = e.changes.length > 1 ? ' (+' + (e.changes.length - 1) + ' more)' : '';
                const live = armed === x.i && Date.now() - armedAt < CONFIRM_MS;
                out.push({ label: when(e.at) + '   ' + (WHO[e.by] || e.by) + ':  ' + changeText(settings, e.changes[0]) + more,
                    value: live ? 'Press again to go back' : 'Go back to before this', color: live ? RED : null });
            });
            return out;
        },
        draw(r, t) {
            r.clear(t.bg);
            const rows = this.rows();
            this.focus = Math.min(this.focus, rows.length - 1);
            r.text(note || (rows.length > 1 ? 'The last ' + (rows.length - 1) + ' changes, newest first. Going back is kept here too, so it can be undone.'
                : 'No changes yet. Every change to a setting is kept here, with what it was before.'), 44, TOP + 38, 22, note ? t.warn : t.dim);
            const targets = [];
            const bw = 150, bx = W - 40 - bw, by = TOP + 8;
            pill(r, t, bx, by, bw, 46, 'Done', this.controller && this.focus === -1);
            targets.push({ x: bx - 10, y: by - 6, w: bw + 20, h: 58, act: () => 'close' });
            list(r, t, 'kit-history', rows, this.focus, TOP + 74, this.controller)
                .forEach((q) => targets.push(Object.assign(q, { act: () => { this.focus = q.i; return this.choose(); } })));
            return targets;
        },
        choose() {
            if (this.focus === 0) { mine = !mine; armed = -1; return null; }
            const x = shown()[this.focus - 1];
            if (!x) return null;
            if (armed !== x.i || Date.now() - armedAt > CONFIRM_MS) { armed = x.i; armedAt = Date.now(); note = null; return null; }
            armed = -1;
            const n = settings.restore(x.i).length;
            note = n ? 'Back to how it was before that change (' + n + ' setting' + (n === 1 ? '' : 's') + '). This is at the top now, so it can be undone.' : 'Nothing to change: the settings are already like that.';
            this.focus = 1;
            return null;
        },
        move(d) { this.controller = true; this.focus = Math.max(-1, Math.min(this.rows().length - 1, this.focus + d)); },
        press() { this.controller = true; return this.focus === -1 ? 'close' : this.choose(); },
        back() { return 'close'; },
        top() { return this.focus === -1; },
        scroll(dy) { const st = list.scroll['kit-history']; if (st) { st.y += dy; st.drag = true; } },
        release() { const st = list.scroll['kit-history']; if (st) st.drag = false; },
    };
    return sh;
}

/* ---------------- Stop all banner ---------------- */
function banner(cv, t, o) {
    const x = 24, y = 50, w = W - 48, h = 56;
    cv.roundRect(x, y, w, h, 12, withAlpha(RED, 0.94));
    cv.text('STOPPED BY STOP ALL' + (o && o.by ? '  (from ' + o.by + ')' : ''), x + 24, y + 36, 24, '#ffffff', { font: 'bold', spacing: 2 });
    cv.text('Nothing is sent to the car.  Tap here to resume', x + w - 24, y + 36, 22, '#ffffff', { align: 'right' });
    if (o && o.resume && cv.target) cv.target(x, y, w, h, () => o.resume(), 'kit-panic-resume', 12);
}

/**
 * The kit's own settings rows, for mgu.js and the emulator alike: Stop all (red, pressed twice) at the top, Settings
 * history at the bottom. o = { panic (panic.js Panic), saved: () => the Settings whose history is shown }.
 * Returns { first: () => [stop row], rows: () => [history row] } (ctx.kitFirstRows / ctx.kitRows).
 */
function kitRows(o) {
    let stopArmed = 0;
    const panic = o.panic;
    const stopRow = {
        label: 'Stop all', color: RED,
        value: () => (panic.on ? 'On (from ' + panic.by + '): press to resume' : Date.now() - stopArmed < 5000 ? 'Press again to stop every app' : 'Stops every app\'s work on the car'),
        open: () => {
            if (panic.on) { panic.set(false); return null; }
            if (Date.now() - stopArmed > 5000) { stopArmed = Date.now(); return null; }
            stopArmed = 0;
            panic.set(true);
            return null;
        },
    };
    const historyRow = { label: 'Settings history', value: () => o.saved().history().length + ' changes kept', open: () => historySheet(o.saved()) };
    return { first: () => [stopRow], rows: () => [historyRow] };
}

module.exports = { safeSheet, safeFrame, historySheet, banner, valueText, changeText, kitRows };
