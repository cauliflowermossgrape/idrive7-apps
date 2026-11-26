'use strict';
/**
 * shiftdemo.js - made-up shift timing data for Redline's demo drive (no car): the ratios of kit/sim.js's
 * gearbox (so the live demo drive sits on them), forty shifts (from a cold gearbox to a warm one), a pull curve per
 * gear and two dozen kickdowns in three driving modes. Never saved.
 */
const { BIN } = require('./shiftlab');

const SIM = [0, 4.7, 3.1, 2.1, 1.67, 1.29, 1.0], FINAL = 3.15, WHEEL_M = 0.335 * 2 * Math.PI;
const K = (g) => SIM[g] * FINAL * 60 / (3.6 * WHEEL_M);          // rpm per km/h in gear g
const PEAK_G = [0, 0.62, 0.55, 0.39, 0.31, 0.24, 0.18];
const shape = (rpm) => (rpm < 1800 ? 0.55 + 0.45 * (rpm - 1000) / 800 : rpm < 4600 ? 1 : Math.max(0.55, 1 - (rpm - 4600) / 5200));

function make(now) {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const ratios = {}; for (let g = 1; g <= 6; g++) ratios[g] = Math.round(K(g) * 1000) / 1000;
    const shifts = [];
    for (let i = 0; i < 40; i++) {
        // the oldest shifts on a cold gearbox: slower, as a cold gearbox shifts
        const gb = Math.round(Math.min(96, 25 + (40 - i) * 2.2 + (i * 7) % 4)), slow = gb < 40 ? 1.45 : gb < 70 ? 1.18 : gb < 90 ? 1.04 : 1;
        const from = 1 + (i % 5), to = from + 1, rpmBefore = Math.round(6350 + rnd() * 600);
        const rpmAfter = Math.round(rpmBefore * SIM[to] / SIM[from]), kmh = Math.round(rpmBefore / K(from));
        const gBefore = PEAK_G[from] * shape(rpmBefore) * (0.95 + rnd() * 0.08);
        shifts.push({
            at: now - i * 47000 - Math.round(rnd() * 9000), from, to, ms: Math.round((150 + from * 18 + rnd() * 90) * slow), gb,
            rpmBefore, rpmAfter, kmh, gBefore: Math.round(gBefore * 1000) / 1000, gDip: Math.round((0.06 + rnd() * 0.08) * 1000) / 1000,
            gAfter: Math.round(PEAK_G[to] * shape(rpmAfter) * 1000) / 1000, tqBefore: Math.round(330 + rnd() * 40), tqAfter: Math.round(390 + rnd() * 30),
        });
    }
    const pull = {};
    for (let g = 1; g <= 6; g++) {
        pull[g] = {};
        for (let rpm = 1250; rpm <= 6900; rpm += BIN) {
            const b = Math.floor(rpm / BIN), v = PEAK_G[g] * shape(rpm) * (0.98 + rnd() * 0.04);
            pull[g][b] = [v * 10, 10];
        }
    }
    const kicks = [], MODES = [['sport', 0.72], ['comfort', 1], ['eco', 1.35]];
    for (let i = 0; i < 24; i++) {
        const [mode, f] = MODES[i % 3], gb = Math.round(Math.min(95, 30 + (24 - i) * 3 + rnd() * 5));
        const cold = gb < 40 ? 1.4 : gb < 70 ? 1.15 : 1, held = mode === 'eco' && i % 4 === 2;
        const from = 3 + (i % 4), to = from - (mode === 'sport' && i % 2 ? 2 : 1), start = Math.round((140 + rnd() * 90) * f * cold);
        kicks.push({ at: now - i * 190000 - Math.round(rnd() * 40000), kind: held ? 'held' : 'down', from, to: held ? from : to,
            startMs: held ? null : start, doneMs: held ? null : Math.round(start + (230 + rnd() * 140) * f * cold),
            kmh: Math.round(55 + rnd() * 60), pedal: Math.round(85 + rnd() * 15), mode, gb });
    }
    return { shifts, ratios, pull, kicks };
}

module.exports = { make, K };
