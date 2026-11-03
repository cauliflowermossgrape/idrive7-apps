// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
// AA Cluster Companion: the iDrive app that sets the Android Auto cluster map (density, turn card) through aa-on-cluster.
'use strict';
/**
 * AA Cluster Companion - the Android Auto map on the instrument cluster (aa-on-cluster): how much map it shows
 * (the density the phone is told: presets 180, 200, 240 dpi, or Custom 150-300 in steps of 10) and
 * whether the phone's turn card shows.
 *
 *   Flow   : picking a zoom tile or a turn-card option only selects it. A selection that differs
 *            from what the tool has saved shows "Apply changes"; applying saves it in the tool
 *            (aapd.conf edited for the next start). While what is saved differs from what the
 *            cluster runs, "Restart head unit to apply changes" asks the tool for the head unit's
 *            normal restart (the Node State Manager's, as the Store's, within its limits).
 *   Source : aa-on-cluster's control socket (ctl.js). Without it (the tool not installed) the same
 *            screen on a demo state, saying what to install.
 *   Screen : no button bar; the tiles and buttons are tapped (or picked with the controller) where
 *            the kit runs the screen. The HMI buttons below stay for the software fallback.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { Ctl } = require('./ctl');

const W = 1600, H = 520;
const GO = '#2fd27a';
const ROUTE = '#4aa3ff';
const PRESETS = [180, 200, 240];
const NAMES = { 180: 'More map', 200: 'Medium', 240: 'Larger text' };
const CUSTOM = { min: 150, max: 300, step: 10, start: 220 };     // the Custom tile's slider (the tool takes 150-400)
const SLOT_DPI = 235;                                            // the map slot's own density for 1280 pixels
// what a density gives against the slot's own size
function note(d) {
    const p = Math.round((SLOT_DPI / d - 1) * 100);
    return Math.abs(p) <= 3 ? "the slot's own size" : p > 0 ? 'about ' + p + '% more map' : 'about ' + -p + '% larger text';
}
const CARDS = [['shown', 'Shown'], ['hidden', 'Hidden']];
const cardTxt = (c) => (c === 'hidden' ? 'card hidden' : 'card shown');

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        const ctl = new Ctl(() => false);
        let st = null;          // the tool's status: saved choice (density, card), running, pending
        let sel = null;         // what is selected on screen: {density, card, mode}; mode 'preset' or 'custom'
        // which tile a density belongs to is the owner's choice, not the value: Custom at 180 is still Custom.
        // The last applied Custom value is kept, so after the restart it still shows as Custom.
        const memFile = path.join(ctx.dataDir || '.', 'ui.json');
        let mem = {};
        try { mem = JSON.parse(fs.readFileSync(memFile, 'utf8')) || {}; } catch (e) { mem = {}; }
        const remember = () => { try { fs.writeFileSync(memFile, JSON.stringify(mem)); } catch (e) { log.warn('ui.json: ' + e.message); } };
        const modeOf = (d) => (PRESETS.indexOf(d) < 0 || mem.custom === d ? 'custom' : 'preset');
        let msg = '', busy = '', version = 0;
        let custom = CUSTOM.start;      // the Custom tile's value (kept when a preset is picked)
        const changed = () => { version++; };

        const active = () => !!(st && st.state === 'active');
        const dirty = () => !!(st && sel && (sel.density !== st.density || sel.card !== st.card));
        const pending = () => !!(st && st.pending);

        async function refresh() {
            const r = await ctl.status();
            if (!r.ok) { msg = 'Not reachable (' + r.error + ')'; log.warn('status: ' + r.error); changed(); return; }
            if (/^Not reachable/.test(msg)) msg = '';
            st = r;
            if (!sel || !dirty()) sel = { density: st.density, card: st.card, mode: modeOf(st.density) };
            if (sel.mode === 'custom') custom = sel.density;
            changed();
        }

        /* ---------- drawing ---------- */

        // a line cut to the box (x0, y0, x1, y1) (Liang-Barsky), so drawings stay inside on both paths
        function cut(ax, ay, bx, by, x0, y0, x1, y1) {
            let t0 = 0, t1 = 1;
            const dx = bx - ax, dy = by - ay;
            for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
                if (p === 0) { if (q < 0) return null; continue; }
                const r = q / p;
                if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
            }
            return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy];
        }

        // a small cluster map slot: roads at the density's scale, the route, the car and the turn card
        function miniMap(cv, t, x, y, w, h, d, card) {
            const s = d / SLOT_DPI, cx = x + w / 2, cy = y + h * 0.62;
            cv.roundRect(x, y, w, h, 10, '#0d131c');
            const seg = (ax, ay, bx, by, wd, c) => {
                const l = cut(cx + ax * s, cy + ay * s, cx + bx * s, cy + by * s, x + 4, y + 4, x + w - 4, y + h - 4);
                if (l) cv.line(l[0], l[1], l[2], l[3], wd * s, c);
            };
            const road = (ax, ay, bx, by, wd) => seg(ax, ay, bx, by, wd, '#3a4556');
            road(-260, 120, 260, -110, 9);
            road(-60, -200, 120, 220, 9);
            road(-300, -40, 300, 10, 6);
            road(150, -220, 230, 220, 6);
            road(-220, -200, -120, 220, 5);
            const rt = [[0, 0], [22, -50], [80, -70], [150, -100]];
            for (let i = 1; i < rt.length; i++) seg(rt[i - 1][0], rt[i - 1][1], rt[i][0], rt[i][1], 7, ROUTE);
            cv.circle(cx, cy, 11 * s, '#ffffff');
            cv.circle(cx, cy, 7 * s, ROUTE);
            if (card) {
                const cw = Math.min(210 * s, w - 16), ch = (d >= 235 ? 66 : 40) * s;
                cv.roundRect(cx - cw / 2, y + 12, cw, ch, 6, '#2b6b3f');
                const ax = cx - cw / 2 + 20 * s, ay = y + 12 + 9 * s;      // the turn arrow (the fonts have none)
                cv.quad([[ax, ay], [ax + 8 * s, ay + 10 * s], [ax - 8 * s, ay + 10 * s], [ax, ay]], '#ffffff');
                cv.fillRect(ax - 2.5 * s, ay + 9 * s, 5 * s, 14 * s, '#ffffff');
                cv.fillRect(cx - cw / 2 + 36 * s, y + 12 + 15 * s, cw * 0.62, 7 * s, withAlpha('#ffffff', 0.85));
                if (d >= 235) cv.fillRect(cx - cw / 2 + 36 * s, y + 12 + 40 * s, cw * 0.3, 7 * s, withAlpha('#ffffff', 0.85));
            } else {
                // hidden: Maps' trip bar at the bottom instead (time left, distance, arrival)
                const bw = Math.min(150 * s, w - 24);
                cv.roundRect(cx - bw / 2, y + h - 16 - 24 * s, bw, 24 * s, 6, withAlpha('#000000', 0.75));
                cv.fillRect(cx - bw / 2 + 14 * s, y + h - 16 - 14 * s, bw - 28 * s, 5 * s, withAlpha('#ffffff', 0.8));
            }
        }

        const isCustom = () => !!(sel && sel.mode === 'custom');

        function tileFrame(cv, t, x, y, w, h, on) {
            cv.roundRect(x, y, w, h, 10, withAlpha(on ? t.accent2 || t.accent : '#ffffff', on ? 0.14 : 0.04));
            if (on) cv.strokeRoundRect(x, y, w, h, 10, 3, t.accent2 || t.accent);
        }

        function drawZoom(cv, t) {
            G.panel(cv, t, 24, 44, 1000, 468, 'Map zoom');
            const run = st && st.running, card = !sel || sel.card === 'shown';
            const y = 100, w = 228, h = 396;
            // the running density sits on the tile it was applied from
            running = run ? modeOf(run.density) : null;
            PRESETS.forEach((d, i) => {
                const x = 44 + i * 244, on = !!(sel && sel.mode === 'preset' && sel.density === d);
                if (cv.own) cv.target(x, y, w, h, () => select({ density: d, mode: 'preset' }), 'd' + d, 10);
                tileFrame(cv, t, x, y, w, h, on);
                miniMap(cv, t, x + 12, y + 12, w - 24, 150, d, card);
                cv.text(NAMES[d], x + 16, y + 214, 28, t.text, { font: 'bold' });
                cv.text(d + ' dpi', x + 16, y + 252, 24, on ? t.text : t.dim, { font: 'num' });
                cv.text(note(d), x + 16, y + 286, 19, t.dim);
                if (on) cv.text('✓', x + w - 18, y + 218, 32, t.accent2 || t.accent, { align: 'right', font: 'bold' });
                if (run && running === 'preset' && run.density === d) G.pill(cv, t, x + 16, y + 352, 86, 26, 'NOW', { size: 16, color: 'dim' });
            });
            drawCustom(cv, t, 44 + 3 * 244, y, w, h, card, run);
        }

        // the Custom tile: any density in CUSTOM's range, with - / + and a slider (tap a step on it)
        function drawCustom(cv, t, x, y, w, h, card, run) {
            const on = isCustom(), v = on ? sel.density : custom;
            const acc = t.accent2 || t.accent;
            if (cv.own) cv.target(x, y, w, 180, () => select({ density: custom, mode: 'custom' }), 'dcustom', 10);
            tileFrame(cv, t, x, y, w, h, on);
            miniMap(cv, t, x + 12, y + 12, w - 24, 150, Math.min(v, CUSTOM.max), card);
            cv.text('Custom', x + 16, y + 214, 28, t.text, { font: 'bold' });
            if (on) cv.text('✓', x + w - 18, y + 218, 32, acc, { align: 'right', font: 'bold' });
            // - value +
            const by = y + 228, bs = 44;
            [['-', -1, x + 14], ['+', 1, x + w - 14 - bs]].forEach(([lbl, dir, bx]) => {
                const can = dir < 0 ? v > CUSTOM.min : v < CUSTOM.max;
                if (cv.own && can) cv.target(bx, by, bs, bs, () => stepCustom(dir), 'dc' + lbl, 8);
                cv.roundRect(bx, by, bs, bs, 8, withAlpha('#ffffff', can ? 0.1 : 0.03));
                cv.text(lbl, bx + bs / 2, by + 32, 30, can ? t.text : t.dim, { align: 'center', font: 'bold' });
            });
            cv.text(v + ' dpi', x + w / 2, by + 32, 24, on ? t.text : t.dim, { align: 'center', font: 'num' });
            // the slider: a target per step along the track
            const tx = x + 18, tw = w - 36, ty = y + 300, n = (CUSTOM.max - CUSTOM.min) / CUSTOM.step;
            cv.roundRect(tx, ty - 3, tw, 6, 3, withAlpha('#ffffff', 0.18));
            const k = Math.max(0, Math.min(1, (v - CUSTOM.min) / (CUSTOM.max - CUSTOM.min)));
            cv.roundRect(tx, ty - 3, tw * k, 6, 3, on ? acc : t.dim);
            for (let i = 0; i <= n; i++) {
                const sx = tx + tw * i / n;
                cv.fillRect(sx - 1, ty + 7, 2, i % 5 === 0 ? 8 : 4, withAlpha('#ffffff', 0.3));
                if (cv.own) cv.target(sx - tw / n / 2, ty - 18, tw / n, 36, () => setCustom(CUSTOM.min + i * CUSTOM.step), 'ds' + i, 4);
            }
            cv.circle(tx + tw * k, ty, 11, on ? acc : t.dim);
            cv.text(String(CUSTOM.min), tx, ty + 36, 17, t.dim);
            cv.text(String(CUSTOM.max), tx + tw, ty + 36, 17, t.dim, { align: 'right' });
            if (v > CUSTOM.max) cv.text('set to ' + v + ' outside the app', x + 16, ty + 36, 17, t.warn);
            if (run && running === 'custom') G.pill(cv, t, x + 16, y + 352, 86, 26, 'NOW', { size: 16, color: 'dim' });
            else cv.text(note(v), x + w / 2, y + 372, 17, t.dim, { align: 'center' });
        }

        function drawCard(cv, t) {
            G.panel(cv, t, 1040, 44, 536, 196, 'Turn card');
            G.pill(cv, t, 1404, 60, 156, 28, 'EXPERIMENTAL', { size: 15, color: 'warn' });
            CARDS.forEach(([v, label], i) => {
                const x = 1060 + i * 252, y = 104, w = 240, h = 56, on = !!(sel && sel.card === v);
                if (cv.own) cv.target(x, y, w, h, () => select({ card: v }), 'c' + v, 8);
                cv.roundRect(x, y, w, h, 8, withAlpha(on ? t.accent2 || t.accent : '#ffffff', on ? 0.2 : 0.05));
                if (on) cv.strokeRoundRect(x, y, w, h, 8, 2, t.accent2 || t.accent);
                cv.text(label, x + w / 2, y + 38, 28, on ? t.text : t.dim, { align: 'center', font: 'bold' });
            });
            cv.text('Hidden: the card is cropped off the top of the map,', 1060, 194, 20, t.dim);
            cv.text("and Maps shows its trip bar (time, distance, arrival).", 1060, 222, 20, t.dim);
        }

        function drawStatus(cv, t) {
            G.panel(cv, t, 1040, 252, 536, 168, 'Status');
            const line = (txt, y, size, col, font) => cv.text(txt, 1060, y, size, col, font ? { font } : undefined);
            if (!st) { line(msg || 'Asking aa-on-cluster...', 340, 22, t.dim); return; }
            if (!ctl.installed) {
                line('Android Auto on cluster not installed', 334, 24, t.warn, 'bold');
                line('Install it (0.5 or newer) from the Store.', 368, 21, t.dim);
                line('Until then this is a demo.', 398, 21, t.dim);
                return;
            }
            if (!active()) {
                const unknown = st.state === 'unknown';
                line(unknown ? 'Unknown firmware' : 'Android Auto map is off', 334, 26, t.warn, 'bold');
                line(unknown ? 'aa-on-cluster does not know this firmware' : 'aa-on-cluster put stock aapd back', 368, 21, t.dim);
                line(unknown ? 'and changes nothing.' : '(removed, or after a crash). Reinstall it.', 398, 21, t.dim);
                return;
            }
            const run = st.running;
            cv.roundRect(1060, 322, 12, 12, 6, run ? GO : t.warn);
            cv.text(run ? 'On the cluster now' : 'Not running yet: restart once after installing', 1084, 335, 21, t.dim);
            if (run) line(run.density + ' dpi, ' + cardTxt(run.card), 372, 30, t.text, 'bold');
            const note = msg ? [msg, t.warn]
                : dirty() ? ['Selected: ' + sel.density + ' dpi, ' + cardTxt(sel.card), t.accent2 || t.accent]
                : st.restartError ? ['Restart failed: ' + st.restartError, t.warn]
                : pending() ? ['Next start: ' + st.density + ' dpi, ' + cardTxt(st.card), t.warn]
                : ['Nothing to apply', t.dim];
            line(note[0], 406, 21, note[1], note[1] === t.dim ? undefined : 'bold');
        }

        // the button under the status card: Apply changes, then Restart head unit to apply changes
        function action() {
            if (!st || !(active() || ctl.demo)) return null;
            if (busy) return { label: busy, run: null };
            if (dirty()) return { label: 'Apply changes', run: apply, color: 'accent' };
            if (st.restarting) return { label: 'Restarting the head unit...', run: null };
            if (pending()) return { label: 'Restart head unit to apply changes', run: restart, color: 'warn' };
            return null;
        }

        function drawAction(cv, t) {
            const a = action();
            if (!a) return;
            const x = 1040, y = 432, w = 536, h = 72;
            const c = a.color === 'warn' ? t.warn : t.accent2 || t.accent;
            if (cv.own && a.run) cv.target(x, y, w, h, a.run, 'action', 10);
            cv.roundRect(x, y, w, h, 10, withAlpha(a.run ? c : '#ffffff', a.run ? 0.22 : 0.06));
            if (a.run) cv.strokeRoundRect(x, y, w, h, 10, 2, c);
            cv.text(a.label, x + w / 2, y + 46, 28, a.run ? t.text : t.dim, { align: 'center', font: 'bold' });
        }

        let running = null;     // 'preset' or 'custom': the tile the cluster's running density belongs to
        let drawn = -1;
        async function render(force) {
            if (!force && drawn === version) return;
            drawn = version;
            const t = ctx.theme();
            const cv = ctx.canvas(W, H).clear(t.bg);
            drawZoom(cv, t);
            drawCard(cv, t);
            drawStatus(cv, t);
            drawAction(cv, t);
            G.frame(cv, t, ['AA Cluster Companion'], 0, [ctl.demo && { text: 'DEMO' }]);
            await ui.image('MAIN_GFX', cv);
        }

        /* ---------- actions ---------- */
        function select(s) {
            if (!sel || busy) return;
            sel = Object.assign({}, sel, s);
            msg = '';
            changed();
        }

        function setCustom(v) {
            custom = Math.max(CUSTOM.min, Math.min(CUSTOM.max, v));
            select({ density: custom, mode: 'custom' });
        }
        function stepCustom(dir) { setCustom((isCustom() ? sel.density : custom) + dir * CUSTOM.step); }

        async function apply() {
            if (!dirty() || busy) return;
            busy = 'Applying...'; msg = ''; changed();
            const want = Object.assign({}, sel);
            let r = { ok: true };
            if (want.density !== st.density) r = await ctl.density(want.density);
            if (r.ok && want.card !== st.card) r = await ctl.card(want.card);
            busy = '';
            if (r.ok) {
                st = r;
                mem.custom = want.mode === 'custom' ? want.density : null;
                remember();
                log.info('applied ' + want.density + ' dpi (' + want.mode + '), card ' + want.card);
            }
            else { msg = 'Not applied: ' + r.error; log.warn('apply: ' + r.error); }
            await refresh();
        }

        async function restart() {
            if (!pending() || busy) return;
            busy = 'Asking for a restart...'; msg = ''; changed();
            const r = await ctl.restart();
            busy = '';
            log.info('restart: ' + JSON.stringify(r));
            if (!r.ok) msg = 'Restart refused: ' + r.error;
            else if (r.demo) msg = 'Demo: the head unit would restart now';
            await refresh();
        }

        // the HMI's own buttons (no bar is drawn; the software fallback and the controller use them)
        ui.onClick('BTN_ZOOM', () => {
            if (!sel) return;
            // presets, then Custom
            const i = sel.mode === 'custom' ? PRESETS.length : PRESETS.indexOf(sel.density);
            const n = (i + 1) % (PRESETS.length + 1);
            select(n < PRESETS.length ? { density: PRESETS[n], mode: 'preset' } : { density: custom, mode: 'custom' });
        });
        ui.onClick('BTN_CARD', () => { if (sel) select({ card: sel.card === 'hidden' ? 'shown' : 'hidden' }); });
        ui.onClick('BTN_APPLY', () => { const a = action(); return a && a.run ? a.run() : undefined; });

        await refresh();
        ctx.loop('MAIN', 2, () => render(false));
        // back from Settings, or the tool changed by itself: ask again now and then
        setInterval(refresh, 10000);
    },
});
