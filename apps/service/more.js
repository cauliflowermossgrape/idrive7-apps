'use strict';
/**
 * more.js - Service's own pages next to BMW's service items: what you follow yourself, recorded by extras.js.
 *
 *   Intervals      your own intervals (Overview / History / Driving): engine oil every 7 000 km instead of the car's
 *                  15 000 or more, spark plugs, gearbox oil, brake pads, filters, brake fluid by months; marked done
 *                  with the odometer; how hard the driving since each service was on it (an estimate). They are also
 *                  listed on the Service page under the car's own items, marked YOUR OWN, once one is marked done.
 *   Wheels         which set is on since when, km per set, tread depth, the bolts reminder after a swap
 *   Battery        the 12 V battery at every start (Today / History): resting, the dip while starting, charging
 *   Fuel           refuels seen by themselves, saved with one tap, consumption per tank and per brand
 *   Garage         parts and mods fitted, wash and paint care, odometer milestones (Parts / Care / Milestones)
 *   How it works   the same in plain words
 *
 *   create(ctx, changed) -> { TABS, has(name), draw(cv, t, name), rows(carDemo), openOwn(row), markOwn(key),
 *                             select(name), nextView(name), act(name), extraDemo() }
 *
 * Where the kit runs the screen (cv.own) everything is on the page: tap a card or a row, the view switch on the
 * top right, buttons that confirm with a second press. Elsewhere the bar's buttons do the same: Next item chooses,
 * Details switches the view, Reset service marks (twice). Nothing here is written to the car: BMW's own service
 * display and its resets stay as they are; these are the app's own lists in its data folder.
 */
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { ITEMS, status } = require('./own_items');
const Wear = require('./own_wear');
const Wheels = require('./own_wheels');
const OwnView = require('./own_view');
const BatteryView = require('./battery_view');
const GarageView = require('./garage_view');
const { Garage, CARE } = require('./garage');
const { StartLog } = require('./battery_log');
const Extras = require('./extras');

const TABS = ['Intervals', 'Wheels', 'Battery', 'Fuel', 'Garage', 'How it works'];
const VIEWS = {
    Intervals: [['overview', 'Overview'], ['history', 'History'], ['driving', 'Driving']],
    Battery: [['today', 'Today'], ['history', 'History']],
    Garage: [['parts', 'Parts'], ['care', 'Care'], ['milestones', 'Milestones']],
};
const CONFIRM_MS = 5000, DEMO_MS = 60000, DAY = 86400000, MONTH = 30.44 * DAY;
const STATE_COLOUR = { due: 1, soon: 2, ok: 3, unknown: 0 };

