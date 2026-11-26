'use strict';
/**
 * demo.js - Diagnose's made-up drive (no car, or Settings > Demo data), stepped in 100 ms ticks from a fixed start so
 * the same seconds always look the same. A 50 s loop: cruise, a full pull through the gears, lift, a stop, corners.
 * Every second loop the pull goes wrong on purpose: the boost falls away first, half a second later the car pulls
 * less (forward g) while the engine still reports the torque of a normal pull. That is what the app is meant to find, so the demo shows it.
 *
 *   const d = new Demo(t0); d.step(t) -> values for time t (ms), in the app's channel names
 */
const RATIOS = [0, 4.7, 3.1, 2.1, 1.67, 1.29, 1.0, 0.84, 0.67];
const FINAL = 3.15, R = 0.335, MASS = 1650, G0 = 9.80665, LOOP = 50;
const rpmFor = (kmh, g) => (kmh / 3.6) / (R * 2 * Math.PI) * 60 * RATIOS[g] * FINAL;

class Demo {
    constructor(t0) { this.t0 = t0; this.t = t0; this.v = 50; this.gear = 3; this.coolant = 22; this.oil = 14; this.soc = 84; }

    /** km/h per second the drive asks for at s seconds into the loop, and the steering wheel (degrees). */
    plan(s, v) {
        if (s < 8) return { acc: 0.6 * Math.sin(s * 0.8), steer: 4 * Math.sin(s), pull: false };
        if (s < 18) return { acc: Math.max(2, 12 - 0.07 * v), steer: 2, pull: true };
        if (s < 24) return { acc: -1.5, steer: 0, pull: false };
        if (s < 28) return { acc: -20, steer: 0, pull: false, brake: true };
        if (s < 44) return { acc: 0.3 * Math.sin(s), steer: 32 * Math.sin((s - 28) / 2.5), pull: false };
        return { acc: (50 - v) / Math.max(0.6, 50 - s), steer: 0, pull: false };
    }

    step(t) {
        let out = null;
        while (this.t < t) { this.t += 100; out = this._tick(); }
        return out || this._tick(true);
    }

    _tick(still) {
        const sec = (this.t - this.t0) / 1000, s = sec % LOOP, loop = Math.floor(sec / LOOP);
        const p = this.plan(s, this.v), dt = still ? 0 : 0.1;
        // the fault: every second loop, from 10 s into the pull for 4 s
        const bad = loop % 2 === 1 && s >= 10 && s < 14;
        const accOk = p.acc, acc = bad && s >= 10.5 ? accOk * 0.35 : accOk;
        this.v = Math.max(0, this.v + acc * dt);
        // the torque the engine reports: what the planned pull needs (in the fault too: it still reports it)
        const rpm0 = rpmFor(this.v, this.gear);
        if (rpm0 > (p.pull ? 5600 : 2600) && this.gear < 8) this.gear++;
        else if (rpm0 < 1300 && this.gear > 1) this.gear--;
        const v = this.v / 3.6, need = accOk / 3.6 + 0.00042 * v * v + 0.12;
        const torque = p.brake ? 20 : Math.max(30, Math.min(460, need * MASS * R / (RATIOS[this.gear] * FINAL)));
        let boost = Math.max(0, (torque - 30) * 0.0034);
        if (bad) boost *= s < 10.4 ? 1 - (s - 10) * 1.1 : 0.55;           // the boost falls away first
        const rpm = Math.max(780, rpmFor(this.v, this.gear));
        if (!still) {
            this.coolant += (90 - this.coolant) * 0.004; this.oil += (Math.min(this.coolant + 12, 104) - this.oil) * 0.003;
            this.soc += (85 - this.soc) * 0.001;
        }
        const gLat = (v * v) * (p.steer * Math.PI / 180 / 15) / 2.8 / G0;
        return {
            t: this.t, rpm, speed: this.v, gLong: acc / 3.6 / G0, gLat, torque, boost,
            kW: torque * rpm / 9549, oil: this.oil, coolant: this.coolant, outside: 6, soc12: this.soc, steer: p.steer, gear: this.gear,
        };
    }
}

module.exports = { Demo, LOOP };
