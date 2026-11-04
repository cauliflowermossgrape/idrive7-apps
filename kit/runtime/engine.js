'use strict';
/**
 * engine.js - diesel / petrol profile: rpm scale top and default redline.
 *
 *   const engine = new Engine({ settings, dataDir: ctx.dataDir, log });
 *   // merge into the app's Vehicle2 watch (one proxy per interface):
 *   watches[Engine.SIGNAL[0]] = Object.assign({}, watches[Engine.SIGNAL[0]], engine.handlers());
 *   engine.scaleMax()  -> setting "rpmScale" (0 = Auto: follows the redline, redline + 800 rounded up
 *                         to 1000, as before the profiles: 7000 -> 8000, 6000 -> 7000, 5000 -> 6000)
 *   engine.redline()   -> setting "redline" (0 = Auto: the profile's), never above scaleMax()
 *   engine.value('coldLimit', { diesel: 3000, petrol: 4500 })  -> the setting, or per profile when 0
 *
 * The profile comes from setting "engine" (auto / diesel / petrol). Auto reads typeEngine from
 * Vehicle2.statusVehiclePartType; the last valid type is kept in data/engine.json so the first
 * frames after a start already use it. Nothing known = petrol. "No value" never clears it.
 */
const fs = require('fs');
const path = require('path');

// scaleMax = the Auto scale for the profile's own redline (see scaleMax())
const PROFILES = { diesel: { scaleMax: 6000, redline: 5000 }, petrol: { scaleMax: 8000, redline: 7000 } };
// VehicleTypes.TypeEngine, by name or wire number; 0 (no information) / 15 (invalid) = unknown
const TYPES = {
    4: 'petrol', 5: 'petrol', 6: 'diesel', 7: 'diesel', 8: 'petrol', 9: 'petrol',
    BENZIN_DIREKTEINSPRITZUNG: 'petrol', BENZIN_KONVENTIONELL: 'petrol', DIESEL_DIREKTEINSPRITZUNG: 'diesel',
    DIESEL_KONVENTIONELL: 'diesel', ELEKTROMOTOR: 'petrol', HYBRIDMOTOR: 'petrol',
};
const typeOf = (raw) => (raw !== undefined && raw !== null && Object.prototype.hasOwnProperty.call(TYPES, raw) ? TYPES[raw] : null);

class Engine {
    constructor(opts) {
        this.settings = opts.settings; this.log = opts.log;
        this.file = path.join(opts.dataDir, 'engine.json');
        this.listeners = []; this.logged = false;
        this.type = null;
        try { const t = JSON.parse(fs.readFileSync(this.file, 'utf8')).type; this.type = t === 'diesel' || t === 'petrol' ? t : null; } catch (e) { /* not yet */ }
        this.last = this.profile();
        if (this.settings.onChange) this.settings.onChange((key) => { if (key === 'engine' || key === 'redline' || key === 'rpmScale') this._changed(true); });
    }
    /** statusVehiclePartType value. */
    feed(v) {
        const raw = v ? v.typeEngine : undefined, t = typeOf(raw);
        if (!this.logged) { this.logged = true; if (this.log) this.log.info('engine type: ' + JSON.stringify(raw) + ' -> ' + (t || 'unknown')); }
        if (!t || t === this.type) return;
        this.type = t;
        try { fs.writeFileSync(this.file, JSON.stringify({ type: t })); } catch (e) { if (this.log) this.log.warn('engine save: ' + e); }
        this._changed(false);
    }
    handlers() { return { statusVehiclePartType: (v) => this.feed(v) }; }
    detected() { return this.type; }
    profile() {
        const s = this.settings.get('engine');
        return s === 'diesel' || s === 'petrol' ? s : this.type || 'petrol';
    }
    /** Rev scale top: the "rpmScale" setting, or on Auto the redline + 800 rpm of red zone, rounded up to 1000. */
    scaleMax() {
        const s = this.settings.get('rpmScale');
        if (typeof s === 'number' && s > 0) return s;
        return Math.ceil((this._redline() + 800) / 1000) * 1000;
    }
    value(key, perProfile) {
        const v = this.settings.get(key);
        return typeof v === 'number' && v !== 0 ? v : perProfile[this.profile()];
    }
    _redline() { return this.value('redline', { diesel: PROFILES.diesel.redline, petrol: PROFILES.petrol.redline }); }
    redline() { return Math.min(this._redline(), this.scaleMax()); }
    onChange(fn) { this.listeners.push(fn); }
    _changed(always) {
        const p = this.profile();
        if (!always && p === this.last) return;
        this.last = p;
        this.listeners.forEach((fn) => { try { fn(); } catch (e) { if (this.log) this.log.error(e); } });
    }
}
Engine.SIGNAL = ['de.bmw.infotainment.vehicle.Vehicle2', 'statusVehiclePartType'];
Engine.PROFILES = PROFILES;
Engine.typeOf = typeOf;

module.exports = Engine;
