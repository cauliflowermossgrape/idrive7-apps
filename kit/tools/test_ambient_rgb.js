'use strict';
// Ambient config's any colour (apps/ambient_config: lin.js, scenes.js, lights.js, control.js): the body controller's
// status read and writes, the animations, one write at a time with the lights renewed and given back, the
// driving modes' looks, favourites and the flash file.
//   node kit/tools/test_ambient_rgb.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ambient-rgb-'));
process.env.MGU_AMBIENT_FLASH = path.join(TMP, 'flash.json');
const A = path.join(__dirname, '..', '..', 'apps', 'ambient_config');
const L = require(path.join(A, 'lin'));
const S = require(path.join(A, 'scenes'));
const { Lights } = require(path.join(A, 'lights'));
const { Control, DEFAULT_LOOK } = require(path.join(A, 'control'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const log = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// status reply: 62 DA5F, records of 10 (location, blue, green, red, brightness, white, 4 faults), empty FF
const reply = (did, locs, fault) => {
    const b = [0x62].concat(did);
    for (let i = 0; i < 26; i++) b.push.apply(b, locs[i] ? [locs[i], 254, 60, 120, 100, 0, fault === i ? 1 : 0, 0, 0, 0] : [0xff, 0xff, 0xff, 0xff, 0x7f, 3, 7, 7, 7, 7]);
    return b.concat([2]);
};
// the ring: a tap near red / green / blue gives exactly that colour; the < / > steps land on them (#135)
const same = (a, b) => a.join() === b.join();
ok(same(S.hsv(S.snapHue(3), 1, 1), [255, 0, 0]) && same(S.hsv(S.snapHue(357.5), 1, 1), [255, 0, 0]), 'a tap 3 degrees off red is red');
ok(same(S.hsv(S.snapHue(118), 1, 1), [0, 255, 0]) && same(S.hsv(S.snapHue(244), 1, 1), [0, 0, 255]), 'near green / blue: exactly green / blue');
ok(S.snapHue(20) === 20 && S.snapHue(90) === 90, 'a hue between them stays as tapped');
let h = S.hueOf([120, 60, 255]), seen = [];      // the default violet, 258.5 degrees
for (let i = 0; i < 24; i++) { h = S.stepHue(h, 15); seen.push(h); }
ok(seen.indexOf(0) >= 0 && seen.indexOf(120) >= 0 && seen.indexOf(240) >= 0 && seen.every((x) => x % 15 === 0 && x >= 0 && x < 360), '> from violet comes to 0, 120, 240 exactly');
ok(S.stepHue(0, -15) === 345 && S.stepHue(345, 15) === 0, '< from red wraps to 345, > back to red');
const bus1 = L.parseStatus(0, reply([0xda, 0x5f], [0x0f, 0x0e, 0x0c], 1));
ok(bus1.length === 3 && bus1[2].nad === 3 && bus1[2].name === 'Passenger front door line' && bus1[2].part === 'upper' && bus1[1].part === 'lower', 'status: lights, places, upper / lower');
ok(bus1[0].rgb.join() === '120,60,254' && bus1[0].bright === 100 && bus1[1].fault && !bus1[0].fault, 'status: colour read red, green, blue; a fault');
ok(L.parseStatus(0, [0x7f, 0x22, 0x31]) === null && L.parseStatus(1, reply([0xda, 0x5f], [1])) === null, 'status: a refusal or another bus\'s reply is none');
ok(L.writeFrame(0, 3, [255, 0, 300], 120, 400).join() === [0xda, 0x5e, 3, 1, 100, 0xfe, 0, 0xfe, 254].join(), 'write: colours stop at FE, brightness 100, 254 s');
ok(L.writeFrame(1, 1, [10, 20, 30], 50, 5).slice(0, 2).join() === [0xe3, 0xd1].join() && L.releaseFrame(1, 4).join() === [0xe3, 0xd1, 4, 0, 0, 0, 0, 0, 0].join(), 'bus 2 write; give back');
ok(L.sample().length === 19, 'the picture\'s G20 before the car answers');

// scenes
const look = (kind, extra) => Object.assign({ kind, upper: { rgb: [255, 0, 0], bright: 80 }, lower: { rgb: [0, 0, 255], bright: 40 }, speed: 2 }, extra);
const up = { part: 'upper', y: 0.2 }, low = { part: 'lower', y: 0.8 };
ok(S.lightAt(look('solid'), up, 0).rgb.join() === '255,0,0' && S.lightAt(look('solid'), low, 0).bright === 40, 'solid: upper and lower colours');
const br = [0, 1000, 2000].map((t) => S.lightAt(look('breathing'), up, t).bright);
ok(br[0] < 15 && br[2] === 80 && br[1] > br[0] && br[1] < br[2], 'breathing: dim to bright (' + br + ')');
ok(S.lightAt(look('rainbow'), up, 0).rgb.join() !== S.lightAt(look('rainbow'), up, 4000).rgb.join(), 'rainbow moves on');
ok(S.lightAt(look('fade'), up, 0).rgb.join() === '255,0,0' && S.lightAt(look('fade'), up, 4000).rgb.join() === '0,0,255', 'fade: upper colour to lower');
ok(S.lightAt(look('wave'), { part: 'upper', y: 0 }, 0).rgb.join() !== S.lightAt(look('wave'), { part: 'upper', y: 0.25 }, 0).rgb.join(), 'wave: front and rear differ');
ok(S.lightAt(look('welcome'), { part: 'upper', y: 0.9 }, 100).bright === 0 && S.lightAt(look('welcome'), { part: 'upper', y: 0.9 }, 2600).bright === 80, 'welcome: the rear comes on last');
ok(S.lightAt(look('pulse'), low, 1000).rgb.join() === '255,0,0' && S.lightAt(look('pulse'), low, 1600).rgb.join() === '0,0,255', 'pulse: red for 1.5 s, then the colour');
ok(S.moves(look('wave')) && !S.moves(look('solid')) && S.lasts(look('welcome')) > 0 && S.lasts(look('wave')) === 0, 'moving and once-only scenes');
ok(Math.round(S.hueOf([0, 0, 255])) === 240 && S.hsv(120, 1, 1).join() === '0,255,0', 'hue');

(async () => {
    // a body controller (as the car's, BDC_G05): remembers each light's colour, NAD 0 colours every light of its bus,
    // reads report what the lights show; drop: the next write to that NAD is answered but not taken (as the car does)
    const BUS = [[0x0f, 0x0c], [0x15, 0x01, 0x05, 0x13]];
    const lit = BUS.map((b) => b.map(() => [0, 0, 0]));
    const writes = [];
    let refuse = false, drop = null;
    const diag = {
        physical: async (target, sid, data) => {
            await sleep(2);
            if (target !== L.BDC) return null;
            const bus = data[0] === 0xda ? 0 : 1;
            if (sid === 0x22) {
                const b = [0x62].concat(data);
                for (let i = 0; i < 26; i++) b.push.apply(b, BUS[bus][i] ? [BUS[bus][i], lit[bus][i][2], lit[bus][i][1], lit[bus][i][0], 100, 0, 0, 0, 0, 0] : [0xff, 0xff, 0xff, 0xff, 0x7f, 3, 7, 7, 7, 7]);
                return b.concat([2]);
            }
            writes.push(data.slice());
            if (refuse) return [0x7f, 0x2e, 0x22];
            const nad = data[2], rgb = data[3] ? data.slice(5, 8) : [0, 0, 0];
            if (drop !== null && drop.bus === bus && drop.nad === nad) drop = null;
            else if (nad === 0) lit[bus].forEach((x, i) => { lit[bus][i] = rgb; });
            else if (lit[bus][nad - 1]) lit[bus][nad - 1] = rgb;
            return [0x6e, data[0], data[1]];
        },
    };
    const lights = new Lights({ diag, log, checkMs: 40 });
    const found = await lights.find();
    ok(found.length === 6 && lights.state === 'car', 'find: both buses, nothing written yet');
    ok(writes.length === 0, 'nothing written before a colour is picked');

    lights.show(look('solid', { lower: { rgb: [255, 0, 0], bright: 80 } }));
    await sleep(100);
    ok(writes.length === 2 && writes.every((w) => w[2] === 0) && lights.state === 'ours', 'one colour on every light: one write a bus, NAD 0 (' + writes.length + ')');
    ok(lit[0].concat(lit[1]).every((c) => c.join() === '254,0,0'), 'every light red');

    writes.length = 0;
    lights.show(look('solid'));
    await sleep(100);
    const fw = writes.find((w) => w[0] === 0xe3 && w[2] === 2);
    ok(writes.length === 2 && writes.every((w) => w[2] !== 0), 'from all red to lower blue: only the two lower lights written, the red ones left as they are (' + writes.map((w) => w[2]).join() + ')');
    ok(fw && fw[4] === 40 && fw[7] === 0xfe && fw[8] === 60, 'the footwell (lower): blue at 40 %, held 60 s');
    ok(lit[1][1].join() === '0,0,254' && lit[1][0].join() === '254,0,0', 'the footwell blue, the dash red');
    await sleep(300);
    ok(writes.length === 2, 'a still colour: read back, nothing more until the renewal');

    // the body controller drops a write (answered 6E, not taken): the read-back writes it again
    writes.length = 0; drop = { bus: 1, nad: 0 };
    lights.show(look('solid', { upper: { rgb: [0, 255, 0], bright: 80 }, lower: { rgb: [0, 255, 0], bright: 80 } }));
    await sleep(400);
    ok(lit[1].every((c) => c.join() === '0,254,0') && writes.length === 3, 'a dropped write: seen in the read-back, written again (' + writes.length + ')');

    writes.length = 0;
    lights.show(look('breathing', { speed: 3 }));
    await sleep(600);
    ok(writes.length > 10 && writes.every((w) => w[8] === 5) && writes.filter((w) => w[2] === 0).length > 5, 'moving: written over and over, held 5 s, a bus at a time (' + writes.length + ')');
    writes.length = 0;
    lights.show(look('rainbow'));
    await sleep(60);
    ok(writes.length >= 2 && writes.slice(0, 2).every((w) => w[2] === 0 && w.slice(5, 8).join() === writes[0].slice(5, 8).join()), 'rainbow: the whole car one colour, 2 writes a frame');
    writes.length = 0;
    lights.show(look('wave'));
    await sleep(100);
    ok(writes.some((w) => w[2] !== 0), 'a colour wave (the lights their own colours): a write a light');

    writes.length = 0;
    lights.carColour();
    await sleep(300);
    const offs = writes.filter((w) => w[3] === 0 && w[8] === 0);
    ok(offs.length === 2 && offs.every((w) => w[2] === 0) && lights.state === 'car', 'original colour: every light given back, one write a bus (' + writes.map((w) => w[2] + '/' + w[3]).join() + ')');
    ok(lit[0].concat(lit[1]).every((c) => c.join() === '0,0,0'), 'every light given back');

    writes.length = 0;
    lights.flash([0, 255, 0], 200);
    await sleep(120);
    ok(writes.length >= 2 && writes.slice(0, 2).every((w) => w[2] === 0 && w[5] === 0 && w[6] === 0xfe), 'flash: green on every light, one write a bus');
    await sleep(500);
    ok(lit[0].concat(lit[1]).every((c) => c.join() === '0,0,0'), 'after the flash with the car\'s colour on: given back');

    refuse = true; writes.length = 0;
    lights.show(look('solid', { upper: { rgb: [1, 2, 3], bright: 50 } }));
    await sleep(400);
    ok(writes.length === 4 && /refused/.test(lights.error), 'refused writes: paused after 4 (' + writes.length + ', ' + lights.error + ')');
    refuse = false;
    lights.stop();

    // control: the driver's look, driving modes, favourites
    const values = { follow: true, keep: true, welcome: false, sportPulse: true, nightDim: true, flashAlerts: true }, fns = [];
    const settings = { get: (k) => values[k], set: (k, v) => { values[k] = v; fns.forEach((f) => f(k, v)); }, onChange: (f) => fns.push(f) };
    const shows = [];
    const fake = { scene: null, show(s) { this.scene = s; shows.push(s); }, carColour() { this.scene = null; shows.push(null); }, dim(f) { this.f = f; }, flash(rgb, ms) { this.flashed = [rgb, ms]; } };
    const amb = new EventEmitter(); amb._m = 'comfort'; amb.mode = () => amb._m;
    const c = new Control({ settings, lights: fake, ambient: amb, log });
    c.start();
    ok(shows.length === 1 && shows[0] === null, 'start: nothing picked, the car\'s colour');
    c.setLook({ upper: { rgb: [0, 255, 0], bright: 70 } });
    ok(values.on === true && fake.scene.upper.rgb.join() === '0,255,0' && fake.scene.lower.rgb.join() === DEFAULT_LOOK.lower.rgb.join(), 'a colour picked: on, the rest of the look kept');
    c.setModeLook('sport', look('breathing'));
    amb._m = 'sport'; amb.emit('change');
    ok(fake.scene.kind === 'pulse' && fake.scene.then.kind === 'breathing', 'Sport picked: the pulse, then Sport\'s look');
    amb._m = 'comfort'; amb.emit('change');
    ok(fake.scene.kind === 'solid' && fake.scene.upper.rgb.join() === '0,255,0', 'Comfort (Leave as is): the driver\'s look back');
    settings.set('follow', false); c.apply();
    amb._m = 'sport'; amb.emit('change');
    ok(fake.scene.upper.rgb.join() === '0,255,0' && fake.scene.kind !== 'breathing', 'not following: the driver\'s look in Sport too');
    settings.set('follow', true);
    c.carColour();
    amb._m = 'comfort'; amb.emit('change');
    ok(fake.scene === null, 'car colour back, Comfort Leave as is: the car\'s colour');
    c.setLook({ upper: { rgb: [0, 255, 0], bright: 70 } });
    c.setModeLook('comfort', 'original');
    ok(fake.scene === null && c.modeOriginal('comfort'), 'Comfort on Original colour: BMW\'s colour, the Colour tab\'s colour on');
    c.setModeLook('comfort', null);
    ok(fake.scene && fake.scene.upper.rgb.join() === '0,255,0', 'Original colour undone: the Colour tab\'s colour back');
    c.carColour();
    c.night(true); ok(fake.f === 0.5, 'night: dimmer');
    settings.set('nightDim', false); c.night(true); ok(fake.f === 1, 'night dimming off');

    for (let i = 0; i < 7; i++) { c.setLook({ upper: { rgb: [i, 0, 0], bright: 50 } }); c.saveFav(); }
    ok(c.favs().length === 6 && c.favs()[0].upper.rgb[0] === 1, 'favourites: six, the oldest goes');
    c.useFav(2); ok(c.look().upper.rgb[0] === 3 && values.on, 'a favourite put on');
    c.dropFav(0); ok(c.favs().length === 5, 'a favourite deleted');

    fs.writeFileSync(process.env.MGU_AMBIENT_FLASH, JSON.stringify({ rgb: [0, 255, 0], ms: 900 }));
    await sleep(700);
    ok(fake.flashed && fake.flashed[1] === 1000, 'the flash file: a flash, at least 1 s (all the lights)');
    settings.set('flashAlerts', false); fake.flashed = null;
    await sleep(50);
    fs.writeFileSync(process.env.MGU_AMBIENT_FLASH, JSON.stringify({ rgb: [0, 255, 0], ms: 900 }));
    const t = new Date(Date.now() + 2000); fs.utimesSync(process.env.MGU_AMBIENT_FLASH, t, t);
    await sleep(700);
    ok(!fake.flashed, 'flashes off: none');
    c.stop();

    // a restart with Welcome on: the sweep, then the look
    values.welcome = true; shows.length = 0;
    const c2 = new Control({ settings, lights: fake, ambient: amb, log });
    c.setLook({ kind: 'solid' }); shows.length = 0;
    c2.start();
    ok(shows[0].kind === 'welcome' && shows[0].then.kind === 'solid', 'welcome sweep at start, then the look');
    c2.stop();

    fs.unlinkSync(process.env.MGU_AMBIENT_FLASH); fs.rmdirSync(TMP);
    console.log('ambient rgb: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
