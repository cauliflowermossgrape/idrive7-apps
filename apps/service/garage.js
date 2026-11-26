'use strict';
/**
 * garage.js - Service's Garage records (Fuel, Parts, Milestones) and the arithmetic on them (no drawing, no signals):
 *
 *   const g = new Garage(saved);   saved = what toJSON() gave (garage.json in the app's data folder)
 *   g.feed(v, now)                 v = { speed, tank (l), odo (km) }: refuel detection and odometer milestones
 *   g.changed                      true when something worth writing happened (a refuel seen, a milestone, a note);
 *                                  the odometer alone (lastOdo) does not count: the background writes it at a drive's end
 *   g.pending                      a refuel seen while parked, waiting for one tap: { at, km, before, after, litres }
 *   g.saveRefuel(brand, octane, now) / g.dropRefuel()
 *   g.markPart(type, km, now), g.bookmark(snapshot, now)   (a part, or care, from the Settings list)
 *   consumption(fuel)              [{ at, km, litres, perHundred, brand }] per tank, oldest first
 *   byBrand(rows)                  [{ brand, n, avg }]
 *   milestoneRate(milestones, odo, now) { perDay, nextKm, nextAt }
 *
 * A refuel: the tank level rises by REFUEL_L or more while the car stands (speed under 2 km/h, or none) and has
 * stayed up for SETTLE_MS; before = the lowest level seen while standing, after = the level now. Consumption per tank
 * is the litres put in against the km since the refuel before: right when the tank is filled the same way each
 * time, which the page says.
 */
const MAX_FUEL = 60, MAX_PARTS = 80, MAX_MARKS = 40, REFUEL_L = 5, SETTLE_MS = 60000, STEP_KM = 10000;
const DAY = 86400000, WEEK = 7 * DAY;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

class Garage {
    constructor(o) {
        o = o || {};
        this.fuel = Array.isArray(o.fuel) ? o.fuel.slice(-MAX_FUEL) : [];
        this.parts = Array.isArray(o.parts) ? o.parts.slice(-MAX_PARTS) : [];
        this.milestones = Array.isArray(o.milestones) ? o.milestones : [];
        this.marks = Array.isArray(o.marks) ? o.marks.slice(-MAX_MARKS) : [];
        this.pending = o.pending || null;
        this.lastOdo = isNum(o.lastOdo) ? o.lastOdo : null;
        this.stand = null;          // { min, since } while the car stands
        this.changed = false;
    }

    feed(v, now) {
        const standing = !isNum(v.speed) || v.speed < 2;
        if (isNum(v.tank) && standing) {
            if (!this.stand) this.stand = { min: v.tank, up: null };
            this.stand.min = Math.min(this.stand.min, v.tank);
            if (v.tank - this.stand.min >= REFUEL_L) {
                if (!this.stand.up) this.stand.up = now;
                if (now - this.stand.up >= SETTLE_MS) {
                    this.pending = { at: now, km: isNum(v.odo) ? Math.round(v.odo) : null, before: Math.round(this.stand.min), after: Math.round(v.tank),
                        litres: Math.round(v.tank - this.stand.min) };
                    this.stand = { min: v.tank, up: null }; this.changed = true;
                }
            } else this.stand.up = null;
        } else if (!standing) this.stand = null;
        if (isNum(v.odo) && v.odo > 0) {
            // every STEP_KM passed is a milestone, kept with its date (only ones passed while the app ran)
            if (isNum(this.lastOdo) && Math.floor(v.odo / STEP_KM) > Math.floor(this.lastOdo / STEP_KM) && v.odo - this.lastOdo < 500) {
                this.milestones.push({ km: Math.floor(v.odo / STEP_KM) * STEP_KM, at: now }); this.changed = true;
            }
            this.lastOdo = Math.round(v.odo);         // (not "changed": written at a drive's end, not every km)
        }
    }

    saveRefuel(brand, octane) {
        if (!this.pending) return null;
        const e = Object.assign({}, this.pending, { brand, octane });
        this.fuel.push(e); if (this.fuel.length > MAX_FUEL) this.fuel.shift();
        this.pending = null; this.changed = true;
        return e;
    }
    dropRefuel() { this.pending = null; this.changed = true; }
    markPart(type, km, now) { const e = { at: now, km: isNum(km) ? Math.round(km) : null, type }; this.parts.push(e); if (this.parts.length > MAX_PARTS) this.parts.shift(); this.changed = true; return e; }
    bookmark(snap, now) { const e = Object.assign({ at: now }, snap); this.marks.push(e); if (this.marks.length > MAX_MARKS) this.marks.shift(); this.changed = true; return e; }

    toJSON() { return { fuel: this.fuel, parts: this.parts, milestones: this.milestones, marks: this.marks, pending: this.pending, lastOdo: this.lastOdo }; }
}

function consumption(fuel) {
    const l = (fuel || []).filter((f) => isNum(f.litres)).slice().sort((a, b) => a.at - b.at);
    return l.map((f, i) => {
        const prev = l[i - 1], d = prev && isNum(prev.km) && isNum(f.km) ? f.km - prev.km : null;
        return { at: f.at, km: f.km, litres: f.litres, brand: f.brand, octane: f.octane, dist: d,
            perHundred: isNum(d) && d >= 50 && d < 2000 ? Math.round(f.litres / d * 1000) / 10 : null };
    });
}

function byBrand(rows) {
    const by = {};
    rows.filter((r) => isNum(r.perHundred)).forEach((r) => { (by[r.brand || 'none'] = by[r.brand || 'none'] || []).push(r.perHundred); });
    return Object.keys(by).map((b) => ({ brand: b, n: by[b].length, avg: Math.round(avg(by[b]) * 10) / 10 })).sort((a, b) => a.avg - b.avg);
}

function milestoneRate(ms, odo, now) {
    const l = (ms || []).slice().sort((a, b) => a.at - b.at);
    if (!isNum(odo)) return { perDay: null, nextKm: null, nextAt: null };
    const nextKm = (Math.floor(odo / STEP_KM) + 1) * STEP_KM;
    let perDay = null;
    if (l.length >= 2) { const a = l[0], b = l[l.length - 1]; if (b.at > a.at) perDay = (b.km - a.km) / ((b.at - a.at) / DAY); }
    else if (l.length === 1 && now > l[0].at && odo > l[0].km) perDay = (odo - l[0].km) / ((now - l[0].at) / DAY);
    return { perDay: isNum(perDay) && perDay > 0 ? perDay : null, nextKm, nextAt: isNum(perDay) && perDay > 0 ? now + (nextKm - odo) / perDay * DAY : null };
}

module.exports = { Garage, consumption, byBrand, milestoneRate, STEP_KM, REFUEL_L, SETTLE_MS, WEEK, DAY };
