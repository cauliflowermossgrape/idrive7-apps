'use strict';
/**
 * G-Force - friction circle for the driver who wants to know how much grip
 * they actually used.
 *
 *   - live dot with fading trail
 *   - grip envelope: the furthest g reached in every direction this session
 *     (the classic g-g diagram shape - fill it out and you're using the car)
 *   - peak accel / brake / left / right, combined peak, top speed, max rpm
 *   - all-time records saved in data/gforce_records.json
 *   - the last minute saved when it matters (the former Blackbox, #248), off until switched on (Settings > Save the
 *     last minute): then, with the car (app.json autostart), the last 60 s are kept in memory ten times a second and
 *     saved, with 15 s after, as a CSV file on a hard stop, through a Sport stretch, at full power (off by default) or
 *     with Save last 60 s (recorder.js); Last minute, Recordings and Replay show them (bbview.js). While it is off the
 *     background part watches nothing and writes nothing. Reads only what the car sends anyway; nothing is asked of
 *     or written to any control unit.
 *
 * Small spikes (kerbs, potholes) are filtered with a 150 ms moving average.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const { withAlpha } = require('./kit/canvas');
const G = require('./kit/gauges');
const { qrLogSheet } = require('./kit/qrlog');
const { t: translate } = require('./kit/i18n');
const Car = require('./kit/car');
const { Recorder, Triggers, RATE_MS } = require('./recorder');
const BB = require('./bbview');

const W = 1600, H = 520;
const MPH = 1.609344;
const SECT = 48;
const GO = '#2fd27a';
const G0 = 9.80665;
const TABS = ['G-force', 'Records', 'Last minute', 'Recordings', 'Replay', 'How it works'];
const RATES = [0.25, 1, 4];

/** The driving mode (FES actualValueModeDrivingExperience, a name or a wire number, as Redline reads it). */
function modeOf(raw) {
    if (raw === undefined || raw === null) return null;
    const n = Number(raw);
    if (!isNaN(n) && String(raw).trim() !== '') {
        return (n >= 1 && n <= 3) || n === 15 || n === 16 || n === 23 || n === 28 ? 'sport'
            : n >= 17 && n <= 22 ? 'hybrid' : (n >= 4 && n <= 6) || n === 10 ? 'comfort' : n >= 7 && n <= 9 ? 'eco' : null;
    }
    const s = String(raw).toUpperCase();
    return /SPORT|BOOST/.test(s) ? 'sport' : /HYBRID|ELECTRIC|BATTERY/.test(s) ? 'hybrid' : /ADAPTIV|COMFORT|TRAFFIC/.test(s) ? 'comfort' : /ECO/.test(s) ? 'eco' : null;
}

/* With or without the screen (autostart): the recordings. Setting "Save the last minute" off (the default): nothing
 * is watched, nothing runs and nothing is written; it starts when the setting is switched on and stops when it is off. */
