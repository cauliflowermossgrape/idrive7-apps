'use strict';
/**
 * extras.js - what Service keeps next to the car's own service items, recorded with the car (app.json autostart),
 * with or without the screen: one background for all of it, from the signals the car broadcasts anyway.
 *
 *   My intervals   your own intervals (own_items.js), marked done with the odometer; the drives since each service
 *                  for the wear estimate (own_wear.js); the wheel sets (own_wheels.js)       -> own.json, drives.json
 *   Battery        the starts (battery_log.js): when the engine turned and the charge the car reports    -> starts.json
 *   Garage         refuels seen by themselves, parts and care notes, odometer milestones (garage.js)     -> garage.json
 *
 *   background(bg) -> state = { v, odo(), own, drives, garage, L, battery, volt(v, t), save(), seen() }
 *
 * One set of watches serves all three: the odometer, tank and range (KombiIF statusRangeTankStatus, as Live Data
 * reads it), rpm, oil temperature and the 12 V charge (CDS), speed (Vehicle2), braking (CDS2), torque (FES), and
 * whether the car is locked and left (VehicleCondition).
 * The background asks no control unit anything: no diagnostic link here. The 12 V voltage is read with UDS only
 * while the Battery page shows (battery_read.js, over the page's read-only link in main.js), and those readings come
 * in through state.volt(); a start without the page open is kept from the broadcast signals alone.
 * garage.json is written when something was noted (a refuel, a milestone, a part) and at the end of a drive (the
 * odometer), not while driving.
 */
const fs = require('fs');
const path = require('path');
const Car = require('./kit/car');
const Wear = require('./own_wear');
const { StartLog } = require('./battery_log');
const { Garage } = require('./garage');

const KEEP_DRIVES = 600, G0 = 9.80665, DAY = 86400000;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) || dflt; } catch (e) { return dflt; } };

