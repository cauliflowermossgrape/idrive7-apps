'use strict';
/**
 * hunter_tab.js - Live Data's Signal Hunter tab, a developer tool shown only with Settings > Advanced settings >
 * "Signal Hunter tab (developer)": which value moves when you do something in the car. Mark before, open a door,
 * switch the A/C or press a button, and What changed lists every value the car sent differently since, before and
 * now. Label what you found; save a window (20 s before and 10 s after by default) to step through it later.
 *
 *   const tab = HunterTab.create(ctx, { native })
 *   tab.on()                      the setting is on (Live Data adds the tab's five pages)
 *   tab.sync(shown)               listens only while the setting is on and shown is true (Live Data: its MAIN screen
 *                                 is visible and a Hunter page is the current one); otherwise lets go of every watch
 *   tab.draw(cv, t, p)            page p (0 What changed, 1 Live, 2 Found, 3 Playback, 4 How it works); where the
 *                                 kit runs the screen (cv.own) the page's buttons are drawn on it
 *   tab.animated(p)               page p changes on its own (redrawn every frame); How it works and Found do not
 *   tab.actionLabel(p) / tab.action(p)   the bar's main button on that page (elsewhere the page has it)
 *   tab.move(p, d) / tab.press(p)        the controller while browsing: previous / next, and the page's second job
 *   tab.demo()                    the made-up car is shown (no car, or Settings > Demo data)
 *
 *   - listens, read only, to every status field the apps here declare (hunter_fields.js, written by
 *     kit/tools/gen_signal_hunter.js): what the car already sends the head unit, not raw CAN; only while the setting
 *     is on and a Hunter page is on screen (no subscription in the background: some interfaces, KombiInterface_2
 *     among them, have disturbed other apps when subscribed with nobody looking)
 *   - What changed is worked out at most 4 times a second (LIST_MS), with running counts, never per frame
 *   - nothing is sent to the car: no method is called, no field is set, no control unit is asked anything
 *   - labels in <dataDir>/hunter/found.json, also written to the app's log (Settings > QR log carries them)
 *   - saved windows in <dataDir>/hunter/windows/, the newest 20 kept
 *   - demo: a made-up parked car (hunter_demo.js), never saved
 */
const fs = require('fs');
const path = require('path');
const G = require('./kit/gauges');
const { Hunter } = require('./hunter');
const { Windows } = require('./hunter_windows');
const { demoAt } = require('./hunter_demo');
const { draw, LABELS, val } = require('./hunter_view');

const LIST_MS = 250;                                              // What changed: worked out again at most this often
const SPLIT = { 10: [7, 3], 20: [14, 6], 30: [20, 10] };          // window length -> [s before, s after]
const ACTION = ['Mark before', 'Save window', 'Mark before', 'Next window', 'Mark before'];

