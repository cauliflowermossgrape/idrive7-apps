'use strict';
/**
 * conditions.js - Road Conditions' arithmetic, kept apart from the screen so it can be tested:
 *
 *   const tr = new Tracker();  tr.sample({ temp, speed, steer, gLat }, now)   once a second
 *     tr.temps   the outside temperature every 30 s, the last 30 min: [{ t, c }]
 *     tr.points  every 10 s at the last 30 min: [{ t, fast, straight, steerSd, latSd, speed }]
 *                fast: above 80 km/h the whole 10 s; straight: no curve (sideways g and steering near 0 on average)
 *                steerSd / latSd: how much the steering wheel / the car moved sideways around that average (the small
 *                corrections a driver makes against side gusts)
 *   trend(temps, now)          the change of the outside temperature over the last 30 min (deg C), null under 10 min
 *   ice(temp, trend, iceAt)    { state: 'ice' | 'watch' | 'clear' | 'unknown', title, why }
 *   wind(points, now)          { state: 'gusty' | 'breezy' | 'calm' | 'unknown', value, by: 'steer' | 'lat', why }
 *   windStats(points)          { fastMin, gustyMin, worst, by } over the 30 min
 *   overall(ice, wind)         { state, title, why, color: 'crit' | 'warn' | 'go' | 'dim' }
 *
 * The crosswind reading is an estimate: the car has no wind sensor. Gusts on a straight road at speed make the driver
 * correct the steering a little, again and again; that activity is what is measured.
 */
const ICE_AT = 4, WATCH_SPAN = 3, FAST_KMH = 80, WIN_MS = 10000, KEEP_MS = 30 * 60000, TEMP_MS = 30000, RECENT_MS = 2 * 60000;
const STEER_BREEZY = 1.5, STEER_GUSTY = 3, LAT_BREEZY = 0.02, LAT_GUSTY = 0.04;
const isNum = (x) => typeof x === 'number' && isFinite(x);
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length); };
const one = (c) => (Math.round(c * 10) / 10).toFixed(1);

class Tracker {
    constructor() { this.temps = []; this.points = []; this.win = []; this.winStart = null; this.lastTemp = -Infinity; }

    sample(v, now) {
        if (isNum(v.temp) && now - this.lastTemp >= TEMP_MS) { this.temps.push({ t: now, c: v.temp }); this.lastTemp = now; }
        while (this.temps.length && now - this.temps[0].t > KEEP_MS) this.temps.shift();
        if (this.winStart === null) this.winStart = now;
        this.win.push({ speed: v.speed, steer: v.steer, lat: v.gLat });
        if (now - this.winStart >= WIN_MS) {
            this.points.push(point(this.win, now));
            this.win = []; this.winStart = now;
        }
        while (this.points.length && now - this.points[0].t > KEEP_MS) this.points.shift();
    }
}

/** One 10 s window: was it fast and straight, and how much did the steering and the car move around their average. */
function point(w, t) {
    const sp = w.map((s) => s.speed).filter(isNum), st = w.map((s) => s.steer).filter(isNum), la = w.map((s) => s.lat).filter(isNum);
    const fast = w.length > 0 && sp.filter((x) => x >= FAST_KMH).length >= 0.8 * w.length;
    const straight = fast && la.length >= 3 && Math.abs(mean(la)) < 0.06 && (st.length < 3 || Math.abs(mean(st)) < 10);
    return { t, fast, straight, speed: sp.length ? mean(sp) : null, steerSd: st.length >= 3 ? sd(st) : null, latSd: la.length >= 3 ? sd(la) : null };
}

function trend(temps, now) {
    const l = temps.filter((x) => now - x.t <= KEEP_MS);
    if (l.length < 2 || l[l.length - 1].t - l[0].t < 10 * 60000) return null;
    return l[l.length - 1].c - l[0].c;
}

function ice(temp, tr, iceAt) {
    const at = iceAt || ICE_AT;
    if (!isNum(temp)) return { state: 'unknown', title: 'NO READING', why: 'Waiting for the outside temperature from the car.' };
    if (temp <= 0) return { state: 'ice', title: 'ICE RISK', why: one(temp) + ' °C outside: water on the road can freeze. Bridges, overpasses and shade first.' };
    if (temp <= at) return { state: 'ice', title: 'ICE RISK', why: one(temp) + ' °C outside, close to freezing: bridges and shaded stretches can be icy.' };
    if (temp <= at + WATCH_SPAN && isNum(tr) && tr <= -1) return { state: 'watch', title: 'GETTING COLD', why: one(temp) + ' °C and falling (' + one(tr) + ' °C in 30 min): ice risk is near.' };
    return { state: 'clear', title: 'NO ICE RISK', why: one(temp) + ' °C outside: well above freezing.' };
}

function level(v, by) {
    const b = by === 'steer' ? STEER_BREEZY : LAT_BREEZY, g = by === 'steer' ? STEER_GUSTY : LAT_GUSTY;
    return v >= g ? 'gusty' : v >= b ? 'breezy' : 'calm';
}
const valueOf = (p, by) => (by === 'steer' ? p.steerSd : p.latSd);

function wind(points, now) {
    const recent = points.filter((p) => now - p.t <= RECENT_MS && p.straight);
    if (!recent.length) return { state: 'unknown', value: null, by: null, why: 'Not enough straight driving above 80 km/h in the last 2 minutes to tell.' };
    const by = recent.every((p) => isNum(p.steerSd)) ? 'steer' : 'lat';
    const vals = recent.map((p) => valueOf(p, by)).filter(isNum);
    if (!vals.length) return { state: 'unknown', value: null, by: null, why: 'No steering or sideways reading from the car yet.' };
    const value = Math.max.apply(null, vals), state = level(value, by);
    const why = state === 'gusty' ? 'Many small steering corrections on a straight road: side gusts. Hold the wheel firmly on bridges and open stretches.'
        : state === 'breezy' ? 'Some steering corrections on a straight road: a little side wind.'
            : 'Steady on a straight road: no side gusts noticed.';
    return { state, value, by, why };
}

function windStats(points) {
    const s = points.filter((p) => p.straight);
    const by = s.length && s.every((p) => isNum(p.steerSd)) ? 'steer' : 'lat';
    const vals = s.map((p) => valueOf(p, by)).filter(isNum);
    const gusty = vals.filter((v) => level(v, by) === 'gusty').length;
    return { fastMin: s.length * WIN_MS / 60000, gustyMin: gusty * WIN_MS / 60000, worst: vals.length ? Math.max.apply(null, vals) : null, by };
}

function overall(ic, wd) {
    if (ic.state === 'ice') return { state: 'ice', title: 'ICE RISK', why: ic.why, color: 'crit' };
    if (wd.state === 'gusty') return { state: 'gusty', title: 'GUSTY', why: wd.why, color: 'warn' };
    if (ic.state === 'watch') return { state: 'watch', title: 'GETTING COLD', why: ic.why, color: 'warn' };
    if (ic.state === 'unknown' && wd.state === 'unknown') return { state: 'unknown', title: 'WAITING', why: 'Waiting for readings from the car.', color: 'dim' };
    return { state: 'clear', title: 'CLEAR', why: 'No ice risk and no strong side gusts noticed.', color: 'go' };
}

module.exports = { Tracker, point, trend, ice, wind, windStats, overall, level, ICE_AT, FAST_KMH, STEER_BREEZY, STEER_GUSTY, LAT_BREEZY, LAT_GUSTY, WIN_MS, KEEP_MS };