/* With or without the screen: the drives, the starts, refuels and milestones. Never the demo. */
async function background(bg) {
    const { signals, log } = bg;
    const F = (n) => path.join(bg.dataDir, n);
    const state = {
        own: readJson(F('own.json'), {}),
        drives: readJson(F('drives.json'), []),
        garage: new Garage(readJson(F('garage.json'), null)),
        v: { rpm: null, speed: null, oil: null, gLong: null, torque: null, soc: null, odo: null, tank: null, range: null, left: false, at: 0 },
        battery: { v: null, t: 0, source: null },
    };
    const v = state.v;
    state.seen = () => v.at > 0;
    state.odo = () => v.odo;
    state.saveOwn = () => { try { fs.writeFileSync(F('own.json'), JSON.stringify(state.own)); } catch (e) { log.warn('service: own: ' + e); } };
    const saveGarage = () => {
        const g = state.garage;
        if (!g.changed) return;
        g.changed = false;
        try { fs.writeFileSync(F('garage.json'), JSON.stringify(g.toJSON())); } catch (e) { log.warn('service: garage: ' + e); }
    };
    state.saveGarage = () => { state.garage.changed = true; saveGarage(); };

    const sc = (raw, f, o, bad) => (typeof raw === 'number' && raw !== bad ? raw * f + o : null);
    const seen = () => { v.at = Date.now(); };
    const watch = (iface, h) => (signals && signals.watch ? Promise.resolve(signals.watch(iface, '1', h, log)).catch((e) => log.warn('service: ' + iface + ': ' + (e && e.message || e))) : null);
    watch('de.bmw.infotainment.KombiIF', { statusRangeTankStatus: (x) => {
        if (!x) return;
        const odo = sc(x.mileageKilometre, 1, 0, 16777215), tank = sc(x.fluidLevelFuelTank, 1, 0, 255), range = sc(x.range, 1, 0, 4095);
        if (odo !== null && odo > 0) v.odo = odo;
        if (tank !== null) v.tank = tank;
        if (range !== null) v.range = range;
        seen();
    } });
    const L = new StartLog({ entries: readJson(F('starts.json'), {}).entries, onEntry: (e) => { log.info('service: start ' + JSON.stringify(e)); saveStarts(); } });
    let pick = readJson(F('starts.json'), {}).pick;
    const saveStarts = () => { try { fs.writeFileSync(F('starts.json'), JSON.stringify({ entries: L.entries, pick })); } catch (e) { log.warn('service: starts: ' + e); } };
    state.L = L;
    watch('de.bmw.infotainment.vehicle.CDS', {
        statusEngineSpeed2: (x) => { v.rpm = sc(x && x.actualValueRPMEngineCrankshaft, 0.25, 0, 65535); if (v.rpm !== null) { L.rpm(v.rpm, Date.now()); seen(); } },
        statusEngineTemperature: (x) => { v.oil = sc(x && x.temperatureEngineOilDrive, 1, -48, 255); },
        statusBattery2: (x) => { const s = x && x.conditionBatteryChargingCondition; if (isNum(s) && s >= 0 && s <= 100) { v.soc = s; L.soc(s); } },
    });
    watch('de.bmw.infotainment.vehicle.Vehicle2', { statusCarSpeed2: (x) => { v.speed = sc(x && x.speedVehicleCentreOfGravity, 0.015625, 0, 65535); if (v.speed !== null) seen(); } });
    watch('de.bmw.infotainment.vehicle.CDS2', {
        statusLongitudinalAccelerationMassCenter: (x) => { const a = sc(x && x.longitudinalAccelerationCentreOfGravity, 0.002, -65, 65535); v.gLong = a === null ? null : a / G0; },
    });
    watch('de.bmw.infotainment.drivingexcitement.FES', {
        statusActualValueTorque2: (x) => { const raw = x && x.actualValueTorqueCrankshaft; v.torque = typeof raw === 'number' && raw < 4095 ? raw * 0.5 - 1023.5 : null; },
    });
    watch('de.bmw.infrastructure.VehicleCondition', {
        VehicleCondition: (x) => { const n = Car.conditionOf(x && x.statusConditionVehicle); if (n !== undefined) v.left = n <= 3; },
    });

    // the drives (wear estimate) and the garage (refuels, milestones)
    const rec = new Wear.DriveRecorder();
    rec.onDrive = (d) => {
        state.drives = state.drives.concat([d]).slice(-KEEP_DRIVES);
        try { fs.writeFileSync(F('drives.json'), JSON.stringify(state.drives)); } catch (e) { log.warn('service: drives: ' + e); }
        log.info('service: drive ' + d.km + ' km, oil max ' + d.maxOil);
        state.garage.changed = true;          // the odometer is kept at the end of a drive
        saveGarage();
    };
    let n = 0;
    const tick = () => {
        if (!v.at) return;
        const kw = isNum(v.torque) && isNum(v.rpm) ? v.torque * v.rpm / 9549 : null;
        rec.sample({ speed: v.speed, rpm: v.rpm, oil: v.oil, gLong: v.gLong, kw });
        if (++n % 2 === 0) state.garage.feed({ speed: v.speed, tank: v.tank, odo: v.odo }, Date.now());
        if (n % 20 === 0) saveGarage();
    };
    const timer = setInterval(tick, 1000);
    if (timer.unref) timer.unref();
    state.tick = tick;
    state.rec = rec;

    // the 12 V voltage: read by the Battery page (battery_read.js), never here; its readings come in through volt()
    state.volt = (x, t) => {
        if (!isNum(x)) return;
        t = isNum(t) ? t : Date.now();
        state.battery.every = state.battery.t ? t - state.battery.t : null;
        state.battery.v = x; state.battery.t = t; L.volt(x, t);
    };
    // the candidate that answered last (tried first next time), kept in starts.json
    state.pick = () => pick;
    state.setPick = (i, key) => { state.battery.source = key; if (pick !== i) { pick = i; log.info('service: 12 V from ' + key); saveStarts(); } };
    state.stop = () => { clearInterval(timer); rec.flush(); L.finish(); saveGarage(); };
    process.on('exit', () => { rec.flush(); L.finish(); saveGarage(); });
    return state;
}