function create(ctx, opts) {
    const { settings, log } = ctx;
    const native = (opts && opts.native) || (() => false);
    const dir = path.join(ctx.dataDir, 'hunter');
    try { fs.mkdirSync(dir); } catch (e) { /* there, or no data folder: kept in memory */ }
    let fields = {};
    try { fields = require('./hunter_fields').fields || {}; } catch (e) { log.warn('signal hunter: no field list: ' + e); }
    const ifaces = Object.keys(fields), nFields = ifaces.reduce((n, i) => n + fields[i].length, 0);

    const on = () => !!(settings.get('advanced') && settings.get('hunter'));
    let real = new Hunter(), demoH = new Hunter({ now: () => Date.now() }), demoStart = Date.now();
    let seen = false, subs = [], listening = false, demoTimer = null, saveTimer = null;
    let gen = 0;                                            // one per start: a watch from an earlier start is let go
    const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') !== 'off' && !seen && !native());
    const hunter = () => (demoOn() ? demoH : real);

    const FOUND = path.join(dir, 'found.json');
    let found = {};
    try { found = JSON.parse(fs.readFileSync(FOUND, 'utf8')); } catch (e) { /* none yet */ }
    const demoFound = {};
    const foundNow = () => (demoOn() ? demoFound : found);
    const labelNow = () => (LABELS.indexOf(settings.get('hunterLabel')) >= 0 ? settings.get('hunterLabel') : 'other');

    const realWin = new Windows(path.join(dir, 'windows')), demoWin = new Windows(null);
    const wins = () => (demoOn() ? demoWin : realWin);
    let pending = null;                                     // { h, wins, mark, from, until }
    const split = () => SPLIT[settings.get('hunterWindow')] || SPLIT[30];
    const noisyHidden = () => !settings.get('hunterNoisy');
    const speed = () => (settings.get('hunterSpeed') === 1 ? 1 : 0.25);
    // What changed, kept for LIST_MS: the list is worked out at most 4 times a second, not once a frame
    let cache = null;
    const changed = () => {
        const h = hunter(), noisy = !noisyHidden(), now = Date.now();
        if (!cache || cache.h !== h || cache.noisy !== noisy || now - cache.at >= LIST_MS || now < cache.at) {
            cache = { h, noisy, at: now, list: h.changed({ noisy }) };
        }
        return cache.list;
    };

    let sel = 0, fsel = 0, wsel = 0, step = 0, cursor = 0, playing = false, lastPlay = 0;
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

    function savePending(until) {
        const p = pending; pending = null;
        const e = p.wins.save(p.h.window(p.from, until), p.mark);
        log.info('signal hunter: window saved ' + e.file + ', ' + e.n + ' changes' + (e.error ? ', not written: ' + e.error : ''));
        wsel = 0; winFile = null;
    }
    function start() {
        listening = true;
        const g = ++gen;
        real = new Hunter(); seen = false; demoH = new Hunter({ now: () => Date.now() }); demoStart = Date.now(); cache = null;
        if (ctx.signals && ctx.signals.watch) {
            ifaces.forEach((iface) => {
                const h = {};
                fields[iface].forEach((f) => {
                    h[f] = (v) => {
                        if (g !== gen) return;                      // a watch from an earlier start, still being let go
                        if (!seen) { seen = true; log.info('signal hunter: the car answers (' + iface + ')'); }
                        real.update(iface + '|' + f, v);
                    };
                });
                Promise.resolve(ctx.signals.watch(iface, '1', h, log)).then((s) => {
                    if (!s) return;
                    // stopped, or stopped and started again, while this watch was being set up: let it go
                    if (listening && g === gen) subs.push(s); else if (s.shutdown) Promise.resolve(s.shutdown()).catch(() => {});
                }).catch((e) => log.warn('signal hunter: ' + iface + ': ' + (e && e.message || e)));
            });
        }
        demoTimer = setInterval(() => { if (demoOn()) demoAt(Date.now() - demoStart).forEach((kv) => demoH.update(kv[0], kv[1])); }, 100);
        if (demoTimer.unref) demoTimer.unref();
        // a window waiting for its "after" part, saved once that is in
        saveTimer = setInterval(() => { if (pending && Date.now() >= pending.until) savePending(pending.until); }, 250);
        if (saveTimer.unref) saveTimer.unref();
        log.info('signal hunter: listening to ' + nFields + ' fields on ' + ifaces.length + ' interfaces');
    }
    function stop() {
        listening = false;
        gen++;
        subs.forEach((s) => { try { if (s.shutdown) Promise.resolve(s.shutdown()).catch(() => {}); } catch (e) { /* gone */ } });
        subs = [];
        clearInterval(demoTimer); clearInterval(saveTimer); demoTimer = saveTimer = null;
        if (pending) savePending(Math.min(pending.until, Date.now()));     // the page left early: kept up to now
        log.info('signal hunter: stopped listening');
    }
    /** Listening only while the setting is on and a Hunter page is on screen (shown). */
    function sync(shown) {
        const want = on() && !!shown;
        if (want && !listening) start();
        else if (!want && listening) stop();
    }

    function mark() { hunter().mark(); cache = null; sel = 0; log.info('signal hunter: Mark before at ' + new Date().toISOString()); }
    function label(p) {
        const list = p === 1 ? hunter().recent(8000, { noisy: !noisyHidden() }) : changed();
        const r = list[Math.min(p === 1 ? 0 : sel, list.length - 1)];
        if (!r) return;
        const lab = labelNow();
        foundNow()[r.key] = { label: lab, at: Date.now(), old: r.old, val: r.val };
        if (!demoOn()) {
            try { fs.writeFileSync(FOUND, JSON.stringify(found)); } catch (e) { log.warn('signal hunter: labels: ' + e); }
            log.info('signal hunter: found ' + lab + ': ' + r.key + ' ' + val(r.old) + ' -> ' + val(r.val));
        }
    }
    function save() {
        if (pending) return;
        const [before, after] = split(), m = Date.now();
        pending = { h: hunter(), wins: wins(), mark: m, from: m - before * 1000, until: m + after * 1000 };
    }
    function play() {
        const w = curWin();
        if (!w) return;
        if (!playing && step >= w.changes.length) stepTo(0);
        playing = !playing; lastPlay = Date.now();
    }
    function nextWindow() { const n = wins().list().length; if (n) wsel = (wsel + 1) % n; curWin(); }
    function move(p, d) {
        playing = false;
        if (p === 3) stepTo(step + d);
        else if (p === 2) fsel = Math.max(0, Math.min(Math.max(0, Object.keys(foundNow()).length - 1), fsel + d));
        else sel = Math.max(0, Math.min(Math.max(0, changed().length - 1), sel + d));
    }
    function press(p) {
        if (p === 3) play();
        else if (p === 0 || p === 1) label(p);
    }
    function action(p) {
        if (p === 1) save();
        else if (p === 3) nextWindow();
        else mark();
    }

    /* The page's own buttons where the kit runs the screen: along the bottom, over that page's free part. */
    function bar(cv, t, p) {
        const y = 466, h = 38;
        let x = p === 3 ? 484 : 36;
        const b = (lab, run, o) => { x += G.button(cv, t, x, y, 0, h, lab, run, Object.assign({ key: 'hunter:' + lab }, o || {})) + 10; };
        if (p === 0) { b('Mark before', mark, { primary: true }); b('Previous', () => move(0, -1)); b('Next', () => move(0, 1)); b('Label it', () => label(0)); b(pending ? 'Saving...' : 'Save window', save, { busy: !!pending }); }
        else if (p === 1) { b('Label it', () => label(1), { primary: true }); b(pending ? 'Saving...' : 'Save window', save, { busy: !!pending }); b('Mark before', mark); }
        else if (p === 2) { b('Previous', () => move(2, -1)); b('Next', () => move(2, 1)); }
        else if (p === 3) { b(playing ? 'Pause' : 'Play', play, { primary: true }); b('Previous', () => move(3, -1)); b('Next', () => move(3, 1)); b('Next window', nextWindow); }
        else b('Mark before', mark, { primary: true });
    }

    function drawPage(cv, t, p) {
        const now = Date.now();
        if (playing && win) {
            cursor += (now - lastPlay) * speed(); lastPlay = now;
            while (step < win.changes.length && win.changes[step][0] <= cursor) step++;
            if (cursor >= win.to) { cursor = win.to; playing = false; }
        }
        // only What changed needs the list (and it is kept for LIST_MS); the other pages never work it out
        const h = hunter(), [before, after] = split(), list = p === 0 ? changed() : [];
        if (p === 0 && sel >= list.length) sel = Math.max(0, list.length - 1);
        const wl = wins().list();
        if (wsel >= wl.length) wsel = Math.max(0, wl.length - 1);
        draw(cv, t, p, {
            hunter: h, changed: list, now, sel, fsel, found: foundNow(), label: labelNow(), noisyHidden: noisyHidden(),
            windows: wl, wsel, win: p === 3 ? curWin() : null, step, cursor, playing, speed: speed(),
            pending: pending ? pending.until - now : 0, before, after, fields: nFields, ifaces: ifaces.length, own: !!cv.own,
        });
        if (cv.own) bar(cv, t, p);
    }

    return {
        on, sync, draw: drawPage, move, press, action, demo: demoOn,
        animated: (p) => p === 0 || p === 1 || (p === 3 && (playing || !!pending)),
        actionLabel: (p) => (p === 1 && pending ? 'Saving...' : ACTION[p] || 'Mark before'),
        busy: () => playing || !!pending,
        // for the tests
        _state: () => ({ real, demoH, listening, subs: subs.length, pending, sel, step, playing, gen }),
    };
}

module.exports = { create, ACTION };
