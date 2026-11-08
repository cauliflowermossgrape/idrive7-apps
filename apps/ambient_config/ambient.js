'use strict';
/**
 * ambient.js - the ambient light's colour: set by hand, or by the driving mode.
 *
 * The ambient light has the colours of BMW's own menu, numbered slots (FARBAUSWAHL_1..12 on the bus; which
 * colour a number is depends on the car). ComfortFunctionIuK.statusAmbientLightInteriorColour says which one is
 * on; ambientLightInteriorColour sets one. A set names only the slot and leaves every other field "not filled",
 * so brightness and the light's other modes stay as they are.
 *
 * Driving mode (FES statusFESVehicleDynamicSwitchHMI): when it changes to a mode with a colour set, that colour;
 * to one set to "Leave as is", the driver's own colour back (setting "restore"). The driver's own colour is the
 * last one not set by this app's driving modes: one chosen in BMW's menu or by hand here. One write at a time, at
 * most one each 1.5 s, and only a colour the car does not show already.
 *
 *   const a = new Ambient({ settings, signals, log });
 *   await a.start();
 *   a.slot() -> 1..12 | null        a.mode() -> 'sport' | 'comfort' | 'eco' | 'adaptive' | null
 *   a.own() -> the driver's own colour | null       a.setSlot(n) by hand       a.on('change', fn)
 */
const EventEmitter = require('events');

const LIGHT = 'de.bmw.infotainment.misc.ComfortFunctionIuK';
const FES = 'de.bmw.infotainment.drivingexcitement.FES';
const SLOTS = 12;
const MIN_GAP_MS = 1500;
const MODES = ['sport', 'comfort', 'eco', 'adaptive'];
const UNFILLED = 'SIGNAL_UNBEFUELLT';

/* actualValueModeDrivingExperience: a name or its wire number -> one of MODES, or null. */
function modeOf(raw) {
    if (raw === undefined || raw === null || raw === '') return null;
    const n = Number(raw);
    if (!isNaN(n)) return n >= 1 && n <= 3 ? 'sport' : n >= 4 && n <= 6 ? 'comfort' : n >= 7 && n <= 9 ? 'eco' : n === 10 ? 'adaptive' : null;
    const s = String(raw).toUpperCase();
    return /SPORT/.test(s) ? 'sport' : /ECO/.test(s) ? 'eco' : /COMFORT/.test(s) ? 'comfort' : /ADAPTIV/.test(s) ? 'adaptive' : null;
}

/* statusMenuAmbientePanoramicRoofInteriorLighting: FARBAUSWAHL_n or n -> n (1..SLOTS), or null. */
function slotOf(raw) {
    const m = /^FARBAUSWAHL_(\d+)$/.exec(String(raw));
    const n = m ? Number(m[1]) : Number(raw);
    return Number.isInteger(n) && n >= 1 && n <= SLOTS ? n : null;
}

/* The ambientLightInteriorColour struct that sets slot n and nothing else. */
function request(n) {
    return {
        controlMenuAmbientePanoramicRoofInteriorLighting: 'FARBAUSWAHL_' + n,
        controlModeAmbientePanoramicRoofInteriorLighting: UNFILLED,
        controlDynamicInteriorLighting: UNFILLED,
        controlDynamicAmbienteInteriorLighting: UNFILLED,
        controlHueInteriorLighting: 4095,
        controlHueValueLayer1IndividualGroup: 255,
        controlHueValueLayer2IndividualGroup: 255,
        controlHueValueLayer3IndividualGroup: 255,
        controlBrightnessValueBrightnessOffsetAmbientePanoramicRoofInteriorLighting: 255,
    };
}

class Ambient extends EventEmitter {
    constructor(o) {
        super();
        this.settings = o.settings;
        this.signals = o.signals;
        this.log = o.log;
        this.now = o.now || Date.now;
        this._slot = null;
        this._mode = null;
        this._own = null;
        this._ours = null;         // the slot this app's driving modes last set, until the car shows another
        this._proxy = null;
        this._busy = false;
        this._want = null;         // { n, why } waiting for the write before it or the gap
        this._last = -Infinity;
        this._timer = null;
        this.error = null;
        this.available = false;
    }

    slot() { return this._slot; }
    mode() { return this._mode; }
    own() { return this._own; }

    async start() {
        const light = await this.signals.watch(LIGHT, '1', { statusAmbientLightInteriorColour: (v) => this.colour(v) }, this.log);
        this._proxy = light.proxy;
        this.available = !!light.proxy;
        if (light.error) { this.error = light.error; this.log.warn('ambient light: ' + light.error); }
        const fes = await this.signals.watch(FES, '1', { statusFESVehicleDynamicSwitchHMI: (v) => this.drive(v) }, this.log);
        if (fes.error) this.log.warn('driving mode: ' + fes.error);
        this.emit('change');
    }

    /* A status of the ambient light. */
    colour(v) {
        const n = slotOf(v && v.statusMenuAmbientePanoramicRoofInteriorLighting);
        if (n === null || n === this._slot) return;
        this._slot = n;
        if (n !== this._ours) {
            if (this._own !== n) this.log.info('ambient: colour ' + n + ' (the driver\'s own)');
            this._own = n;
            this._ours = null;
        }
        this.emit('change');
    }

    /* A status of the driving mode. */
    drive(v) {
        const m = modeOf(v && v.actualValueModeDrivingExperience);
        if (m === null || m === this._mode) return;
        this._mode = m;
        this.log.info('ambient: driving mode ' + m);
        this.follow();
        this.emit('change');
    }

    /* The colour the driving mode asks for, or the driver's own back; nothing while not following. */
    follow() {
        if (!this.settings.get('follow') || !this._mode) return;
        const n = Number(this.settings.get(this._mode)) || 0;
        if (n >= 1 && n <= SLOTS) this._write(n, 'mode');
        else if (this.settings.get('restore') !== false && this._ours !== null && this._own !== null) this._write(this._own, 'own');
    }

    /* By hand: the driver's own colour from now. */
    setSlot(n) {
        if (!(n >= 1 && n <= SLOTS)) return;
        this._own = n;
        this._ours = null;
        this._write(n, 'hand');
    }

    _write(n, why) {
        this._want = { n, why };
        this._next();
    }

    _next() {
        if (this._busy || !this._want) return;
        const wait = this._last + MIN_GAP_MS - this.now();
        if (wait > 0) {
            if (!this._timer) this._timer = setTimeout(() => { this._timer = null; this._next(); }, wait);
            return;
        }
        const { n, why } = this._want;
        this._want = null;
        if (why === 'mode') this._ours = n;
        else if (why === 'own') this._ours = null;
        if (n === this._slot) return;
        if (!this._proxy) { this.log.warn('ambient: colour ' + n + ' not set: the car\'s ambient light does not answer'); return; }
        this._busy = true;
        this._last = this.now();
        this.log.info('ambient: setting colour ' + n + ' (' + ({ mode: 'driving mode ' + this._mode, own: 'the driver\'s own back', hand: 'by hand' })[why] + ')');
        Promise.resolve().then(() => this.signals.set(this._proxy, 'ambientLightInteriorColour', request(n)))
            .then(() => { this.error = null; }, (e) => { this.error = String(e && e.message || e); this.log.warn('ambient: setting colour ' + n + ': ' + this.error); })
            .then(() => { this._busy = false; this.emit('change'); this._next(); });
    }

    stop() { clearTimeout(this._timer); this._timer = null; }
}

module.exports = { Ambient, modeOf, slotOf, request, MODES, SLOTS, MIN_GAP_MS };
