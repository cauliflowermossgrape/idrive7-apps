'use strict';
/**
 * demo.js - Shift Lab's made-up data for demo mode (no car, or Settings > Demo data): the ratios of kit/sim.js's
 * gearbox (so the live demo drive sits on them), forty shifts and a pull curve per gear. Never saved.
 */
const { BIN } = require('./shifts');

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
        const from = 1 + (i % 5), to = from + 1, rpmBefore = Math.round(6350 + rnd() * 600);
        const rpmAfter = Math.round(rpmBefore * SIM[to] / SIM[from]), kmh = Math.round(rpmBefore / K(from));
        const gBefore = PEAK_G[from] * shape(rpmBefore) * (0.95 + rnd() * 0.08);
        shifts.push({
            at: now - i * 47000 - Math.round(rnd() * 9000), from, to, ms: Math.round(150 + from * 18 + rnd() * 90),
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
    return { shifts, ratios, pull };
}

module.exports = { make, K };