function create(ctx, changed) {
    const { settings, log } = ctx;
    const bg = ctx.background && ctx.background.own ? ctx.background : null;
    // without the background (safe mode, or no car): an empty stand-in, so Demo data "Never" shows honest empty pages
    const none = { own: {}, drives: [], garage: new Garage(null), L: new StartLog({}), v: {}, battery: {}, odo: () => null };
    const real = bg || none;
    const extraDemo = () => settings.get('demo') === 'on' || (settings.get('demo') !== 'off' && !(bg && bg.seen()));
    let demoData = null, demoAt = 0;
    const demoSrc = () => {
        const now = Date.now();
        if (!demoData) demoData = Extras.demo(now);
        else if (now - demoAt > DEMO_MS) { const d = Extras.demo(now); demoData.L = d.L; demoData.battery = d.battery; }   // (the wake's chart moves on; marks stay)
        if (now - demoAt > DEMO_MS) demoAt = now;
        return demoData;
    };
    const src = (demo) => (demo === undefined ? extraDemo() : demo) ? demoSrc() : real;
    const save = (s) => { if (s === real && bg) bg.saveOwn(); };

    const view = { Intervals: 0, Battery: 0, Garage: 0 };
    let sel = 0, wheelPick = 0, careSel = 0, armed = null, note = '', noteUntil = 0;
    const say = (s) => { note = s; noteUntil = Date.now() + 4000; changed(); };
    const noteNow = () => (Date.now() < noteUntil ? note : '');
    /** Pressed twice within CONFIRM_MS: true the second time (bar buttons and the cards; on-screen buttons confirm themselves). */
    const arm = (key) => {
        if (armed && armed.key === key && Date.now() - armed.at < CONFIRM_MS) { armed = null; return true; }
        armed = { key, at: Date.now() }; changed(); return false;
    };
    const armedKey = () => (armed && Date.now() - armed.at < CONFIRM_MS ? armed.key : null);
    const viewOf = (name) => (VIEWS[name] ? VIEWS[name][view[name] % VIEWS[name].length][0] : null);

    /* ---------- own intervals ---------- */
    const shown = () => ITEMS.filter((it) => settings.get(it.setting) > 0);
    function states(s, now) {
        const o = s.odo();
        return shown().map((it) => {
            const every = settings.get(it.setting), done = OwnView.record(s.own, it.key);
            return { it, every, done, s: status(it, every, done, o, now) };
        });
    }
    const wearOf = (s) => (it, done) => Wear.estimate(it, (s.drives || []).filter((d) => !done || d.at > done.at));
    function markOwn(key, s) {
        s = s || src();
        const it = ITEMS.find((x) => x.key === key), o = s.odo();
        if (!it) return false;
        if (it.unit === 'km' && !G.isNum(o)) { say('Waiting for the odometer from the car'); return false; }
        const r = OwnView.record(s.own, it.key) || { history: [] }, entry = { km: G.isNum(o) ? o : null, at: Date.now() };
        r.km = entry.km; r.at = entry.at; r.history = r.history.concat([entry]).slice(-30);
        s.own[it.key] = r;
        save(s);
        log.info('service: own ' + it.key + ' done at ' + o + ' km' + (s.demo ? ' (demo)' : ''));
        say(it.name + ' marked serviced at ' + (G.isNum(o) ? OwnView.km(o) + ' km' : 'today'));
        return true;
    }

    /** The own items for the Service page: none until one is marked done (or in the Service page's demo). */
    function rows(carDemo) {
        const s = src(!!carDemo), now = Date.now();
        if (!carDemo && !ITEMS.some((it) => s.own[it.key])) return [];
        return states(s, now).map((x) => ({
            own: true, key: 'own-' + x.it.key, ownKey: x.it.key, name: x.it.name, native: false,
            colour: STATE_COLOUR[x.s.state] || 0, state: x.s.state,
            way: OwnView.leftLine(x),
            date: x.it.unit === 'months' && x.done ? OwnView.day(x.done.at + x.every * MONTH)
                : 'every ' + (x.it.unit === 'km' ? OwnView.km(x.every) + ' km' : x.every + ' months'),
            demo: !!carDemo,
        }));
    }
    /** An own row's card (where the kit runs the screen): what is left, the interval, the last service, Done now. */
    function openOwn(row, cardSheet) {
        if (!ctx.sheet || !cardSheet) return false;
        const s = src(row.demo), it = ITEMS.find((x) => x.key === row.ownKey);
        const cur = () => states(s, Date.now()).find((x) => x.it.key === row.ownKey);
        const card = cardSheet({
            title: it.name, heading: it.name,
            subtitle: 'Your own interval (kept by this app, not BMW\'s)',
            color: () => { const x = cur(); const c = x && x.s.state; return c === 'due' ? '#ef2b2d' : c === 'soon' ? '#ffb020' : c === 'ok' ? '#2fd27a' : null; },
            rows: () => {
                const x = cur();
                if (!x) return [['Interval', 'off']];
                const w = wearOf(s)(x.it, x.done);
                return [
                    [x.s.left > 0 || x.s.state === 'unknown' ? 'Left' : 'Overdue', x.s.state === 'unknown' ? (x.done ? 'no odometer' : 'not marked') : OwnView.leftLine(x).replace(/ (left|overdue)$/, '')],
                    ['Every', x.it.unit === 'km' ? OwnView.km(x.every) + ' km' : x.every + ' months'],
                    ['Last done', x.done ? OwnView.day(x.done.at) : '--'],
                    w.applies && w.enough ? ['Wear since', w.extra >= 1 ? '+' + Math.round(w.extra) + ' %' : 'normal'] : null,
                ];
            },
            note: () => {
                const x = cur(), at = x && x.done && G.isNum(x.done.km) ? 'Last done at ' + OwnView.km(x.done.km) + ' km. ' : '';
                return noteNow() || at + (armedKey() === 'own' + row.ownKey ? 'Press Confirm to mark it serviced today.' : 'Done now marks it serviced today, with the odometer.');
            },
            actions: () => [{
                label: armedKey() === 'own' + row.ownKey ? 'Confirm' : 'Done now',
                color: armedKey() === 'own' + row.ownKey ? '#ef2b2d' : null,
                run: () => { if (arm('own' + row.ownKey)) markOwn(row.ownKey, s); return null; },
            }],
        });
        card.onClose = () => { armed = null; changed(); };
        return !!ctx.sheet(card);
    }

    /* ---------- the pages ---------- */
    function viewSwitch(cv, t, name) {
        const v = VIEWS[name];
        if (!v) return;
        const w = 132 * v.length;
        if (cv.own) G.segment(cv, t, 1566 - w, 50, w, 34, v.map((x, i) => ({ label: x[1], on: i === view[name] % v.length, key: 'view-' + name + i,
            run: () => { view[name] = i; armed = null; changed(); return null; } })));
        else cv.text(v[view[name] % v.length][1].toUpperCase() + ' ' + (view[name] % v.length + 1) + '/' + v.length + ', DETAILS: NEXT VIEW',
            1552, 72, 14, t.dim, { align: 'right', font: 'bold', spacing: 1.5 });
    }

    function drawIntervals(cv, t, s, now) {
        const l = states(s, now);
        if (sel >= l.length) sel = 0;
        OwnView.draw(cv, t, viewOf('Intervals'), { l, sel, armed: armedKey() === 'own' + (l[sel] && l[sel].it.key), note: noteNow(), odo: s.odo(), store: s.own, now,
            wearOf: wearOf(s), act: { pick: (i) => { sel = i; armed = null; changed(); return null; }, done: () => { const x = l[sel]; if (x) markOwn(x.it.key, s); return null; } } });
    }
    function drawWheels(cv, t, s, now) {
        const sets = Wheels.setsOn(settings), pick = wheelPick % sets.length, live = armedKey() === 'wheels';
        Wheels.draw(cv, t, { w: s.own.wheels, odo: s.odo(), sets, pick, armed: live, settings,
            note: noteNow() || (cv.own ? 'Tap the set that is on the car now, then tap it again to confirm.' : '') });
        if (cv.own) sets.forEach((x, i) => cv.target(48 + i * 236, 404, 224, 50, () => {
            if (i !== pick) { wheelPick = i; armed = null; }
            wheelPress(s);
            return null;
        }, 'wheel-set-' + x.key, 10));
    }
    function wheelPress(s) {
        const sets = Wheels.setsOn(settings), set = sets[wheelPick % sets.length];
        if (!G.isNum(s.odo())) { say('Waiting for the odometer from the car'); return; }
        if (!arm('wheels')) { say('Press again: ' + set.name + ' wheels on the car today'); return; }
        s.own.wheels = Wheels.swap(s.own.wheels, set.key, s.odo(), Date.now());
        save(s);
        log.info('service: ' + set.key + ' wheels on at ' + s.odo() + ' km' + (s.demo ? ' (demo)' : ''));
        say(set.name + ' wheels marked on at ' + OwnView.km(s.odo()) + ' km');
    }
    function drawBattery(cv, t, s, now) {
        const L = s.L, b = s.battery || {}, v = s.v || {};
        if (!s.demo) b.shownT = now;            // (the background reads the 12 V voltage while this page shows)
        BatteryView.draw(cv, t, viewOf('Battery'), { live: { v: b.v, soc: v.soc }, phase: L.phase(), cur: L.current(), trace: L.trace || [], startAt: L.startAt,
            entries: L.entries || [], source: b.source, now });
    }
    function garageState(s, now) {
        const g = s.garage, odo = s.odo();
        return { g, live: Object.assign({}, s.v, { odo }), now, careSel, brand: settings.get('fuelBrand'), octane: settings.get('octane'),
            partType: settings.get('partType'), armed: armedKey(), note: noteNow(), spec: ctx.spec,
            act: {
                save: () => { saveRefuel(s); return null; },
                drop: () => { dropRefuel(s); return null; },
                part: () => { notePart(s); return null; },
                care: (i) => { careDone(s, i); return null; },
                pick: (i) => { careSel = i; armed = null; changed(); return null; },
            } };
    }
    const keepGarage = (s) => { if (s === real && bg) bg.saveGarage(); };
    function saveRefuel(s) {
        const g = s.garage;
        if (!g.pending) { say('No refuel waiting: it shows by itself after filling up while parked'); return; }
        const e = g.saveRefuel(settings.get('fuelBrand'), settings.get('octane'));
        keepGarage(s); log.info('service: refuel saved ' + e.litres + ' l'); say('Saved: ' + e.litres + ' l');
    }
    function dropRefuel(s) { if (!s.garage.pending) return; s.garage.dropRefuel(); keepGarage(s); say('Dropped: not a refuel'); }
    function notePart(s) {
        const type = settings.get('partType'), odo = s.odo();
        s.garage.markPart(type, odo, Date.now()); keepGarage(s);
        say(type + ' noted at ' + (G.isNum(odo) ? OwnView.km(odo) + ' km' : 'today'));
    }
    function careDone(s, i) {
        const c = CARE[i];
        if (!c) return;
        s.garage.markCare(c[0], s.odo(), Date.now()); keepGarage(s); say(c[1] + ': done today');
    }

    function help(cv, t) {
        G.panel(cv, t, 24, 44, 1552, 468, 'How your own pages work');
        [
            ['Your own intervals, next to BMW\'s.', 'Set them in Settings (engine oil every 7 000 km, brake fluid every 24 months; 0 is off). Once one is marked done it is also on the Service page, marked YOUR OWN.'],
            ['Mark what was done.', (cv.own ? 'Tap the card, then Done now and Confirm.' : 'Next item picks it, Reset service twice marks it.') + ' It is saved with today\'s date and odometer; History charts the km between services.'],
            ['How hard the driving was.', 'Every drive is counted in the background: short cold trips, stop and go, hot oil, hard braking, high load. Driving shows the extra wear: an estimate, not BMW data.'],
            ['Wheels and the 12 V battery.', 'Mark the set that goes on, for km per set and the bolts reminder. At every start the battery\'s resting, starting and charging voltage go in its diary.'],
            ['Fuel and the garage.', 'A refuel is seen by itself (the tank level rising while parked) and saved with one tap. Parts, care and every 10 000 km keep their dates.'],
        ].forEach((r, i) => {
            const yy = 124 + i * 72;
            cv.circle(70, yy - 8, 20, withAlpha(t.accent, 0.3));
            cv.text(String(i + 1), 70, yy, 22, t.text, { align: 'center', font: 'bold' });
            cv.text(r[0], 108, yy, 23, t.text, { font: 'bold' });
            cv.text(r[1], 108, yy + 30, 17, t.dim);
        });
        cv.text('Read only: the odometer, tank, speed and engine signals the car sends anyway, and the 12 V voltage by UDS. Nothing is written to the car.', 48, 496, 16, t.dim);
    }

    function draw(cv, t, name) {
        const now = Date.now(), s = src();
        if (name === 'Intervals') drawIntervals(cv, t, s, now);
        else if (name === 'Wheels') drawWheels(cv, t, s, now);
        else if (name === 'Battery') drawBattery(cv, t, s, now);
        else if (name === 'Fuel') GarageView.draw(cv, t, 'fuel', garageState(s, now));
        else if (name === 'Garage') GarageView.draw(cv, t, viewOf('Garage'), garageState(s, now));
        else help(cv, t);
        viewSwitch(cv, t, name);
    }

    /* ---------- the bar's buttons (where the kit does not run the screen) ---------- */
    function select(name) {
        const s = src();
        armed = name === 'Fuel' ? armed : null;
        if (name === 'Intervals') { const n = shown().length; if (n) sel = (sel + 1) % n; }
        else if (name === 'Wheels') wheelPick = (wheelPick + 1) % Wheels.setsOn(settings).length;
        else if (name === 'Fuel') { if (s.garage.pending) { if (arm('drop')) dropRefuel(s); else say('Press Next item again: it was not a refuel'); } }
        else if (name === 'Garage' && viewOf('Garage') === 'care') careSel = (careSel + 1) % CARE.length;
        else if (VIEWS[name]) return nextView(name);
        changed();
        return null;
    }
    function nextView(name) {
        if (!VIEWS[name]) return false;
        view[name] = (view[name] + 1) % VIEWS[name].length; armed = null; changed();
        return true;
    }
    function act(name, row) {
        const s = src(row ? !!row.demo : undefined);
        if (row) {            // an own row on the Service page (Reset service there)
            if (arm('own' + row.ownKey)) markOwn(row.ownKey, s); else say('Press Reset service again to mark ' + row.name + ' serviced today');
        } else if (name === 'Intervals') {
            const x = states(s, Date.now())[sel];
            if (!x) say('No interval set: choose them in Settings');
            else if (arm('own' + x.it.key)) markOwn(x.it.key, s);
            else say('Press Reset service again to mark ' + x.it.name + ' serviced today');
        } else if (name === 'Wheels') wheelPress(s);
        else if (name === 'Fuel') saveRefuel(s);
        else if (name === 'Garage' && viewOf('Garage') === 'parts') { if (arm('part')) notePart(s); else say('Press again to note: ' + settings.get('partType')); }
        else if (name === 'Garage' && viewOf('Garage') === 'care') { if (arm('care' + CARE[careSel][0])) careDone(s, careSel); else say('Press again: ' + CARE[careSel][1] + ' done today'); }
        else say('Nothing to mark here: this page only reads');
        changed();
    }

    return { TABS, VIEWS, has: (name) => TABS.indexOf(name) >= 0, draw, rows, openOwn, markOwn, select, nextView, act, extraDemo, note: noteNow,
        reset() { armed = null; } };
}

module.exports = { create, TABS, VIEWS };
