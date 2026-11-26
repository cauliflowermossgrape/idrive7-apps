'use strict';
/**
 * own_wear.js - Service's "real wear" estimate: how the car was driven since an item's last service, and how
 * much harder that was on the item than plain kilometres say. An estimate from common maintenance guidance (short
 * cold trips, stop and go, hot oil, hard braking, high load wear oil, plugs, gearbox oil and pads faster), never
 * BMW data: the km left stays the main number, this only adds "counts as about N km".
 *
 *   const rec = new DriveRecorder({ now });   rec.sample({ speed, rpm, oil, gLong, kw }) once a second
 *       a drive starts when the engine turns or the car moves and ends after END_MS standing with the engine off;
 *       rec.flush() ends one now. rec.onDrive = (drive) => {} gets each finished drive:
 *       { at, km, maxOil, movingS, slowS, hotS, hardStops, highS }
 *   factors(drives)              -> { km, drives, short, cold, stopGo, hotPer100, hardPer100, highShare }
 *   estimate(item, drives)       -> { km, extra (%), wearKm, parts: [{ rule, value, extra, text }], enough }
 *   RULES, ITEM_RULES
 */
const END_MS = 180000, SHORT_KM = 8, WARM_OIL = 90, HOT_OIL = 120, HARD_G = 0.5, CAP = 60, MIN_KM = 50;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

class DriveRecorder {
    constructor(o) {
        o = o || {};
        this.now = o.now || Date.now; this.onDrive = o.onDrive || (() => {});
        this.peakKw = o.peakKw || 0;
        this.d = null; this.lastT = 0; this.stillSince = 0; this.lastHard = 0;
    }
    sample(v) {
        const t = this.now(), dt = this.lastT ? Math.min(5, (t - this.lastT) / 1000) : 0;
        this.lastT = t;
        const running = isNum(v.rpm) && v.rpm > 300, moving = isNum(v.speed) && v.speed > 2;
        if (!this.d) {
            if (!running && !moving) return;
            this.d = { at: t, km: 0, maxOil: null, movingS: 0, slowS: 0, hotS: 0, hardStops: 0, highS: 0 };
        }
        const d = this.d;
        if (isNum(v.speed)) d.km += v.speed * dt / 3600;
        if (isNum(v.oil)) d.maxOil = d.maxOil === null ? v.oil : Math.max(d.maxOil, v.oil);
        if (moving) { d.movingS += dt; if (v.speed < 20) d.slowS += dt; }
        if (isNum(v.oil) && v.oil > HOT_OIL) d.hotS += dt;
        // a hard stop: braking harder than 0.5 g from over 30 km/h, counted once per 3 s
        if (isNum(v.gLong) && v.gLong <= -HARD_G && isNum(v.speed) && v.speed > 30 && t - this.lastHard > 3000) { d.hardStops++; this.lastHard = t; }
        if (isNum(v.kw) && v.kw > this.peakKw) this.peakKw = v.kw;
        if (moving && isNum(v.kw) && this.peakKw >= 60 && v.kw > 0.6 * this.peakKw) d.highS += dt;
        if (running || moving) this.stillSince = 0;
        else if (!this.stillSince) this.stillSince = t;
        else if (t - this.stillSince >= END_MS) this.flush();
    }
    flush() {
        const d = this.d;
        this.d = null; this.stillSince = 0;
        if (!d || d.km < 0.2) return null;
        d.km = Math.round(d.km * 10) / 10;
        ['movingS', 'slowS', 'hotS', 'highS'].forEach((k) => { d[k] = Math.round(d[k]); });
        this.onDrive(d);
        return d;
    }
}

function factors(drives) {
    const f = { km: 0, drives: drives.length, short: 0, cold: 0, stopGo: 0, hotPer100: 0, hardPer100: 0, highShare: 0 };
    if (!drives.length) return f;
    let moving = 0, slow = 0, hot = 0, hard = 0, high = 0, short = 0, cold = 0;
    drives.forEach((d) => {
        f.km += d.km; moving += d.movingS; slow += d.slowS; hot += d.hotS; hard += d.hardStops; high += d.highS;
        if (d.km < SHORT_KM) short++;
        if (!isNum(d.maxOil) || d.maxOil < WARM_OIL) cold++;
    });
    f.short = short / drives.length; f.cold = cold / drives.length;
    f.stopGo = moving ? slow / moving : 0; f.highShare = moving ? high / moving : 0;
    f.hotPer100 = f.km ? hot / 60 / f.km * 100 : 0; f.hardPer100 = f.km ? hard / f.km * 100 : 0;
    return f;
}

/* Each rule: the value it reads, what counts as normal, where its full extra is reached, its most extra wear (%). */
const RULES = {
    short: { name: 'Short trips', of: (f) => f.short, normal: 0.3, full: 0.8, cap: 25, fmt: (v) => Math.round(v * 100) + ' % of drives under ' + SHORT_KM + ' km',
        text: 'Many short trips: the oil and plugs never get properly warm.' },
    cold: { name: 'Cold engine', of: (f) => f.cold, normal: 0.2, full: 0.7, cap: 20, fmt: (v) => Math.round(v * 100) + ' % of drives with oil under ' + WARM_OIL + ' °C',
        text: 'Oil that stays cold gathers water and fuel and ages faster.' },
    stopGo: { name: 'Stop and go', of: (f) => f.stopGo, normal: 0.2, full: 0.6, cap: 20, fmt: (v) => Math.round(v * 100) + ' % of moving time under 20 km/h',
        text: 'Crawling traffic: many starts, stops and shifts for few km.' },
    hot: { name: 'Hot oil', of: (f) => f.hotPer100, normal: 1, full: 10, cap: 15, fmt: (v) => v.toFixed(1) + ' min per 100 km above ' + HOT_OIL + ' °C',
        text: 'Oil above ' + HOT_OIL + ' °C breaks down faster.' },
    hard: { name: 'Hard braking', of: (f) => f.hardPer100, normal: 2, full: 10, cap: 30, fmt: (v) => v.toFixed(1) + ' hard stops per 100 km',
        text: 'Hard stops take more off the pads each time.' },
    load: { name: 'High load', of: (f) => f.highShare, normal: 0.03, full: 0.15, cap: 20, fmt: (v) => (v * 100).toFixed(1) + ' % of moving time above 60 % power',
        text: 'Lots of high power heats and loads the oil and plugs.' },
};
const ITEM_RULES = {
    oil: ['short', 'cold', 'stopGo', 'hot', 'load'], plugs: ['short', 'cold', 'load'], gearbox: ['stopGo', 'hot', 'load'],
    padsFront: ['hard', 'stopGo'], padsRear: ['hard', 'stopGo'],
};

function estimate(item, drives) {
    const f = factors(drives), keys = ITEM_RULES[item.key] || [];
    const parts = keys.map((k) => {
        const r = RULES[k], value = r.of(f), extra = clamp((value - r.normal) / (r.full - r.normal), 0, 1) * r.cap;
        return { key: k, rule: r, value, extra, frac: clamp(value / r.full, 0, 1), normalFrac: r.normal / r.full };
    });
    const extra = Math.min(CAP, parts.reduce((s, p) => s + p.extra, 0));
    return { km: f.km, drives: f.drives, extra, wearKm: f.km * (1 + extra / 100), parts, enough: f.km >= MIN_KM, applies: keys.length > 0, f };
}

module.exports = { DriveRecorder, factors, estimate, RULES, ITEM_RULES, CAP, MIN_KM, END_MS };