async function background(bg) {
    const { settings, signals, log } = bg;
    const v = { rpm: null, speed: null, gLong: null, gLat: null, torque: null, oil: null, coolant: null, mode: null };
    const sc = (raw, f, o, bad) => (typeof raw === 'number' && raw !== bad ? raw * f + o : null);
    const watch = (iface, h) => (signals && signals.watch ? Promise.resolve(signals.watch(iface, '1', h, log)).catch((e) => { log.warn('recordings: ' + iface + ': ' + (e && e.message || e)); return null; }) : Promise.resolve(null));
    const rec = new Recorder({ dir: path.join(bg.dataDir, 'recordings'), keep: () => settings.get('bbKeep'),
        onSaved: (e) => log.info('recordings: saved ' + e.file + ' (' + Math.round(e.ms / 1000) + ' s' + (e.error ? ', ' + e.error : '') + ')') });
    const state = { seen: false, kw: null, peakKw: settings.get('bbPeakKw') || 0, powerStable: false };
    let timer = null, subs = [], trig = null;
    const start = () => {
        if (timer) return;
        Object.keys(v).forEach((k) => { v[k] = null; });
        subs = [
            watch('de.bmw.infotainment.vehicle.CDS', {
                statusEngineSpeed2: (x) => { v.rpm = sc(x && x.actualValueRPMEngineCrankshaft, 0.25, 0, 65535); },
                statusEngineTemperature: (x) => { v.oil = sc(x && x.temperatureEngineOilDrive, 1, -48, 255); v.coolant = sc(x && x.temperatureEngineDrive, 1, -48, 255); },
            }),
            watch('de.bmw.infotainment.vehicle.Vehicle2', { statusCarSpeed2: (x) => { v.speed = sc(x && x.speedVehicleCentreOfGravity, 0.015625, 0, 65535); } }),
            watch('de.bmw.infotainment.vehicle.CDS2', {
                statusLongitudinalAccelerationMassCenter: (x) => { const a = sc(x && x.longitudinalAccelerationCentreOfGravity, 0.002, -65, 65535); v.gLong = a === null ? null : a / G0; },
                statusLateralAccelerationMassCenter: (x) => { const a = sc(x && x.lateralAccelerationCentreOfGravity, 0.002, -65, 65535); v.gLat = a === null ? null : a / G0; },
            }),
            watch('de.bmw.infotainment.drivingexcitement.FES', {
                statusActualValueTorque2: (x) => { const raw = x && x.actualValueTorqueCrankshaft; v.torque = typeof raw === 'number' && raw < 4095 ? raw * 0.5 - 1023.5 : null; },
                statusFESVehicleDynamicSwitchHMI: (x) => { const m = modeOf(x && x.actualValueModeDrivingExperience); if (m) v.mode = m; },
            }),
        ];
        // a hard stop held for 0.2 s, full power once the car's peak is learned, a Sport stretch (recorder.js Triggers)
        trig = new Triggers({ rec, settings, now: Date.now() });
        timer = setInterval(() => {
            if (!state.seen && (G.isNum(v.speed) || G.isNum(v.rpm))) state.seen = true;
            const now = Date.now(), out = trig.step(v, now);
            if (G.isNum(out.brake)) log.info('recordings: hard stop ' + out.brake.toFixed(2) + ' g');
            if (G.isNum(out.power)) log.info('recordings: full power ' + Math.round(out.power) + ' kW');
            state.kw = trig.kw; state.peakKw = trig.power.peak; state.powerStable = trig.power.stable(now);
        }, RATE_MS);
        if (timer.unref) timer.unref();
        log.info('recordings: on');
    };
    const stop = () => {
        if (!timer) return;
        clearInterval(timer); timer = null; trig = null;
        rec.flush();
        subs.forEach((p) => p.then((w) => w && w.shutdown && w.shutdown()).catch(() => {}));
        subs = [];
        Object.keys(v).forEach((k) => { v[k] = null; });
        state.kw = null;
        log.info('recordings: off');
    };
    if (settings.get('bbRecord')) start();
    if (settings.onChange) settings.onChange((k, val) => { if (k === 'bbRecord') { if (val) start(); else stop(); } });
    process.on('exit', () => rec.flush());
    return { rec, v, state, on: () => !!timer };
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const car = new Car(ctx, ['accel', 'speed', 'rpm']);

        const FILE = path.join(ctx.dataDir, 'gforce_records.json');
        let rec = {};
        try { rec = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* first start */ }
        const demoRec = {};
        let saveTimer = null;
        const saveNow = () => { clearTimeout(saveTimer); saveTimer = null; try { fs.writeFileSync(FILE, JSON.stringify(rec)); } catch (e) { log.warn('save: ' + e); } };
        const saveSoon = () => { if (!saveTimer) saveTimer = setTimeout(saveNow, 5000); };
        // shutdown exits 200 ms after MainApp asks (kit mgu.js): a record still waiting for its 5 s goes now
        process.on('exit', () => { if (saveTimer) saveNow(); });

        /* ---------- session ---------- */
        let S;
        const newSession = () => {
            S = { start: Date.now(), env: new Array(SECT).fill(0), peak: { acc: 0, brk: 0, left: 0, right: 0, comb: 0 }, vmax: 0, rpmMax: 0, over05: 0, trail: [], lastT: 0 };
        };
        newSession();
        const smooth = [];
        let cur = { lat: null, long: null };

        car.onSample((d, t) => {
            if (!G.isNum(d.gLong)) return;
            // a road car can't exceed ~3 g: anything above is a bad sample, not a record
            if (Math.abs(d.gLong) > 3 || (G.isNum(d.gLat) && Math.abs(d.gLat) > 3)) return;
            const lat0 = G.isNum(d.gLat) ? (settings.get('flipLat') ? -d.gLat : d.gLat) : 0;
            smooth.push([t, lat0, d.gLong]);
            while (smooth.length && t - smooth[0][0] > 150) smooth.shift();
            const lat = smooth.reduce((a, s) => a + s[1], 0) / smooth.length, long = smooth.reduce((a, s) => a + s[2], 0) / smooth.length;
            cur = { lat, long };
            const dt = S.lastT ? Math.min(250, t - S.lastT) : 0; S.lastT = t;
            const comb = Math.sqrt(lat * lat + long * long);
            const p = S.peak;
            p.acc = Math.max(p.acc, long); p.brk = Math.max(p.brk, -long);
            p.left = Math.max(p.left, lat); p.right = Math.max(p.right, -lat); p.comb = Math.max(p.comb, comb);
            if (comb > 0.5) S.over05 += dt / 1000;
            // envelope sector: angle of (lat, long), 0 = accel (up), clockwise
            const a = (Math.atan2(lat, long) * 180 / Math.PI + 360) % 360;
            const si = Math.floor(a / (360 / SECT)) % SECT;
            S.env[si] = Math.max(S.env[si], comb);
            if (G.isNum(d.speed)) S.vmax = Math.max(S.vmax, d.speed);
            if (G.isNum(d.rpm)) S.rpmMax = Math.max(S.rpmMax, d.rpm);
            S.trail.push([t, lat, long]);
            const keep = settings.get('trail') * 1000;
            while (S.trail.length && t - S.trail[0][0] > keep) S.trail.shift();
            // all-time records
            const R = d.demo ? demoRec : rec;
            let changed = false;
            [['acc', p.acc], ['brk', p.brk], ['left', p.left], ['right', p.right], ['comb', comb], ['vmax', S.vmax]].forEach(([k, v]) => {
                if (v > ((R[k] && R[k].v) || 0) + 1e-3) { R[k] = { v, at: Date.now() }; changed = true; }
            });
            if (changed && R === rec) saveSoon();
        }, () => { newSession(); smooth.length = 0; });

        /* ---------- drawing ---------- */
        let page = 0;
        const mph = () => settings.get('speedUnit') === 'mph';
        const V = (k) => (mph() ? k / MPH : k);

        function circle(cv, t, cx, cy, r) {
            const max = settings.get('scale');
            cv.circle(cx, cy, r + 14, withAlpha(t.panelTop, 0.9));
            for (let ring = 0.25; ring <= max + 1e-6; ring += 0.25) {
                const rr = (ring / max) * r, major = Math.abs(ring % 0.5) < 1e-6;
                cv.arc(cx, cy, rr - (major ? 1.5 : 0.75), rr + (major ? 1.5 : 0.75), 0, 360, major ? t.tick : withAlpha(t.tick, 0.35));
                if (major) cv.text(ring.toFixed(1), cx + rr * 0.7071 + 6, cy - rr * 0.7071 - 4, 20, t.dim);
            }
            cv.line(cx - r, cy, cx + r, cy, 2, withAlpha(t.tick, 0.5));
            cv.line(cx, cy - r, cx, cy + r, 2, withAlpha(t.tick, 0.5));
            const flipLong = settings.get('flipLong');      // brake on top, accel at the bottom (issue #62)
            const ySign = flipLong ? 1 : -1;
            const P = (lat, lon) => [cx - G.clamp(lat / max, -1.08, 1.08) * r, cy + ySign * G.clamp(lon / max, -1.08, 1.08) * r];
            // grip envelope (left = positive lat drawn to the left)
            const pts = S.env.map((g, i) => {
                const a = (i + 0.5) * (360 / SECT) * Math.PI / 180;
                return P(Math.sin(a) * g, Math.cos(a) * g);
            });
            if (S.env.some((g) => g > 0.05)) {
                pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; cv.line(p[0], p[1], q[0], q[1], 3, withAlpha(t.accent2, 0.8)); });
            }
            // trail
            const tr = S.trail, n = tr.length;
            tr.forEach((s, i) => { if (i % 2) return; const [x, y] = P(s[1], s[2]); cv.circle(x, y, 4, withAlpha(t.accent, 0.08 + 0.55 * (i / n))); });
            if (G.isNum(cur.long)) {
                const [x, y] = P(cur.lat, cur.long);
                cv.circle(x, y, 20, withAlpha(t.accent, 0.25));
                cv.circle(x, y, 12, t.accent);
                cv.circle(x, y, 5, t.text);
            }
            const [topLbl, botLbl] = flipLong ? ['BRAKE', 'ACCEL'] : ['ACCEL', 'BRAKE'];
            cv.text(topLbl, cx, cy - r - 20, 22, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
            cv.text(botLbl, cx, cy + r + 38, 22, t.dim, { align: 'center', font: 'bold', spacing: 1.5 });
            cv.text('L', cx - r - 30, cy + 8, 22, t.dim, { align: 'center', font: 'bold' });
            cv.text('R', cx + r + 30, cy + 8, 22, t.dim, { align: 'center', font: 'bold' });
        }

        function peakBox(cv, t, x, y, label, v, rec) {
            cv.text(label, x, y, 22, t.dim, { font: 'bold', spacing: 1.5 });
            const w = cv.text(v > 0.005 ? v.toFixed(2) : '-.--', x, y + 58, 64, v > 0.005 ? t.text : t.dim, { font: 'num' });
            cv.text('g', x + w + 6, y + 58, 24, t.dim);
            if (rec && rec.v > 0) cv.text('record ' + rec.v.toFixed(2), x, y + 88, 22, Math.abs(rec.v - v) < 1e-3 && v > 0.05 ? GO : t.dim, { font: 'bold' });
        }

        function drawLive(cv, t) {
            const R = car.data().demo ? demoRec : rec;
            // ex: how much lower the panels reach where the screen has room below the page (else 0)
            const sh = G.panel(cv, t, 24, 44, 600, 468, null), ex = sh.y + sh.h - G.BOTTOM, mid = Math.floor(G.toMargin(ex, 11) / 2);
            circle(cv, t, 324, 282 + mid, 182 + mid);       // a larger circle: it stays round, BRAKE ends G.MARGIN over the bottom
            // live readout
            G.panel(cv, t, 648, 44, 420, 468, 'Now');
            // numbers at the G-force display rate (default 10 a second); the dot and trail stay at full rate
            const gms = 1000 / (settings.get('gRate') || 10);
            const hl = G.hold('glat', cur.lat, gms), hg = G.hold('glong', cur.long, gms);
            const comb = G.isNum(hg) ? Math.sqrt(hl * hl + hg * hg) : null;
            const cw = cv.text(G.fmt(comb, 2), 672, 199, 120, G.isNum(comb) ? (comb > 0.9 ? t.accent2 : t.text) : t.dim, { font: 'num' });
            cv.text('g', 680 + cw, 199, 36, t.dim);
            const bars = [['LATERAL', G.isNum(hl) ? Math.abs(hl) : null, G.isNum(hl) ? (hl >= 0 ? 'L' : 'R') : ''],
                ['LONGITUDINAL', G.isNum(hg) ? Math.abs(hg) : null, G.isNum(hg) ? (hg >= 0 ? 'ACC' : 'BRK') : '']];
            // OEM-style bars; the hang is this session's peak on the side it is pulling to now
            // (the room spread over the gaps, the speed line at the panel's bottom)
            const pk = [hl >= 0 ? S.peak.left : S.peak.right, hg >= 0 ? S.peak.acc : S.peak.brk];
            bars.forEach(([l, v, side], i) => {
                G.bar(cv, t, 672, 233 + i * 108 + Math.round((i + 1) * ex / 3), 372, 92, { label: l + '  ' + side, value: v, decimals: 2, max: settings.get('scale'), ramp: 'hot', peak: pk[i] });
            });
            const d = car.data();
            cv.text(G.fmt(V(G.hold('speed', d.speed, gms)), 0) + (mph() ? ' mph' : ' km/h') + '   ·   ' + G.fmt(d.rpm, 0) + ' rpm', 672, 491 + G.toMargin(ex, 17), 22, t.dim, { font: 'bold', spacing: 1 });

            // session peaks
            G.panel(cv, t, 1092, 44, 484, 468, 'Session peaks');
            G.button(cv, t, 1576 - 20 - 180, 56, 180, 40, 'Reset max', act, { key: 'reset', confirm: true });
            peakBox(cv, t, 1116, 116, 'ACCEL', S.peak.acc, R.acc);
            peakBox(cv, t, 1346, 116, 'BRAKE', S.peak.brk, R.brk);
            // (the room spread over the gaps, the last line at the panel's bottom)
            const e1 = Math.round(ex / 3), e2 = Math.round(ex * 2 / 3);
            peakBox(cv, t, 1116, 255 + e1, 'LEFT', S.peak.left, R.left);
            peakBox(cv, t, 1346, 255 + e1, 'RIGHT', S.peak.right, R.right);
            cv.fillRect(1116, 382 + e2, 436, 1, withAlpha(t.tick, 0.4));
            cv.text('COMBINED  ' + (S.peak.comb ? S.peak.comb.toFixed(2) + ' g' : '--'), 1116, 421 + e2, 22, t.accent2, { font: 'bold', spacing: 1 });
            cv.text('> 0.5 g  ' + S.over05.toFixed(0) + ' s', 1552, 421 + e2, 22, t.text, { align: 'right', font: 'bold' });
            const mins = Math.floor((Date.now() - S.start) / 60000);
            cv.text(translate('TOP') + ' ' + Math.round(V(S.vmax)) + (mph() ? ' MPH' : ' KM/H') + '  ·  ' + Math.round(S.rpmMax) + ' RPM  ·  ' + mins + ' ' + translate('MIN'), 1116, 474 + G.toMargin(ex, 34), 22, t.dim, { font: 'bold', spacing: 0.5 });
        }

        function drawRecords(cv, t) {
            const R = car.data().demo ? demoRec : rec;
            const sh = G.panel(cv, t, 24, 44, 1552, 468, 'All-time records'), ex = sh.y + sh.h - G.BOTTOM;
            G.button(cv, t, 1576 - 20 - 200, 56, 200, 40, clearArmed ? 'Yes, clear' : 'Delete all', act, { key: 'clear', color: clearArmed ? t.crit : null });
            const rows = [['acc', 'Hardest launch', 'g'], ['brk', 'Hardest stop', 'g'], ['left', 'Left-hander', 'g'], ['right', 'Right-hander', 'g'], ['comb', 'Combined', 'g'], ['vmax', 'Top speed', mph() ? 'mph' : 'km/h']];
            rows.forEach(([k, label, u], i) => {
                const col = i % 2, row = Math.floor(i / 2), x = 48 + col * 760, y = Math.round(135 + row * (123 + G.toMargin(ex, 60) / 2));     // the room spread over the gaps
                const r = R[k], v = r ? (k === 'vmax' ? V(r.v) : r.v) : null;
                cv.text(label.toUpperCase(), x, y, 22, t.dim, { font: 'bold', spacing: 2 });
                const w = cv.text(v === null ? '--' : v.toFixed(k === 'vmax' ? 0 : 2), x, y + 66, 64, v === null ? t.dim : t.text, { font: 'num' });
                cv.text(u, x + w + 8, y + 66, 26, t.dim);
                if (r) { const d = new Date(r.at), p = (n) => String(n).padStart(2, '0'); cv.text(p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear(), x + 300, y + 66, 22, t.dim); }
            });
        }

        /** G20-style frame: tab bar with the page names along the top. */
        function header(cv, t) {
            const busy = bb.rec && !bbDemo() && bb.rec.busy();
            G.frame(cv, t, TABS, page, [car.data().demo && { text: 'DEMO' }, busy && { text: 'SAVING', color: t.crit }]);
        }

        /* ---------- the last minute: recordings and replay (the former Blackbox, #248) ---------- */
        const bb = ctx.background || await background(ctx);
        const bbSt = bb.state || { seen: true };
        // the chosen recording is held by what it is, not by its place in the list: a new one saved meanwhile (it goes on
        // top) or the oldest removed leaves it chosen, also during a replay. pinWait: Save last 60 s was pressed, the
        // newest is shown until that recording is saved, then it is the chosen one.
        let sel = 0, pin = null, pinWait = false;
        const keyOf = (e) => (e ? e.at + ':' + e.kind : null);
        function choose(l) {
            const i = pin === null ? -1 : l.findIndex((e) => keyOf(e) === pin);
            if (i >= 0) { sel = i; pinWait = false; return; }
            if (pinWait && !bbDemo() && bb.rec.busy()) { sel = 0; return; }
            pinWait = false;
            sel = Math.min(sel, Math.max(0, l.length - 1));
            pin = keyOf(l[sel]);
        }
        const cache = new Map();
        // demo recordings when the car's own data is demo (no car), as the G-force page
        const bbDemo = () => settings.get('demo') === 'on' || (settings.get('demo') !== 'off' && !bbSt.seen && !!car.data().demo);
        const demoList = makeDemo();
        const bbList = () => (bbDemo() ? demoList : bb.rec.list());
        function detail(e) {
            if (!e) return null;
            if (e.data) return { rows: e.data, sum: BB.summary(e.data, e.at) };
            if (cache.has(e.file)) return cache.get(e.file);
            let d;
            try { const rows = BB.parseCsv(fs.readFileSync(path.join(bb.rec.dir, e.file), 'utf8')); d = { rows, sum: BB.summary(rows, e.at) }; }
            catch (err) { d = { rows: [], sum: BB.summary([], e.at), error: String(err && err.message || err) }; }
            cache.set(e.file, d);
            if (cache.size > 6) cache.delete(cache.keys().next().value);
            return d;
        }
        function liveRows(now) {
            if (bbDemo()) { const out = []; for (let ms = now - 60000; ms <= now; ms += 200) out.push(demoAt(ms)); return out; }
            return bb.rec.ring.map((r) => ({ t: r[0], rpm: r[1], speed: r[2], gLong: r[3], gLat: r[4], torque: r[5] }));
        }
        /* Replay: the chosen recording played back, slower or faster. pos = seconds from the moment it was saved for. */
        const rp = { key: null, pos: 0, x0: 0, x1: 0, playing: false, rate: 0.25, last: 0 };
        // the time played so far is counted at the speed it played at, before a press changes anything
        const advance = (now) => {
            if (rp.playing) { rp.pos += (now - rp.last) / 1000 * rp.rate; if (rp.pos >= rp.x1) { rp.pos = rp.x1; rp.playing = false; } }
            rp.last = now;
        };
        const replayPlay = () => {
            page = 4; advance(Date.now());
            if (!rp.playing && rp.pos >= rp.x1 - 0.05) rp.pos = rp.x0;
            rp.playing = !rp.playing; rp.last = Date.now(); actionLabel();
            return render();
        };
        const replayRate = (r) => { advance(Date.now()); rp.rate = r || RATES[(RATES.indexOf(rp.rate) + 1) % RATES.length]; page = 4; actionLabel(); return render(); };
        const replayStart = () => { rp.pos = rp.x0; rp.last = Date.now(); page = 4; actionLabel(); return render(); };
        ui.onClick('BTN_PLAY', replayPlay);
        ui.onClick('BTN_RATE', () => replayRate());
        ui.onClick('BTN_START', replayStart);
        function replayState(l, now) {
            const e = l[sel], d = detail(e), rows = d ? d.rows : [];
            const key = e ? e.at + ':' + e.kind : null;
            if (key !== rp.key) {
                rp.key = key; rp.playing = false;
                rp.x0 = rows.length ? (rows[0].t - e.at) / 1000 : 0;
                rp.x1 = rows.length ? (rows[rows.length - 1].t - e.at) / 1000 : 0;
                rp.pos = rp.x0;
            }
            advance(now);
            return { e, d, rows, pos: rp.pos, x0: rp.x0, x1: rp.x1, playing: rp.playing, rate: rp.rate, rates: RATES,
                play: replayPlay, setRate: replayRate, start: replayStart };
        }
        function drawBlackbox(cv, t) {
            const now = Date.now(), demo = bbDemo(), l = bbList();
            choose(l);
            const v = demo ? Object.assign(demoAt(now), { mode: 'comfort' }) : bb.v;
            const kw = demo ? (v.torque * v.rpm / 9549) : bbSt.kw;
            BB.draw(cv, t, page - 2, { v, rows: page === 2 ? liveRows(now) : [], list: l, sel, detail: page === 3 ? detail(l[sel]) : null,
                replay: page === 4 ? replayState(l, now) : null, mph: mph(), on: !!settings.get('bbRecord'),
                busy: demo ? null : bb.rec.busy(), settings, kw, peakKw: demo ? 250 : bbSt.peakKw, powerStable: demo || !!bbSt.powerStable, demo, now });
            // the page's one job as a button where the kit runs the screen (the bar's button is left out there)
            if (page === 2) G.button(cv, t, 1376, 380, 180, 40, 'Save last 60 s', act, { key: 'bb-mark', primary: true });
            else if (page === 3 || page === 4) G.button(cv, t, (page === 3 ? 584 : 1024) - 20 - 220, 56, 220, 40, 'Next recording', act, { key: 'bb-next' });
            if (page === 2 && !settings.get('bbRecord')) {
                cv.roundRect(40, 196, 968, 88, 10, withAlpha(t.warn, 0.18));
                cv.text('Recording is off until you switch it on', 524, 232, 24, t.warn, { align: 'center', font: 'bold' });
                cv.text('Settings > Save the last minute. Until then nothing is read or saved.', 524, 266, 19, t.text, { align: 'center' });
            }
        }
        function recordingsText() {
            const l = bbList(), out = ['Recordings: ' + l.length + (bbDemo() ? ' (demo data)' : '')];
            l.forEach((e) => out.push(BB.when(e.at) + '  ' + (BB.KIND[e.kind] || e.kind) + ', ' + Math.round(e.ms / 1000) + ' s'
                + (G.isNum(e.vmax) ? ', top ' + Math.round(V(e.vmax)) + (mph() ? ' mph' : ' km/h') : '') + (G.isNum(e.gMax) ? ', peak ' + e.gMax.toFixed(2) + ' g' : '') + '  ' + (e.file || 'demo')));
            out.push('', 'The files: the app\'s data folder, recordings/');
            return out.join('\n');
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            if (page >= 2) drawBlackbox(cv, t);
            else (page === 0 ? drawLive : drawRecords)(cv, t);
            header(cv, t);
            await ui.image('MAIN_GFX', cv);
        }

        let clearArmed = null;
        // the bar's action button does each page's one job
        const ACTIONS = ['Reset max', null, 'Save last 60 s', 'Next recording', 'Next recording', 'Back to G-force'];
        const actionLabel = () => ui.text('BTN_ACTION', page === 1 ? (clearArmed ? 'Yes, clear' : 'Delete all') : ACTIONS[page] || 'Reset max');
        const go = (i) => { page = (i + TABS.length) % TABS.length; if (page !== 4) rp.playing = false; actionLabel(); return render(); };
        ui.onClick('BTN_PAGE', () => go(page + 1));
        ui.onClick('BTN_PREV', () => go(page - 1));
        ctx.onTab((i) => i !== page && go(i));
        // Reset max (G-force) / Delete all, pressed twice (Records) / Save last 60 s / Next recording: on the page, or the bar's button
        function act() {
            if (page === 0) { newSession(); return render(); }
            if (page === 2) {
                if (bbDemo()) { demoList.unshift(demoEntry('mark', Date.now() - 15000)); pin = keyOf(demoList[0]); }
                else if (settings.get('bbRecord')) {
                    // a recording already being taken goes on and is the one that gets saved
                    bb.rec.event('mark');
                    const o = bb.rec.open;
                    pin = o ? o.at + ':' + o.kind : null; pinWait = !!o;
                }
                sel = 0; return go(3);
            }
            if (page === 3 || page === 4) {
                const l = bbList();
                choose(l);
                sel = l.length ? (sel + 1) % l.length : 0; pin = keyOf(l[sel]); pinWait = false;
                return render();
            }
            if (page === 5) return go(0);
            if (!clearArmed) { clearArmed = setTimeout(() => { clearArmed = null; actionLabel(); }, 5000); return actionLabel(); }
            clearTimeout(clearArmed); clearArmed = null;
            const R = car.data().demo ? demoRec : rec;
            Object.keys(R).forEach((k) => delete R[k]);
            if (R === rec) saveSoon();
            actionLabel(); return render();
        }
        ui.onClick('BTN_ACTION', act);
        ctx.hideButton('BTN_ACTION');
        // every screen refresh (60 fps) with the GPU renderer; 10 fps in software (PNG frames)
        /** Settings > Results as QR: the all-time records and this session as plain text a phone camera reads (kit/qrlog.js). */
        function resultsText() {
            const qrDate = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()); };
            const R = car.data().demo ? demoRec : rec, out = ['Records' + (R === rec ? '' : ' (demo data)')];
            const g = (x) => (x && G.isNum(x.v) ? x.v.toFixed(2) + ' g, ' + qrDate(x.at) : '-');
            out.push('Accelerating: ' + g(R.acc), 'Braking: ' + g(R.brk), 'Left: ' + g(R.left), 'Right: ' + g(R.right), 'Combined: ' + g(R.comb));
            if (R.vmax && G.isNum(R.vmax.v)) out.push('Top speed: ' + Math.round(V(R.vmax.v)) + (mph() ? ' mph' : ' km/h') + ', ' + qrDate(R.vmax.at));
            const p = S.peak;
            out.push('', 'This session (' + Math.round((Date.now() - S.start) / 60000) + ' min)',
                'Accelerating ' + p.acc.toFixed(2) + ' g, braking ' + p.brk.toFixed(2) + ' g, left ' + p.left.toFixed(2) + ' g, right ' + p.right.toFixed(2) + ' g',
                'Combined ' + p.comb.toFixed(2) + ' g, over 0.5 g for ' + Math.round(S.over05) + ' s');
            return out.join('\n');
        }
        if (ctx.settingsRow) {
            ctx.settingsRow({ label: 'Recordings as QR', value: 'The saved list, for a phone camera',
                open: () => qrLogSheet({ title: 'Recordings', plain: true, text: recordingsText, app: 'G-Force', version: ctx.spec.version,
                    help: ['Point the phone camera at the code:', 'it reads as plain text, no app needed.', 'The CSV files stay in the car.'] }) });
            ctx.settingsRow({
                label: 'Results as QR', value: 'For a phone camera, as plain text',
                open: () => qrLogSheet({ title: 'Results as QR', plain: true, text: resultsText, app: 'G-Force', version: ctx.spec.version,
                    help: ['Point the phone camera at the code:', 'it reads as plain text, no app needed.', 'Several pages: one photo each.'] }),
            });
        }
        ctx.loop('MAIN', 10, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

/* Demo (no car, or Settings > Demo data): a made-up drive and three made-up recordings, never saved. */
function demoAt(ms) {
    const s = ms / 1000, p = s % 45;
    let speed = 72 + 30 * Math.sin(s / 11) + 8 * Math.sin(s / 3.7), gLong = 0.12 * Math.cos(s / 11) + 0.06 * Math.cos(s / 3.7);
    // a hard stop from about 20 s into every 45: speed falls by up to 40 km/h and comes back by 40 s
    if (p > 20 && p < 40) speed -= 40 * (p < 25 ? (1 - Math.cos(Math.PI * (p - 20) / 5)) / 2 : (1 + Math.cos(Math.PI * (p - 25) / 15)) / 2);
    if (p > 20 && p < 25) gLong = -0.85 * Math.sin(Math.PI * (p - 20) / 5);
    if (p > 32 && p < 36) gLong = 0.45 * Math.sin(Math.PI * (p - 32) / 4);
    speed = Math.max(0, speed);
    return { t: ms, speed, gLong, gLat: 0.3 * Math.sin(s / 5), rpm: 900 + speed * 27 + Math.max(0, gLong) * 2500, torque: 90 + Math.max(0, gLong) * 420, oil: 98, coolant: 92 };
}
function demoEntry(kind, at) {
    const data = [];
    for (let ms = at - 60000; ms <= at + 15000; ms += 100) data.push(demoAt(ms));
    const sum = BB.summary(data, at);
    return { kind, at, ms: 75000, rows: data.length, vmax: sum.vmax, gMax: sum.gMax, data };
}
function makeDemo() {
    const now = Date.now(), base = now - (now / 1000 % 45) * 1000;
    return [demoEntry('brake', base - 3600000 * 2 + 22000), demoEntry('power', base - 86400000 + 34000), demoEntry('mark', base - 86400000 * 3)];
}
