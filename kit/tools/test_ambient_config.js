'use strict';
// Ambient config (apps/ambient_config/ambient.js): the colour by driving mode, the driver's own colour back on
// "Leave as is", a colour chosen in BMW's menu kept as the driver's own, one write at a time with a gap, nothing
// written for a colour the car shows already, and the set struct naming only the slot.
//   node kit/tools/test_ambient_config.js
const path = require('path');
const { Ambient, modeOf, slotOf, request } = require(path.join(__dirname, '..', '..', 'apps', 'ambient_config', 'ambient'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const log = { info() {}, warn() {}, error() {} };

ok(modeOf('SPORT_DYNAMIC') === 'sport' && modeOf(2) === 'sport' && modeOf('ECO_PRO_PLUS') === 'eco' && modeOf(5) === 'comfort' &&
    modeOf('ADAPTIVE') === 'adaptive' && modeOf(10) === 'adaptive' && modeOf(15) === null && modeOf(undefined) === null, 'driving modes');
ok(slotOf('FARBAUSWAHL_7') === 7 && slotOf(12) === 12 && slotOf('FARBAUSWAHL_13') === null && slotOf('SIGNAL_UNGUELTIG') === null, 'colour slots');
const r = request(4);
ok(r.controlMenuAmbientePanoramicRoofInteriorLighting === 'FARBAUSWAHL_4' && r.controlModeAmbientePanoramicRoofInteriorLighting === 'SIGNAL_UNBEFUELLT', 'the set names the slot only');

let t = 0;
const writes = [];
const subs = {};
const signals = {
    watch: async (iface, inst, h) => { subs[iface] = h; return { proxy: {}, error: null }; },
    set: async (p, field, v) => { writes.push(slotOf(v.controlMenuAmbientePanoramicRoofInteriorLighting)); },
};
const values = { follow: true, sport: 3, comfort: 0, eco: 5, adaptive: 0, restore: true };
const settings = { get: (k) => values[k] };
const a = new Ambient({ settings, signals, log, now: () => t });
const colour = (n) => subs['de.bmw.infotainment.misc.ComfortFunctionIuK'].statusAmbientLightInteriorColour({ statusMenuAmbientePanoramicRoofInteriorLighting: 'FARBAUSWAHL_' + n });
const mode = (m) => subs['de.bmw.infotainment.drivingexcitement.FES'].statusFESVehicleDynamicSwitchHMI({ actualValueModeDrivingExperience: m });
const tick = () => new Promise((res) => setImmediate(res));

(async () => {
    await a.start();
    colour(8);
    ok(a.own() === 8, 'the colour at the start is the driver\'s own');
    mode('COMFORT'); await tick();
    ok(writes.length === 0, 'Comfort on Leave as is, the own colour on: nothing');
    mode('SPORT_DYNAMIC'); await tick();
    ok(writes.join() === '3', 'Sport: its colour');
    colour(3);
    ok(a.own() === 8, 'the colour set by the mode is not the driver\'s own');
    mode('COMFORT'); await tick();
    ok(writes.join() === '3', 'within 1.5 s: waits');
    t += 1600; await new Promise((res) => setTimeout(res, 1700)); await tick();
    ok(writes.join() === '3,8', 'Comfort on Leave as is: the driver\'s own back, after the gap');
    colour(8);
    t += 2000;
    mode('ECO_PRO'); await tick();
    ok(writes.join() === '3,8,5', 'Eco Pro: its colour');
    colour(5);
    colour(10);       // the driver picks 10 in BMW's menu
    ok(a.own() === 10, 'a colour from BMW\'s menu is the driver\'s own');
    t += 2000;
    mode('COMFORT'); await tick();
    ok(writes.join() === '3,8,5', 'own colour showing: nothing to give back');
    values.restore = false;
    t += 2000;
    mode('SPORT'); await tick(); colour(3);
    t += 2000;
    mode('COMFORT'); await tick();
    ok(writes.join() === '3,8,5,3', 'restore off: Leave as is leaves the mode\'s colour');
    t += 2000;
    a.setSlot(6); await tick();
    ok(writes.join() === '3,8,5,3,6' && a.own() === 6, 'by hand: set, and the driver\'s own');
    values.follow = false;
    t += 2000;
    mode('ECO_PRO'); await tick();
    ok(writes.length === 5, 'not following: the mode changes nothing');
    a.stop();
    console.log('ambient config: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})();
