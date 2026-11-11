'use strict';
/**
 * others.js - another ambient light app's service running beside this app. IterioDev's Comfort tool (the service
 * behind his Ambient Light app, github.com/IterioDev/car-apps) writes the same light modules through the body
 * controller, with its own colours every 2 minutes. With both on, the colours jump between the two apps, and
 * Comfort keeps its colours after his app is uninstalled (it is a tool of its own). Its control socket is there
 * exactly while it runs (systemd RuntimeDirectory), and apps can see it (his apps connect to it).
 *
 *   const o = new Others({ log }); o.start();
 *   o.comfort -> true while Comfort runs        o.on('change', fn)
 */
const EventEmitter = require('events');
const fs = require('fs');

const COMFORT_SOCK = process.env.MGU_AMBIENT_COMFORT || '/run/iteriodev-comfort/ctl.sock';
const EVERY_MS = 10000;

class Others extends EventEmitter {
    constructor(o) {
        super();
        this.log = o && o.log; this.comfort = false; this._timer = null;
    }

    start() { this.check(); this._timer = setInterval(() => this.check(), EVERY_MS); return this; }

    stop() { clearInterval(this._timer); }

    check() {
        let on = false;
        try { on = fs.statSync(COMFORT_SOCK).isSocket(); } catch (e) { /* not running */ }
        if (on === this.comfort) return;
        this.comfort = on;
        if (this.log) {
            if (on) this.log.warn('IterioDev\'s Comfort tool is running: it writes the ambient lights too, so the colours jump between the two apps');
            else this.log.info('IterioDev\'s Comfort tool is no longer running');
        }
        this.emit('change');
    }
}

module.exports = { Others, COMFORT_SOCK };
