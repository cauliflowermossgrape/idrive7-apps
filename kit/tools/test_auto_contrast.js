'use strict';
// The Auto colour themes (kit/runtime/autolook.js): day / night held 10 s before the look follows the car, the clock
// until the car speaks, fast above 100 km/h and back below 90 after 3 s, the 3 s blend, warnings unchanged, fixed
// themes passed through and no signal watched for them, the Display look row; and build.py adding the choices.
//   node kit/tools/test_auto_contrast.js
const path = require('path');
const { execFileSync } = require('child_process');
const A = require(path.join(__dirname, '..', 'runtime', 'autolook.js'));
const themes = require(path.join(__dirname, '..', 'runtime', 'themes.js'));

let checks = 0, fails = 0;
const ok = (c, m) => { checks++; if (!c) { fails++; console.log('FAIL ' + m); } else console.log('ok   ' + m); };
const lum = (c) => { const v = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };

// the looks
const base = themes.theme('m_tricolour');
const day = A.compose('m_tricolour', 'm_tricolour', 0, 0), night = A.compose('m_tricolour', 'm_tricolour', 1, 0);
const fast = A.compose('m_tricolour', 'm_tricolour', 0, 1), amber = A.compose('m_tricolour', 'amber', 1, 0);
ok(lum(day.text) >= lum(base.text) && lum(day.dim) > lum(base.dim), 'day: text and secondary text brighter than the base theme');
ok(lum(night.bg) < lum(base.bg) && lum(night.panelTop) < lum(base.panelTop), 'night: background and panels darker');
ok(lum(night.text) < lum(day.text) && lum(night.accent) < lum(day.accent), 'night: text and accents softer');
ok(night.crit === base.crit && night.warn === base.warn, 'night: warnings keep their colour');
ok(lum(fast.dim) < lum(day.dim) && fast.text === day.text, 'fast: secondary text quieter, the numbers stay');
ok(amber.text === A.mix(themes.theme('amber').text, themes.theme('amber').dim, 0.45), 'Auto, amber at night: amber text by night');

// the state: clock first, then the car held 10 s, then the 3 s blend
let now = new Date(2026, 10, 26, 22, 0, 0).getTime();
const s = new A.LookState(() => now);
ok(s.tick().n === 1 && s.byClock(), 'no word from the car at 22:00: night, by the clock');
s.dayNight('TAG');
now += 5000; ok(s.tick().n === 1, 'the car says day: nothing changes for 5 s');
now += 5000; s.tick();
now += 1500; const half = s.tick().n;
ok(half > 0.3 && half < 0.8, 'held 10 s: the look starts to move to day (' + half.toFixed(2) + ' after 1.5 s)');
now += 2000; ok(s.tick().n === 0 && !s.byClock(), 'after the 3 s blend: day, by the car');
s.dayNight({ dayNightChangeOver: 'NACHT' }); now += 3000; s.tick(); s.dayNight('TAG'); now += 9000;
ok(s.tick().n === 0, 'a short night (a tunnel) does not flip the look');
s.dayNight(2); now += 10000; s.tick(); now += 3000;
ok(s.tick().n === 1, 'night held 10 s (as a number too): night');
// fast
s.speedKmh(120); now += 100; s.tick(); now += 3000;
ok(s.tick().f === 1, 'above 100 km/h: fast look');
s.speedKmh(95); now += 5000; ok(s.fast && s.tick().f === 1, '95 km/h: still fast (back only below 90)');
s.speedKmh(80); now += 1000; s.tick(); now += 1000; ok(s.fast, 'below 90 for 2 s: still fast');
now += 2000; s.tick(); now += 3000; ok(!s.fast && s.tick().f === 0, 'below 90 for 3 s: fast look off');
const morning = new A.LookState(() => new Date(2026, 10, 26, 9, 0, 0).getTime());
ok(morning.tick().n === 0, 'no word from the car at 09:00: day, by the clock');

// attach: fixed themes pass through and watch nothing; Auto watches the two signals once
const watched = [];
const mk = (themeId) => {
    const vals = { theme: themeId };
    return A.attach({
        settings: { get: (k) => vals[k], item: (k) => (k === 'theme' ? { key: 'theme' } : null) },
        signals: { watch: (iface, inst, h) => { watched.push(iface); return Promise.resolve({ shutdown() {} }); } },
        log: { warn() {}, info() {} },
    });
};
const fixed = mk('amber');
ok(fixed.theme() === themes.theme('amber') && watched.length === 0, 'a fixed theme: the same object, nothing watched');
const auto = mk('auto');
const t1 = auto.theme(), t2 = auto.theme();
ok(t1 === t2 && /^Auto/.test(t1.name) && t1.lookKey, 'Auto: one object per look step (layers cached by its name)');
ok(watched.sort().join(',') === 'de.bmw.infotainment.vehicle.Vehicle,de.bmw.infotainment.vehicle.Vehicle2', 'Auto: day / night and speed watched, once');
const row = auto.row();
ok(row && row.label === 'Display look' && /by the clock/.test(row.value()), 'Display look row: says it goes by the clock until the car speaks');
const sheet = row.open();
const texts = [];
const rec = { clear() {}, text(s) { texts.push(String(s)); }, roundRect() {}, strokeRoundRect() {} };
const targets = sheet.draw(rec, t1);
ok(texts.some((x) => /Goes by the clock/.test(x)) && texts.includes('DAY') && texts.includes('NIGHT') && texts.includes('FAST')
    && targets.length === 1 && targets[0].act() === 'close', 'Display look page: inputs, three looks, Back');

// build.py: an app with a theme choice gets the Auto choices and the two signals (optional where new)
const py = process.platform === 'win32' ? 'python' : 'python3';
const out = execFileSync(py, ['-c', [
    'import sys, json; sys.path.insert(0, ' + JSON.stringify(path.join(__dirname)) + ')',
    'import build',
    'a = {"settings": [{"key": "theme", "type": "choice", "options": [["m_red", "M Red"]]}], "signals": {"de.bmw.infotainment.vehicle.Vehicle2": {"statusCarSpeed2": "rs"}}}',
    'b = {"settings": [{"key": "x", "type": "bool"}]}',
    'print(json.dumps([build.add_auto_look(a), a, build.add_auto_look(b), b, build.add_auto_look(a), a]))',
].join('\n')], { encoding: 'utf8' });
const [ra, sa, rb, sb, ra2, sa2] = JSON.parse(out.trim().split('\n').pop());
ok(ra && sa.settings[0].options.map((o) => o[0]).join(',') === 'm_red,auto,auto_amber', 'build: the Auto choices added after the app\'s own');
ok(sa.signals['de.bmw.infotainment.vehicle.Vehicle']._optional && sa.signals['de.bmw.infotainment.vehicle.Vehicle'].statusDayNightChangeOver === 'rs',
    'build: day / night added as an optional interface');
ok(!rb && !sb.signals, 'build: an app with no theme choice is left alone');
ok(ra2 && sa2.settings[0].options.length === 3, 'build: run twice, no doubles');

console.log('auto contrast: ' + checks + ' checks, ' + fails + ' failed');
process.exit(fails ? 1 : 0);
