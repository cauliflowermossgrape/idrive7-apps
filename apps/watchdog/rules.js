'use strict';
/**
 * rules.js - Watchdog's rules and what each one watches.
 *
 *   VALUES                    the values a rule can watch: { key, name, unit, steps, decimals }
 *   DEFAULTS                  the 8 rules a new install starts with
 *   normalize(list)           a saved list made safe (8 rules, known values, a threshold on its value's steps)
 *   text(rule)                "Engine oil above 120 C for 5 s"
 *   class Engine              engine.step(rules, values, now, cooldownMs) -> the rules that fired now
 *       a rule fires once when its value has been past the threshold for `hold` seconds, then not again until
 *       the value came back (re-armed) and the cooldown since its last firing has passed
 *       engine.state(i, rule, values, now, cooldownMs) -> { state: 'off' | 'no value' | 'armed' | 'waiting' | 'firing' | 'cooldown', held }
 */
const range = (a, b, s) => { const out = []; for (let v = a; v <= b + 1e-9; v += s) out.push(Math.round(v * 100) / 100); return out; };
const VALUES = [
    { key: 'oil', name: 'Engine oil', unit: '\u00b0C', steps: range(40, 150, 5), decimals: 0, temp: true },
    { key: 'coolant', name: 'Coolant', unit: '\u00b0C', steps: range(40, 130, 5), decimals: 0, temp: true },
    { key: 'gearbox', name: 'Gearbox oil', unit: '\u00b0C', steps: range(40, 140, 5), decimals: 0, temp: true },
    { key: 'outside', name: 'Outside', unit: '\u00b0C', steps: range(-20, 45, 1), decimals: 0, temp: true },
    { key: 'speed', name: 'Speed', unit: 'km/h', steps: range(20, 250, 10), decimals: 0 },
    { key: 'rpm', name: 'Engine speed', unit: 'rpm', steps: range(1000, 7500, 250), decimals: 0 },
    { key: 'kw', name: 'Power', unit: 'kW', steps: range(20, 400, 10), decimals: 0 },
    { key: 'brake', name: 'Braking', unit: 'g', steps: range(0.2, 1.2, 0.05), decimals: 2 },
    { key: 'side', name: 'Sideways', unit: 'g', steps: range(0.2, 1.4, 0.05), decimals: 2 },
    { key: 'soc12', name: '12 V charge', unit: '%', steps: range(10, 100, 5), decimals: 0 },
    { key: 'range', name: 'Fuel range', unit: 'km', steps: range(10, 800, 10), decimals: 0 },
];
const HOLDS = [0, 2, 5, 10];
const byKey = (k) => VALUES.find((v) => v.key === k) || VALUES[0];
const DEFAULTS = [
    { on: true, value: 'oil', cmp: 'above', thr: 120, hold: 5 },
    { on: true, value: 'coolant', cmp: 'above', thr: 110, hold: 5 },
    { on: true, value: 'soc12', cmp: 'below', thr: 60, hold: 10 },
    { on: false, value: 'speed', cmp: 'above', thr: 130, hold: 2 },
    { on: true, value: 'gearbox', cmp: 'above', thr: 115, hold: 5 },
    { on: true, value: 'outside', cmp: 'below', thr: 3, hold: 0 },
    { on: true, value: 'brake', cmp: 'above', thr: 0.8, hold: 0 },
    { on: true, value: 'range', cmp: 'below', thr: 60, hold: 10 },
];

/** The step of `steps` nearest to v. */
function snap(steps, v) {
    let best = steps[0];
    steps.forEach((s) => { if (Math.abs(s - v) < Math.abs(best - v)) best = s; });
    return best;
}

function normalize(list) {
    const out = [];
    for (let i = 0; i < 8; i++) {
        const r = (Array.isArray(list) && list[i]) || DEFAULTS[i], d = DEFAULTS[i];
        const val = VALUES.some((v) => v.key === r.value) ? r.value : d.value;
        out.push({
            on: typeof r.on === 'boolean' ? r.on : d.on,
            value: val,
            cmp: r.cmp === 'below' ? 'below' : 'above',
            thr: snap(byKey(val).steps, typeof r.thr === 'number' ? r.thr : byKey(val).steps[0]),
            hold: HOLDS.indexOf(r.hold) >= 0 ? r.hold : 0,
        });
    }
    return out;
}

function fmt(v, d) { return typeof v === 'number' && isFinite(v) ? (d ? v.toFixed(d) : String(Math.round(v))) : '--'; }
function text(r) {
    const v = byKey(r.value);
    return v.name + ' ' + r.cmp + ' ' + fmt(r.thr, v.decimals) + ' ' + v.unit + (r.hold ? ' for ' + r.hold + ' s' : '');
}

class Engine {
    constructor() { this.s = []; for (let i = 0; i < 8; i++) this.s.push({ since: 0, firing: false, last: 0, count: 0 }); }

    step(rules, values, now, cooldownMs) {
        const fired = [];
        rules.forEach((r, i) => {
            const s = this.s[i], v = values[r.value];
            if (!r.on || typeof v !== 'number' || !isFinite(v)) { s.since = 0; s.firing = false; return; }
            const past = r.cmp === 'above' ? v > r.thr : v < r.thr;
            if (!past) { s.since = 0; s.firing = false; return; }
            if (!s.since) s.since = now;
            if (s.firing || now - s.since < r.hold * 1000) return;
            if (s.last && now - s.last < cooldownMs) return;
            s.firing = true; s.last = now; s.count++;
            fired.push({ i, value: v, at: now });
        });
        return fired;
    }

    state(i, r, values, now, cooldownMs) {
        const s = this.s[i], v = values[r.value];
        if (!r.on) return { state: 'off' };
        if (typeof v !== 'number' || !isFinite(v)) return { state: 'no value' };
        if (s.firing) return { state: 'firing' };
        if (s.since) {
            const held = (now - s.since) / 1000;
            return s.last && now - s.last < cooldownMs ? { state: 'cooldown', left: (cooldownMs - (now - s.last)) / 1000 } : { state: 'waiting', held };
        }
        return { state: 'armed' };
    }

    /** Edited rule i: its timing starts over. */
    reset(i) { this.s[i] = { since: 0, firing: false, last: 0, count: this.s[i].count }; }
}

module.exports = { VALUES, HOLDS, DEFAULTS, byKey, snap, normalize, text, fmt, Engine };
