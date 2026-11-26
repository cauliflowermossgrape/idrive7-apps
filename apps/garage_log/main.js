'use strict';
/**
 * Garage Log - the car's everyday paperwork on the screen: refuels and consumption per tank and per brand, parts and
 * mods fitted with the odometer, washes and paint care with reminders, a parking timer, a ready-to-go check before a
 * trip, odometer milestones and bookmarks of any moment.
 *
 *   - a refuel is seen by itself (the tank level rising while parked) and saved with one tap of Mark, with the brand
 *     and octane from Settings; Next pressed twice drops it (it was not a refuel)
 *   - Parts: Mark pressed twice notes the part chosen in Settings > Part fitted at today's odometer
 *   - Care: Next picks an item, Mark pressed twice marks it done today
 *   - Parking: Next steps the time (15, 30, 60, 120 min), Mark starts or stops the countdown
 *   - Bookmark now (any page): the time, odometer, tank, speed and 12 V charge, to find that moment later
 *   - kept in the app's data folder (garage.json); demo data (demo.js) when no car answers, never saved
 * There is no text input on the head unit, so every entry is made with buttons and the lists in Settings.
 * Reads only what the car sends anyway (SOME/IP signals); nothing is asked of any control unit, nothing written to one.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Garage, CARE } = require('./garage');
const { draw } = require('./view');
const demo = require('./demo');

const W = 1600, H = 520, CONFIRM_MS = 5000;
const TABS = ['Fuel', 'Parts', 'Care', 'Parking', 'Ready?', 'Milestones', 'How it works'];
const PARK = [15, 30, 60, 120];

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const FILE = path.join(ctx.dataDir, 'garage.json');
        let saved = null;
        try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { /* first start */ }
        const garage = new Garage(saved);
        const save = () => { if (!garage.changed) return; garage.changed = false; try { fs.writeFileSync(FILE, JSON.stringify(garage.toJSON())); } catch (e) { log.warn('save: ' + e); } };
        const st = setInterval(save, 20000);
        if (st.unref) st.unref();
        process.on('exit', save);

        // the car: tank, range and odometer (as Live Data reads them), the 12 V charge (as Redline reads it), speed
        const live = { tank: null, range: null, odo: null, soc: null, speed: null, seen: 0 };
        const num = (raw, f, bad) => (typeof raw === 'number' && raw !== bad ? raw * (f || 1) : null);
        const watch = (iface, h) => (ctx.signals && ctx.signals.watch ? Promise.resolve(ctx.signals.watch(iface, '1', h, log)).catch((e) => log.warn(iface + ': ' + (e && e.message || e))) : null);
        watch('de.bmw.infotainment.KombiIF', { statusRangeTankStatus: (v) => {
            if (!v) return;
            const tank = num(v.fluidLevelFuelTank, 1, 255), range = num(v.range, 1, 4095), odo = num(v.mileageKilometre, 1, 16777215);
            if (tank !== null) live.tank = tank;
            if (range !== null) live.range = range;
            if (odo !== null && odo > 0) live.odo = odo;
            live.seen = Date.now();
        } });
        watch('de.bmw.infotainment.vehicle.CDS', { statusBattery2: (v) => { const c = v && v.conditionBatteryChargingCondition; if (G.isNum(c) && c >= 0 && c <= 100) { live.soc = c; live.seen = Date.now(); } } });
        watch('de.bmw.infotainment.vehicle.Vehicle2', { statusCarSpeed2: (v) => { const s = num(v && v.speedVehicleCentreOfGravity, 0.015625, 65535); if (s !== null) { live.speed = s; live.seen = Date.now(); } } });
        const tick = setInterval(() => { if (live.seen) garage.feed(live, Date.now()); }, 2000);
        if (tick.unref) tick.unref();

        const demoOn = () => settings.get('demo') === 'on' || (settings.get('demo') !== 'off' && !live.seen);
        let demoData = null;
        const src = () => {
            if (!demoOn()) return { g: garage, live };
            demoData = demoData || demo.make(Date.now());
            return demoData;
        };

        let page = 0, careSel = 0, armed = null, timer = null;    // timer: { until, min } (not saved: a parked car's session)
        const arm = (key) => { if (armed && armed.key === key && Date.now() - armed.at < CONFIRM_MS) { armed = null; return true; } armed = { key, at: Date.now() }; return false; };
        const note = { text: '', until: 0 };
        const say = (s) => { note.text = s; note.until = Date.now() + 5000; };

        if (ctx.onTab) ctx.onTab((i) => { page = i; armed = null; return render(); });
        ui.onClick('BTN_PREV', () => {
            if (page === 2) careSel = (careSel + CARE.length - 1) % CARE.length;
            else { page = (page + TABS.length - 1) % TABS.length; armed = null; }
            return render();
        });
        ui.onClick('BTN_NEXT', () => {
            const s = src();
            if (page === 0 && s.g.pending) { if (arm('drop')) { if (!demoOn()) s.g.dropRefuel(); else s.g.pending = null; say('Dropped: not a refuel'); } else say('Press Next again: it was not a refuel'); }
            else if (page === 2) careSel = (careSel + 1) % CARE.length;
            else if (page === 3) { const i = PARK.indexOf(settings.get('parkMin')); settings.set('parkMin', PARK[(i + 1) % PARK.length], 'user'); }
            else { page = (page + 1) % TABS.length; armed = null; }
            return render();
        });
        ui.onClick('BTN_MARK', () => {
            const s = src(), g = s.g, now = Date.now(), odo = s.live.odo;
            if (page === 0) {
                if (!g.pending) say('No refuel waiting: it shows by itself after filling up while parked');
                else { const e = g.saveRefuel(settings.get('fuelBrand'), settings.get('octane')); say('Saved: ' + e.litres + ' l'); log.info('refuel saved ' + e.litres + ' l'); }
            } else if (page === 1) {
                const type = settings.get('partType');
                if (arm('part')) { g.markPart(type, odo, now); say(type + ' noted at ' + (G.isNum(odo) ? Math.round(odo) + ' km' : 'today')); } else say('Press Mark again to note: ' + type);
            } else if (page === 2) {
                const c = CARE[careSel];
                if (arm('care' + c[0])) { g.markCare(c[0], odo, now); say(c[1] + ': done today'); } else say('Press Mark again: ' + c[1] + ' done today');
            } else if (page === 3) {
                if (timer) { timer = null; say('Parking timer stopped'); } else { const m = settings.get('parkMin'); timer = { until: now + m * 60000, min: m, from: now }; say('Parking timer: ' + m + ' min'); }
            } else say('Mark works on Fuel, Parts, Care and Parking');
            return render();
        });
        ui.onClick('BTN_BOOKMARK', () => {
            const s = src(), l = s.live;
            const e = s.g.bookmark({ km: G.isNum(l.odo) ? Math.round(l.odo) : null, tank: G.isNum(l.tank) ? Math.round(l.tank) : null,
                speed: G.isNum(l.speed) ? Math.round(l.speed) : null, soc: G.isNum(l.soc) ? Math.round(l.soc) : null }, Date.now());
            log.info('bookmark ' + JSON.stringify(e));
            say('Bookmarked: this moment is on Milestones');
            return render();
        });

        function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg), now = Date.now(), s = src(), d = demoOn();
            // the demo shows a running timer (18 min into an hour); never a real one
            const tm = timer || (d ? { from: now - 18 * 60000 - (now % 60000), until: now + 42 * 60000 - (now % 60000), min: 60 } : null);
            draw(cv, t, page, { g: s.g, live: s.live, now, careSel, timer: tm, parkMin: settings.get('parkMin'), brand: settings.get('fuelBrand'),
                octane: settings.get('octane'), partType: settings.get('partType'), armed: armed && now - armed.at < CONFIRM_MS ? armed.key : null,
                note: now < note.until ? note.text : '', demo: d, spec: ctx.spec });
            G.frame(cv, t, TABS, page, [d && { text: 'DEMO' }, timer && timer.until < now && { text: 'PARKING TIME UP', color: t.crit }]);
            return ui.image('MAIN_GFX', cv);
        }
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
