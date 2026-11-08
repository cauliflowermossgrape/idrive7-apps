'use strict';
/**
 * hud_claim.js - which app shows on the head-up display when more than one can.
 *
 * A standing app (Cluster functions) shows on the HUD whenever it is on. Another app the driver turns on
 * for the HUD (Redline) takes it over until the car is switched off, then the standing app has it again.
 *
 *   - An app holding the HUD keeps a claim, /dev/shm/mgu-hud/<id>, touched every 2 s. It is on tmpfs, so a
 *     head-unit start clears it; a claim not touched for 6 s (its app stopped) counts for nothing.
 *   - The standing app gives way while another app's claim is fresh (HudClaim.others).
 *   - The standing app says it is installed and on in its data/hud-standing ({"on": true}); an app that
 *     takes the HUD over turns its own HUD off again at the car's switch-off or the head unit's next start,
 *     only while such an app is installed (HudClaim.standingOn).
 *
 *   const claim = new HudClaim(id, log)
 *   claim.hold(on)                    take the HUD (true) or give it back
 *   claim.thisBoot()                  this app held the HUD since the head unit started
 *   HudClaim.others(id)               ids of the other apps holding the HUD now
 *   HudClaim.standing(dataDir, on)    (the standing app) installed, and on or off
 *   HudClaim.standingOn(dataDir)      another installed app stands on the HUD (dataDir: this app's own)
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.MGU_HUD_CLAIMS || '/dev/shm/mgu-hud';
const TOUCH_MS = 2000, FRESH_MS = 6000;
const STANDING = 'hud-standing';

class HudClaim {
    constructor(id, log) {
        this.id = id;
        this.log = log;
        this.file = path.join(DIR, id);
        this.timer = null;
    }

    hold(on) {
        if (!!on === !!this.timer) return;
        if (on) {
            this._touch();
            this.timer = setInterval(() => this._touch(), TOUCH_MS);
            if (this.timer.unref) this.timer.unref();
        } else {
            clearInterval(this.timer);
            this.timer = null;
            try { fs.writeFileSync(this.file, JSON.stringify({ held: false, at: Date.now() }) + '\n'); } catch (e) { /* tmpfs gone */ }
        }
    }

    // the file stays when given back (held false): the head unit has not restarted since
    thisBoot() { return fs.existsSync(this.file); }

    _touch() {
        try {
            fs.mkdirSync(DIR, { recursive: true, mode: 0o777 });
            fs.writeFileSync(this.file, JSON.stringify({ held: true, at: Date.now() }) + '\n');
        } catch (e) { if (this.log) this.log.warn('HUD claim: ' + e.message); }
    }

    static others(id) {
        let names = [];
        try { names = fs.readdirSync(DIR); } catch (e) { return []; }
        const now = Date.now();
        return names.filter((n) => {
            if (n === id) return false;
            try {
                const f = path.join(DIR, n);
                return now - fs.statSync(f).mtimeMs < FRESH_MS && JSON.parse(fs.readFileSync(f, 'utf8')).held === true;
            } catch (e) { return false; }
        });
    }

    static standing(dataDir, on) {
        if (!dataDir) return;
        const f = path.join(dataDir, STANDING);
        try {
            if (JSON.parse(fs.readFileSync(f, 'utf8')).on === !!on) return;
        } catch (e) { /* not written yet */ }
        try { fs.writeFileSync(f + '.tmp', JSON.stringify({ on: !!on }) + '\n'); fs.renameSync(f + '.tmp', f); } catch (e) { /* read-only */ }
    }

    static standingOn(dataDir) {
        if (!dataDir) return false;
        const appDir = path.dirname(dataDir), parent = path.dirname(appDir);
        let dirs = [];
        try { dirs = fs.readdirSync(parent); } catch (e) { return false; }
        return dirs.some((d) => {
            if (path.join(parent, d) === appDir) return false;
            try { return JSON.parse(fs.readFileSync(path.join(parent, d, 'data', STANDING), 'utf8')).on === true; } catch (e) { return false; }
        });
    }
}

module.exports = { HudClaim, DIR };
