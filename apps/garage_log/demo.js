'use strict';
/**
 * demo.js - Garage Log's made-up garage for demo mode (no car, or Settings > Demo data): a year of refuels in three
 * brands, parts fitted, care done, odometer milestones, two bookmarks and a refuel waiting for its tap. Never saved.
 */
const { Garage, DAY } = require('./garage');

function make(now) {
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const odo = 48650, fuel = [], brands = ['omv', 'nis', 'mol'];
    let km = odo - 9800;
    for (let i = 0; i < 14; i++) {
        const dist = Math.round(560 + rnd() * 160), brand = brands[i % 3], k = brand === 'omv' ? 7.4 : brand === 'nis' ? 7.9 : 7.6;
        km += dist;
        if (km > odo - 120) break;
        const litres = Math.round(dist * (k + (rnd() - 0.5) * 0.8) / 100);
        fuel.push({ at: now - (odo - km) / 52 * DAY, km, before: Math.round(8 + rnd() * 6), after: 0, litres, brand, octane: i % 4 === 3 ? 98 : 95 });
        fuel[fuel.length - 1].after = fuel[fuel.length - 1].before + litres;
    }
    const parts = [['Oil and filter', 36200, 290], ['Brake pads', 39800, 220], ['Intake', 41500, 180], ['Tune / map', 41520, 179],
        ['Tyres', 43900, 120], ['Battery', 45100, 90], ['Cabin filter', 46900, 40], ['Oil and filter', 47800, 15]]
        .map(([type, k, d]) => ({ type, km: k, at: now - d * DAY }));
    const care = { wash: { at: now - 17 * DAY }, interior: { at: now - 9 * DAY }, wheels: { at: now - 40 * DAY }, wax: { at: now - 95 * DAY },
        decon: { at: now - 120 * DAY }, polish: { at: now - 300 * DAY } };
    const milestones = [10000, 20000, 30000, 40000].map((k, i) => ({ km: k, at: now - (odo - k) / 48 * DAY + i * DAY }));
    const marks = [{ at: now - 3 * DAY, km: 48410, tank: 31, speed: 0, soc: 84, note: 'bookmark' }, { at: now - 26 * 3600000, km: 48590, tank: 22, speed: 92, soc: 88 }];
    const g = new Garage({ fuel, parts, care, milestones, marks, lastOdo: odo,
        pending: { at: now - 40 * 60000, km: odo, before: 9, after: 55, litres: 46 } });
    return { g, live: { tank: 55, range: 690, odo, soc: 81, speed: 0 } };
}

module.exports = { make };
