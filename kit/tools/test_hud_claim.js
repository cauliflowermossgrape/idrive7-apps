'use strict';
// kit/runtime/hud_claim.js and Redline's side of it: a claim seen by the others while held, the standing
// app's marker, and Redline's HUD off again at a head-unit start or the car's switch-off (with a standing
// app installed), on otherwise.
//   node kit/tools/test_hud_claim.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hud-claim-'));
process.env.MGU_HUD_CLAIMS = path.join(TMP, 'shm');
const ROOT = path.join(__dirname, '..', '..');
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req.startsWith('./kit/')) return load.call(this, path.join(ROOT, 'kit', 'runtime', req.slice(6)), parent, isMain);
    if (req === './cluster_render_client') throw new Error('not in this test');
    return load.call(this, req, parent, isMain);
};
const { HudClaim } = require(path.join(ROOT, 'kit', 'runtime', 'hud_claim'));
const Hud = require(path.join(ROOT, 'apps', 'redline', 'hud'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const log = { info() {}, warn() {}, error() {} };
const dataOf = (id) => { const d = path.join(TMP, 'apps', id, 'data'); fs.mkdirSync(d, { recursive: true }); return d; };

const a = new HudClaim('a', log);
ok(!a.thisBoot() && HudClaim.others('b').length === 0, 'nothing held at the start');
a.hold(true);
ok(HudClaim.others('b').join() === 'a' && HudClaim.others('a').length === 0, 'a held claim is seen by the others');
a.hold(false);
ok(HudClaim.others('b').length === 0 && a.thisBoot(), 'given back: not seen, still known for this boot');

const wc = dataOf('robertn_waze_cluster'), rl = dataOf('redline');
ok(!HudClaim.standingOn(rl), 'no standing app');
HudClaim.standing(wc, true);
ok(HudClaim.standingOn(rl) && !HudClaim.standingOn(wc), 'a standing app is seen by the others, not by itself');

const settings = (hud) => {
    const v = { hud }, fns = [];
    return { v, get: (k) => v[k], set: (k, x) => { v[k] = x; fns.forEach((f) => f(k, x)); }, onChange: (f) => fns.push(f) };
};
let cond;
const start = (s) => Hud.start({ settings: s, log, dataDir: rl }, { data: () => ({ condition: cond }), shiftPoint: () => ({}), redline: () => 6500, maxRpm: () => 7000 });

// a head unit start (no claim of Redline's on tmpfs): off again
let s = settings('on');
let h = start(s);
ok(s.v.hud === 'off', 'a new head-unit start: Redline\'s HUD off, back to the standing app');
h.stop();

// turned on in this boot: Redline holds the HUD until the car is switched off
s = settings('off'); h = start(s);
s.set('hud', 'on');
ok(HudClaim.others('robertn_waze_cluster').join() === 'redline', 'turned on: Redline holds the HUD');
cond = 10;
setTimeout(() => {
    ok(s.v.hud === 'on', 'still on while driving');
    cond = 5;
    setTimeout(() => {
        ok(s.v.hud === 'off' && HudClaim.others('robertn_waze_cluster').length === 0, 'switched off: Redline\'s HUD off, the claim given back');
        h.stop();
        // without a standing app Redline keeps its HUD on
        HudClaim.standing(wc, false);
        s = settings('on'); fs.rmSync(process.env.MGU_HUD_CLAIMS, { recursive: true, force: true });
        h = start(s);
        ok(s.v.hud === 'on', 'no standing app: Redline\'s HUD stays on after a start');
        console.log('hud claim: ' + checks + ' checks, ' + fails + ' failed');
        process.exit(fails ? 1 : 0);
    }, 2300);
}, 2300);
