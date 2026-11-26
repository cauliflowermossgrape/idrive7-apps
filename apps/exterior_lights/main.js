'use strict';
/**
 * Exterior Lights - a light show and dark headlights for private ground and car meets, with the car parked.
 *
 * Tabs: Safety (the checks, the lamps found, STOP), Stealth (the headlights dark), Show (six sequences on a beat grid,
 * played on the body controller's light functions), Coding (what needs coding instead, and why this app does not
 * write it), How it works. A safety note must be accepted first; until then nothing is asked of the car.
 *
 * Every run (lamps.js, on Ambient config's strobe.js) checks before each step: the note accepted, the car standing
 * still (kit/parked.js, above 3 km/h counts as moving), no door open, the car not locked and left, the 12 V battery
 * above the setting, not the demo. One fails: it stops and gives the lamps back. It runs only while the app runs (no
 * autostart); if the app goes, the units leave their test session by themselves a few seconds later.
 * Demo (no diagnostic transport, or Settings > Demo data): everything is drawn, nothing is sent.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Diag } = require('./kit/diag');
const Car = require('./kit/car');
const Parked = require('./kit/parked');
const { Lamps, stealthWhy, playWhy } = require('./lamps');
const P = require('./presets');
const { draw } = require('./view');

const W = 1600, H = 520;
const TABS = ['Safety', 'Stealth', 'Show', 'Coding', 'How it works'];
const DOOR_FIELDS = { statusDoorSwitchDRD: 'driver front', statusDoorSwitchPSD: 'passenger front', statusDoorSwitchDRDR: 'driver rear',
    statusDoorSwitchPSDR: 'passenger rear' };
const doorsOf = (v) => Object.keys(DOOR_FIELDS).filter((k) => v && (v[k] === 1 || /_OFFEN$/.test(String(v[k])))).map((k) => DOOR_FIELDS[k]);
const BEAT_STEPS = [200, 250, 300, 400, 500];

/** The checks: [{ title, value, ok (true / false / null unknown), sub, why (when it blocks) }]. */
function gatesOf(s) {
    const g = [];
    g.push({ title: 'SAFETY NOTE', value: s.accepted ? 'Accepted' : 'Not accepted', ok: s.accepted, why: 'the safety note is not accepted' });
    const spd = s.speed;
    g.push({ title: 'CAR STANDING STILL', value: spd === null ? 'No speed read' : Math.round(spd) + ' km/h', ok: spd === null ? null : !s.moving,
        sub: 'above 3 km/h stops everything', why: s.moving ? 'the car is moving' : null });
    g.push({ title: 'DOORS', value: s.doors.length ? s.doors.length + ' open' : 'All closed', ok: !s.doors.length,
        sub: s.doors.length ? s.doors.join(', ') : 'a door opening stops it', why: s.doors.length ? 'a door is open (' + s.doors[0] + ')' : null });
    g.push({ title: 'CAR IN USE', value: s.away ? 'Locked and left' : 'Yes', ok: !s.away, sub: 'locked and left stops it', why: s.away ? 'the car is locked and left' : null });
    const b = s.battery;
    g.push({ title: '12 V BATTERY', value: b === null ? 'Not read' : Math.round(b) + ' %', ok: b === null ? null : b >= s.minBattery,
        sub: 'needs ' + s.minBattery + ' % or more', why: b !== null && b < s.minBattery ? 'the 12 V battery is at ' + Math.round(b) + ' %' : null });
    g.push({ title: 'LAMPS', value: s.demo ? 'Demo' : s.lampsShort, ok: s.demo ? null : s.lampsOk, sub: s.demo ? 'nothing is sent in the demo' : 'found by reading only' });
    return g;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, signals, log } = ctx;
        const diag = await new Diag(signals, log).init();
        diag.quiet = true; diag.busyLog = false;
        const parked = Parked.watch(ctx, log);
        const car = { doors: [], away: false, battery: null };
        const watch = (iface, h) => Promise.resolve(signals.watch(iface, '1', h, log)).catch((e) => log.warn(iface + ': ' + (e && e.message || e)));
        const conditionFrom = (v) => {
            const n = Car.conditionOf(v && v.statusConditionVehicle);
            if (n !== undefined) return n;
            const p = v && v.controlBasePartialNetworks;
            if (p === 0 || p === 'KEINE_KOMMUNIKATION') return 1;
            return Car.conditionOf(typeof p === 'string' ? p.replace(/^KOM_/, '') : p);
        };
        const onCondition = (v) => { const n = conditionFrom(v); if (n !== undefined) car.away = n <= 3; };
        watch('de.bmw.infrastructure.VehicleCondition', { VehicleCondition: onCondition, vehicleConditionNoCrc: onCondition });
        watch('de.bmw.body.DoorsWindowsRoofMirrors', { CentralLockingSystemAndPanelStatus: (v) => { car.doors = doorsOf(v); } });
        watch('de.bmw.infotainment.vehicle.CDS', {
            statusBattery2: (v) => { const c = v && v.conditionBatteryChargingCondition; if (G.isNum(c) && c >= 0 && c <= 100) car.battery = c; },
        });

        const demo = () => settings.get('demo') === 'on' || (settings.get('demo') !== 'off' && !diag.available);
        const minBattery = () => +settings.get('minBattery') || 50;
        let lamps = null;
        const lampsText = () => (demo() ? 'Demo: no lamps asked' : !lamps || finding ? 'Looking for the lamps (reads only)...'
            : (lamps.kind ? 'Show: ' + lamps.kindName : 'Show: no light functions') + ' / ' + (lamps.headKind ? 'Stealth: ' + lamps.headKind.toUpperCase() : 'no headlight unit'));
        const state = () => ({ accepted: settings.get('accepted') === true, speed: parked.speed(), moving: parked.moving(), doors: car.doors,
            away: car.away, battery: car.battery, minBattery: minBattery(), demo: demo(),
            lampsShort: finding ? 'Looking...' : lamps && (lamps.kind || lamps.headKind) ? 'Found' : 'None found', lampsOk: finding ? null : !!(lamps && (lamps.kind || lamps.headKind)) });
        /** null: may run; else why not (checked by lamps.js before each step). */
        const allowed = () => {
            if (demo()) return 'demo: nothing is sent';
            const bad = gatesOf(state()).find((x) => x.ok === false && x.why);
            return bad ? bad.why : null;
        };
        lamps = new Lamps({ diag, log, allowed });
        let finding = false;
        const findLamps = async () => {
            if (finding || demo() || settings.get('accepted') !== true || lamps.kind || lamps.headKind) return;
            finding = true;
            try { await lamps.find(); await lamps.findHeads(); } catch (e) { log.warn('lamps: ' + e); } finally { finding = false; }
        };
        diag.on('available', (a) => { if (a) findLamps(); });
        findLamps();
        const stopAll = () => { lamps.stop(); demoUntil = 0; demoStealthUntil = 0; return render(); };
        process.on('exit', () => lamps.stop());

        const file = path.join(ctx.dataDir || '.', 'presets.json');
        const presets = P.load(file);
        let page = 0, slot = 0, demoUntil = 0, demoStealthUntil = 0;
        const accept = () => { settings.set('accepted', true); findLamps(); return render(); };
        const play = () => {
            if (demo()) { demoUntil = Date.now() + presets[slot].beatMs * P.BEATS * 2; return render(); }
            lamps.play(presets[slot].beats, { beatMs: presets[slot].beatMs, loops: 2 }).catch((e) => log.warn('show: ' + e));
            return render();
        };
        const startStealth = () => {
            const ms = (+settings.get('stealthMin') || 5) * 60000;
            if (demo()) { demoStealthUntil = Date.now() + ms; return render(); }
            lamps.stealth({ ms }).catch((e) => log.warn('stealth: ' + e));
            stealthUntil = Date.now() + ms;
            return render();
        };
        let stealthUntil = 0;
        const pick = (i) => { slot = i; return render(); };
        const toggle = (b, fn) => { P.toggle(presets[slot], b, fn); P.save(file, presets); return render(); };
        const beatLen = () => { const p = presets[slot]; p.beatMs = BEAT_STEPS[(BEAT_STEPS.indexOf(p.beatMs) + 1) % BEAT_STEPS.length]; P.save(file, presets); return render(); };

        ui.onClick('BTN_STOP', stopAll);
        ui.onClick('BTN_ACCEPT', accept);
        ui.onClick('BTN_PLAY', () => { page = 2; return lamps.running === 'show' || Date.now() < demoUntil ? stopAll() : play(); });
        ui.onClick('BTN_STEALTH', () => { page = 1; return lamps.running === 'stealth' || Date.now() < demoStealthUntil ? stopAll() : startStealth(); });
        ui.onClick('BTN_NEXT', () => { page = 2; return pick((slot + 1) % P.SLOTS); });
        if (ctx.onTab) ctx.onTab((i) => { page = i; return render(); });

        function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), now = Date.now(), st = state(), d = st.demo;
            const p = presets[slot];
            const playing = lamps.running === 'show' || (d && now < demoUntil);
            const stealthOn = lamps.running === 'stealth' || (d && now < demoStealthUntil);
            const beat = lamps.running === 'show' && G.isNum(lamps.beat) ? lamps.beat : Math.floor(now / p.beatMs) % P.BEATS;
            const blocked = allowed();
            const s = Object.assign(st, {
                gates: gatesOf(st), running: lamps.running || (d && now < demoUntil ? 'show (demo)' : d && now < demoStealthUntil ? 'stealth (demo)' : null),
                lampsText: lampsText(), note: lamps.note, noteType: lamps.noteType, stop: stopAll, accept,
                stealthOn, demoStealth: false, stealthWhy: d ? null : stealthWhy(lamps), headName: lamps.headKind ? lamps.headKind.toUpperCase() : '',
                stealthMin: +settings.get('stealthMin') || 5, stealthLeftMs: (d ? demoStealthUntil : stealthUntil) - now, startStealth,
                blocked: d ? null : blocked, preset: p, presets, slot, beat, playing, lit: P.lit(p, beat), pick, toggle, beatLen, play,
                playBlocked: d ? null : playWhy(lamps) || blocked,
            });
            draw(cv, t, page, s);
            G.frame(cv, t, TABS, page, [d && { text: 'DEMO' }, s.running && { text: 'RUNNING', color: t.crit }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 8, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});

module.exports = { gatesOf, doorsOf };
