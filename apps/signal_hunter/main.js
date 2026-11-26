'use strict';
/**
 * Signal Hunter - which value moves when you do something in the car: press Mark before, open a door, switch the A/C
 * or press a button, and What changed lists every value the car sent differently since, before and now. Label what
 * you found; save a window (default 20 s before and 10 s after) to step through it later, change by change.
 *
 *   - listens, read only, to every status field the other apps here declare (app.json "signals", written by
 *     kit/tools/gen_signal_hunter.js): what the car already sends the head unit, not raw CAN
 *   - nothing is sent to the car: no method is called, no field is set, no control unit is asked anything
 *   - labels are kept in found.json and written to the app's log (Settings > QR log carries them)
 *   - saved windows in windows/, the newest 20 kept
 *   - demo (no car, or Settings > Demo data): a made-up parked car (demo.js), never saved
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Hunter, shortName } = require('./hunter');
const { Windows } = require('./windows');
const { demoAt } = require('./demo');
const { draw, LABELS, val } = require('./view');

const W = 1600, H = 520;
const TABS = ['What changed', 'Live', 'Found', 'Playback', 'How it works'];
const SPLIT = { 10: [7, 3], 20: [14, 6], 30: [20, 10] };          // window length -> [s before, s after]

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const spec = ctx.spec || {};
        const real = new Hunter(), demoStart = Date.now();
        const demoH = new Hunter({ now: () => Date.now() });
        let seen = false;
        const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') !== 'off' && !seen);
        const hunter = () => (demoOn() ? demoH : real);

        // listening: one watch per interface, every field of it in one go (read only)
        // (fields.js, written by kit/tools/gen_signal_hunter.js: the runtime spec carries no "signals" block)
        let sig = {};
        try { sig = require('./fields'); } catch (e) {
            Object.keys(spec.signals || {}).forEach((i) => { sig[i] = Object.keys(spec.signals[i]).filter((k) => !k.startsWith('_')); });
        }
        const ifaces = Object.keys(sig), nFields = ifaces.reduce((n, i) => n + sig[i].length, 0);
        if (ctx.signals && ctx.signals.watch) {
            ifaces.forEach((iface) => {
                const h = {};
                sig[iface].forEach((f) => {
                    h[f] = (v) => { if (!seen) { seen = true; log.info('signal hunter: the car answers (' + iface + ')'); } real.update(iface + '|' + f, v); };
                });
                Promise.resolve(ctx.signals.watch(iface, '1', h, log)).catch((e) => log.warn('signal hunter: ' + iface + ': ' + (e && e.message || e)));
            });
        }
        log.info('signal hunter: listening to ' + nFields + ' fields on ' + ifaces.length + ' interfaces');

        // the demo car, fed ten times a second only while the demo is what is shown
        const demoTimer = setInterval(() => { if (demoOn()) demoAt(Date.now() - demoStart).forEach((kv) => demoH.update(kv[0], kv[1])); }, 100);
        if (demoTimer.unref) demoTimer.unref();

        // labels
        const FOUND = path.join(ctx.dataDir, 'found.json');
        let found = {};
        try { found = JSON.parse(fs.readFileSync(FOUND, 'utf8')); } catch (e) { /* none yet */ }
        const demoFound = {};
        const foundNow = () => (demoOn() ? demoFound : found);
        const labelNow = () => (LABELS.indexOf(settings.get('label')) >= 0 ? settings.get('label') : 'other');

        // saved windows
        const realWin = new Windows(path.join(ctx.dataDir, 'windows')), demoWin = new Windows(null);
        const wins = () => (demoOn() ? demoWin : realWin);
        let pending = null;                                     // { h, wins, mark, from, until }
        const split = () => SPLIT[settings.get('window')] || SPLIT[30];

        let page = 0, sel = 0, fsel = 0, wsel = 0, step = 0, cursor = 0, playing = false, lastPlay = 0, lastDraw = 0;
        const noisyHidden = () => !settings.get('noisy');
        const changed = () => hunter().changed({ noisy: !noisyHidden() });
        const speed = () => (settings.get('speed') === 1 ? 1 : 0.25);
        let win = null, winFile = null;
        function curWin() {
            const e = wins().list()[wsel];
            if (!e) { win = null; winFile = null; return null; }
            if (e.file !== winFile) { win = wins().load(e); winFile = e.file; step = 0; cursor = win ? win.from : 0; playing = false; }
            return win;
        }
        const stepTo = (i) => {
            const w = curWin();
            if (!w) return;
            step = Math.max(0, Math.min(w.changes.length, i));
            cursor = step ? w.changes[step - 1][0] : w.from;
        };

        ui.onClick('BTN_MARK', () => { hunter().mark(); sel = 0; page = 0; log.info('signal hunter: Mark before at ' + new Date().toISOString()); return render(true); });
        ui.onClick('BTN_PREV', () => {
            if (page === 3) stepTo(step - 1); else if (page === 2) fsel = Math.max(0, fsel - 1); else sel = Math.max(0, sel - 1);
            playing = false; return render(true);
        });
        ui.onClick('BTN_NEXT', () => {
            if (page === 3) stepTo(step + 1);
            else if (page === 2) fsel = Math.min(Math.max(0, Object.keys(foundNow()).length - 1), fsel + 1);
            else sel = Math.min(Math.max(0, changed().length - 1), sel + 1);
            playing = false; return render(true);
        });
        ui.onClick('BTN_LABEL', () => {
            const list = page === 1 ? hunter().recent(8000, { noisy: !noisyHidden() }) : changed();
            const r = list[Math.min(sel, list.length - 1)];
            if (!r) return render(true);
            const lab = labelNow();
            foundNow()[r.key] = { label: lab, at: Date.now(), old: r.old, val: r.val };
            if (!demoOn()) {
                try { fs.writeFileSync(FOUND, JSON.stringify(found)); } catch (e) { log.warn('signal hunter: labels: ' + e); }
                log.info('signal hunter: found ' + lab + ': ' + r.key + ' ' + val(r.old) + ' -> ' + val(r.val));
            }
            return render(true);
        });
        ui.onClick('BTN_SAVE', () => {
            if (pending) return render(true);
            const [before, after] = split(), mark = Date.now();
            pending = { h: hunter(), wins: wins(), mark, from: mark - before * 1000, until: mark + after * 1000 };
            page = 3;
            return render(true);
        });
        ui.onClick('BTN_PLAY', () => {
            const w = curWin();
            if (!w) return render(true);
            if (!playing && step >= w.changes.length) stepTo(0);
            playing = !playing; lastPlay = Date.now(); page = 3;
            return render(true);
        });
        ui.onClick('BTN_WINDOW', () => { const n = wins().list().length; if (n) wsel = (wsel + 1) % n; page = 3; curWin(); return render(true); });
        if (ctx.onTab) ctx.onTab((i) => { page = i; return render(true); });

        // a window waiting for its "after" part, saved once that is in (also with the screen closed)
        const saveTimer = setInterval(() => {
            if (!pending || Date.now() < pending.until) return;
            const p = pending; pending = null;
            const e = p.wins.save(p.h.window(p.from, p.until), p.mark);
            log.info('signal hunter: window saved ' + e.file + ', ' + e.n + ' changes' + (e.error ? ', not written: ' + e.error : ''));
            wsel = 0; winFile = null;
        }, 250);
        if (saveTimer.unref) saveTimer.unref();

        function render(force) {
            const now = Date.now();
            // ten frames a second are plenty for lists of text (the GPU renderer asks once per screen refresh)
            if (!force && !playing && now - lastDraw < 100) return Promise.resolve();
            lastDraw = now;
            if (playing && win) {
                cursor += (now - lastPlay) * speed(); lastPlay = now;
                while (step < win.changes.length && win.changes[step][0] <= cursor) step++;
                if (cursor >= win.to) { cursor = win.to; playing = false; }
            }
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), h = hunter(), [before, after] = split();
            const list = changed();
            if (sel >= list.length) sel = Math.max(0, list.length - 1);
            const wl = wins().list();
            if (wsel >= wl.length) wsel = Math.max(0, wl.length - 1);
            draw(cv, t, page, {
                hunter: h, changed: list, now, sel, fsel, found: foundNow(), label: labelNow(), noisyHidden: noisyHidden(),
                windows: wl, wsel, win: page === 3 ? curWin() : null, step, cursor, playing, speed: speed(),
                pending: pending ? pending.until - now : 0, before, after, fields: nFields, ifaces: ifaces.length,
            });
            G.frame(cv, t, TABS, page, [demoOn() && { text: 'DEMO' }, pending && { text: 'SAVING', color: t.warn }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 10, () => render(false));
        render(true).then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
        return { real, demoH, shortName };
    },
});