/* ---------- demo (no car, or Settings > Demo data): made up, never saved ---------- */
const DEMO_ODO = 49650;
function demoOwn(now) {
    const d = (days) => now - days * DAY;
    const h = (list) => ({ km: list[list.length - 1][0], at: list[list.length - 1][1], history: list.map((x) => ({ km: x[0], at: x[1] })) });
    return {
        oil: h([[18200, d(1460)], [27900, d(1100)], [33600, d(760)], [40400, d(300)]]),
        plugs: h([[12000, d(1250)]]),
        padsFront: h([[9800, d(1300)], [46500, d(120)]]),
        padsRear: h([[11000, d(1280)]]),
        gearbox: h([[30500, d(900)]]),
        brakeFluid: h([[30000, d(760)]]),
        // the winter set went on 60 km ago: the bolts reminder shows
        wheels: { swaps: [['winter', 24000, 1110], ['summer', 30200, 950], ['winter', 36900, 580], ['summer', 43100, 220], ['winter', 49590, 4]]
            .map((x) => ({ set: x[0], km: x[1], at: d(x[2]) })) },
    };
}
/* drives since 1 300 days ago: mostly town, short cold trips in winter, a few motorway runs */
function demoDrives(now) {
    const out = [];
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let d = 1300; d > 0; d -= 1 + Math.floor(rnd() * 2)) {
        const kind = rnd(), km = kind < 0.45 ? 2 + rnd() * 6 : kind < 0.85 ? 8 + rnd() * 25 : 60 + rnd() * 140;
        const movingS = km / (kind < 0.45 ? 24 : kind < 0.85 ? 40 : 95) * 3600;
        out.push({ at: now - d * DAY, km: Math.round(km * 10) / 10, maxOil: kind < 0.45 ? 55 + rnd() * 40 : 92 + rnd() * 20,
            movingS: Math.round(movingS), slowS: Math.round(movingS * (kind < 0.85 ? 0.3 + rnd() * 0.25 : 0.04)),
            hotS: kind > 0.95 ? Math.round(rnd() * 240) : 0, hardStops: rnd() < 0.18 ? 1 + Math.floor(rnd() * 2) : 0,
            highS: kind > 0.85 ? Math.round(movingS * rnd() * 0.12) : Math.round(movingS * rnd() * 0.02) });
    }
    return out;
}
/* sixty starts over four months, slowly weakening, and this wake */
function demoStarts(now) {
    const out = [];
    for (let i = 0; i < 60; i++) {
        const k = i / 59, cold = Math.max(0, Math.sin(i / 9)) * 0.12;
        out.push({ at: now - (60 - i) * 2 * DAY + 7.5 * 3600000, rest: 12.66 - 0.2 * k - cold * 0.6 + 0.03 * Math.sin(i * 1.7),
            crank: 10.55 - 0.45 * k - cold + 0.08 * Math.sin(i * 2.3), crankN: 6, run: 13.9 + 0.5 * Math.sin(i * 0.8), soc: Math.round(84 - 8 * k - cold * 30) });
    }
    return out;
}
function demoWake(now) {
    const t0 = now - 8 * 60000, start = t0 + 70000, trace = [];
    for (let t = t0; t <= now; t += 1000) {
        const s = (t - start) / 1000;
        const x = s < 0 ? 12.46 + 0.01 * Math.sin(t / 7000) : s < 2 ? 10.25 + 0.6 * s : s < 120 ? 14.6 - 0.3 * (s / 120) : (Math.floor(s / 40) % 3 === 2 ? 12.75 : 14.25) + 0.03 * Math.sin(t / 3000);
        trace.push({ t, v: x });
    }
    const runs = trace.filter((q) => q.t - start > 60000).map((q) => q.v);
    return { trace, startAt: start, cur: { rest: 12.46, crank: 10.25, crankN: 7, runs, at: start }, v: trace[trace.length - 1].v };
}
/* a year of refuels at two stations, parts and care noted, odometer milestones, a refuel waiting for its tap */
function demoGarage(now) {
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const odo = DEMO_ODO, fuel = [], brands = ['usual', 'second', 'usual'];
    let km = odo - 9800;
    for (let i = 0; i < 14; i++) {
        const dist = Math.round(560 + rnd() * 160), brand = brands[i % 3], k = brand === 'usual' ? 7.4 : 7.8;
        km += dist;
        if (km > odo - 120) break;
        const litres = Math.round(dist * (k + (rnd() - 0.5) * 0.8) / 100), before = Math.round(8 + rnd() * 6);
        fuel.push({ at: now - (odo - km) / 52 * DAY, km, before, after: before + litres, litres, brand, octane: i % 4 === 3 ? 98 : 95 });
    }
    const parts = [['Oil and filter', 36200, 290], ['Brake pads', 39800, 220], ['Intake', 41500, 180], ['Tune / map', 41520, 179],
        ['Tyres', 43900, 120], ['Battery', 45100, 90], ['Care', 46200, 60], ['Cabin filter', 46900, 40], ['Oil and filter', 47800, 15]]
        .map(([type, k, d]) => ({ type, km: k, at: now - d * DAY }));
    const milestones = [10000, 20000, 30000, 40000].map((k, i) => ({ km: k, at: now - (odo - k) / 48 * DAY + i * DAY }));
    return new Garage({ fuel, parts, milestones, lastOdo: odo, pending: { at: now - 40 * 60000, km: odo, before: 9, after: 55, litres: 46 } });
}
function demo(now) {
    const w = demoWake(now);
    return {
        own: demoOwn(now), drives: demoDrives(now), garage: demoGarage(now), L: { entries: demoStarts(now), trace: w.trace, startAt: w.startAt, phase: () => 'run', current: () => w.cur },
        v: { odo: DEMO_ODO, tank: 55, range: 690, soc: 81, speed: 0 }, battery: { v: w.v, source: null }, odo: () => DEMO_ODO, demo: true,
    };
}

module.exports = { background, demo, DEMO_ODO };
