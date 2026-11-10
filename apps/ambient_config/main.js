'use strict';
/**
 * Ambient config - any colour on the car's ambient light, animations, and a look for each driving mode.
 *
 * Tabs:
 *   Colour         the colour ring (and white) for the whole car, the upper lights or the lower ones, the
 *                  brightness, and the car from above lit as the car is; Original colour gives the light back
 *   Animations     Solid, Breathing, Rainbow, Smooth fade, Colour wave, how fast, shown moving on the car picture
 *   Driving modes  for each driving mode the car has: Choose colour (the Colour and Animations tabs change that mode's
 *                  look until Done), the animation button stepping through them, or Original colour (BMW's); with
 *                  nothing chosen, the Colour tab's colour; welcome sweep, Sport pulse, Redline's shift flash
 *   Favourites     six saved looks: tap to put one on
 * Everything goes to the car as it is picked. The lights are driven through the body controller (lights.js); a car
 * whose body controller does not answer keeps BMW's own colours (ambient.js), offered on the Colour tab.
 * It runs from the platform's start (app.json "autostart"): the look and the driving modes work with the app closed.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { Diag } = require('./kit/diag');
const { Ambient, SLOTS } = require('./ambient');
const { Lights } = require('./lights');
const { Control } = require('./control');
const { drawCabin } = require('./cabin');
const { sample } = require('./lin');
const S = require('./scenes');

const W = 1600, H = 520;
const TABS = ['Colour', 'Animations', 'Driving modes', 'Favourites'];
const MODE_NAMES = { sport: 'Sport', comfort: 'Comfort', eco: 'Eco Pro', adaptive: 'Adaptive', hybrid: 'Hybrid', electric: 'Electric' };
const QUICK = [['Red', [255, 0, 0]], ['Orange', [255, 100, 0]], ['Amber', [255, 170, 0]], ['Yellow', [255, 235, 0]], ['Green', [0, 255, 60]],
    ['Cyan', [0, 230, 255]], ['Blue', [0, 70, 255]], ['Violet', [120, 60, 255]], ['Pink', [255, 40, 170]], ['White', [255, 255, 255]]];
const RING = { cx: 290, cy: 288, R: 186, r: 136 }, DIAL = { cx: 655, cy: 400, R: 54, r: 43 };

const ON_BY_DEFAULT = ['follow', 'flashAlerts'];
const DAY_NIGHT = { KEINE_AENDERUNG: 0, TAG: 1, NACHT: 2, SIGNAL_UNGUELTIG: 3 };

async function background(bg) {
    const { settings, signals, log } = bg;
    const ambient = new Ambient({ settings, signals, log });
    await ambient.start();
    const diag = await new Diag(signals, log).init();
    diag.quiet = true; diag.busyLog = false;
    const lights = new Lights({ diag, log });
    const control = new Control({ settings, lights, ambient, log });
    control.start();
    // with the lights answering, the driving modes' looks replace BMW's colours by mode (ambient.js)
    lights.on('change', () => { ambient.slotsOff = lights.lights.length > 0; });
    const find = () => lights.find().then((l) => { if (!l.length) setTimeout(find, 120000); }, (e) => { log.warn('lights: ' + e); setTimeout(find, 120000); });
    find();
    signals.watch('de.bmw.infotainment.vehicle.Vehicle', '1', {
        statusDayNightChangeOver: (v) => {
            const x = v && typeof v === 'object' ? v.dayNightChangeOver : v, c = typeof x === 'string' ? DAY_NIGHT[x] : x;
            if (c === 1 || c === 2) control.night(c === 2);
        },
    }, log).catch((e) => log.warn('day / night: ' + (e && e.message || e)));
    settings.onChange((key) => { if (key === 'nightDim') control.night(control._night); if (key === 'follow') control.apply(); });
    return { ambient, lights, control };
}

const nearest = (rgb) => {
    const sat = (Math.max.apply(null, rgb) - Math.min.apply(null, rgb)) / Math.max(1, Math.max.apply(null, rgb));
    if (sat < 0.25) return 'White';
    const h = S.hueOf(rgb);
    let best = QUICK[0], d = 999;
    QUICK.forEach((q) => { if (q[0] === 'White') return; const e = Math.abs(((S.hueOf(q[1]) - h + 540) % 360) - 180); if (e < d) { d = e; best = q; } });
    return best[0];
};
const textOn = (rgb) => (rgb[0] * 0.3 + rgb[1] * 0.59 + rgb[2] * 0.11 > 150 ? '#101010' : '#ffffff');

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const { ambient, lights, control } = ctx.background || await background(ctx);
        // editing: null (the driver's own look) or a driving mode whose look the Colour and Animations tabs change
        let page = 0, part = 'all', dirty = true, editing = null;
        const T0 = Date.now();

        const look = () => (editing ? control.modeLook(editing) || control.look() : control.look());
        const setLook = (patch) => (editing ? control.setModeLook(editing, Object.assign(look(), patch)) : control.setLook(patch));
        const isOn = () => (editing ? !!control.modeLook(editing) : control.on());
        const done = () => { editing = null; page = 2; return redraw(); };
        // what the picture shows: a driving mode being changed as it will look, else the lights as the car shows them
        const pictureOf = (l, lk) => (editing ? (x) => S.lightAt(lk, x, Date.now() - T0) : l);
        const partColour = (l) => (part === 'lower' ? l.lower : l.upper);
        const shown = () => (lights.lights.length ? lights.lights : sample());
        const rhd = () => settings.get('drive') === 'rhd';
        const redraw = () => { dirty = true; return render(); };

        const setRgb = (rgb) => {
            const l = look(), b = partColour(l).bright;
            const c = { rgb: rgb.slice(), bright: b || 80 };
            if (part !== 'lower') l.upper = c;
            if (part !== 'upper') l.lower = Object.assign({}, c, part === 'all' ? {} : { bright: l.lower.bright });
            setLook({ upper: l.upper, lower: l.lower });
            return redraw();
        };
        const setBright = (b) => {
            const l = look(), v = Math.max(5, Math.min(100, Math.round(b)));
            if (part !== 'lower') l.upper.bright = v;
            if (part !== 'upper') l.lower.bright = v;
            setLook({ upper: l.upper, lower: l.lower });
            return redraw();
        };
        const stepHue = (d) => { const c = partColour(look()); return setRgb(S.hsv(S.stepHue(S.hueOf(c.rgb), d), 1, 1)); };

        function status(cv, t, x, y) {
            const n = lights.lights.length;
            const s = lights.state === 'finding' ? 'Looking for the car\'s lights...'
                : lights.state === 'none' ? 'The car\'s lights did not answer'
                    : lights.state === 'car' ? 'Original colour (as set in BMW\'s menu)' : 'On in the car: ' + n + ' lights';
            cv.text(s, x, y, 20, lights.state === 'none' ? t.warn : t.dim);
            if (lights.error && lights.state !== 'none') cv.text(lights.error, x, y + 26, 18, t.warn);
        }
        // the car picture: the lights as the car shows them (the car's own colour: grey)
        const carNow = (l) => (lights.scene ? lights.at(l) : null);

        function drawColour(cv, t) {
            const l = look(), c = partColour(l), sel = nearest(c.rgb);
            G.panel(cv, t, 24, 44, 736, 468, editing ? 'Colour for ' + MODE_NAMES[editing] : 'Colour');
            cv.arc(RING.cx, RING.cy, RING.r, RING.R, 0, 360, '#ff0000', { ramp: ['#ff0000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#ff00ff', '#ff0000'], rampFrom: 0, rampTo: 360 });
            const h = S.hueOf(c.rgb), a = (90 - h) * Math.PI / 180, rm = (RING.R + RING.r) / 2;
            const kx = RING.cx + Math.cos(a) * rm, ky = RING.cy - Math.sin(a) * rm;
            cv.arc(kx, ky, 0, 22, 0, 360, '#ffffff'); cv.arc(kx, ky, 0, 16, 0, 360, S.hsv(h, 1, 1));
            const shownRgb = c.rgb.map((x) => Math.round(x * (0.35 + 0.65 * c.bright / 100)));
            cv.arc(RING.cx, RING.cy, 0, RING.r - 18, 0, 360, shownRgb);
            cv.text(nearest(c.rgb), RING.cx, RING.cy + 4, 38, textOn(shownRgb), { align: 'center', font: 'bold' });
            cv.text(part === 'all' ? 'Whole car' : part === 'upper' ? 'Upper lights' : 'Lower lights', RING.cx, RING.cy + 40, 20, textOn(shownRgb), { align: 'center' });
            G.button(cv, t, 44, 446, 56, 48, '<', () => stepHue(-15), { key: 'h-' });
            G.button(cv, t, 480, 446, 56, 48, '>', () => stepHue(15), { key: 'h+' });

            cv.text('Colouring', 566, 92, 20, t.dim);
            [['all', 'Whole car'], ['upper', 'Upper lights'], ['lower', 'Lower lights']].forEach(([k, n], i) => {
                G.button(cv, t, 566, 104 + i * 56, 176, 46, n, () => { part = k; return redraw(); }, { primary: part === k, key: 'part-' + k });
            });
            // the ring has every colour at its fullest: white is its own button
            G.button(cv, t, 566, 272, 176, 46, 'White', () => setRgb([255, 255, 255]), { primary: isOn() && sel === 'White', key: 'white' });
            cv.arc(DIAL.cx, DIAL.cy, DIAL.r, DIAL.R, -135, 135, withAlpha('#ffffff', 0.12), { round: true });
            cv.arc(DIAL.cx, DIAL.cy, DIAL.r, DIAL.R, -135, -135 + 270 * c.bright / 100, S.hsv(h, 1, 1), { round: true });
            cv.text(c.bright + '%', DIAL.cx, DIAL.cy + 6, 28, t.text, { align: 'center', font: 'bold' });
            cv.text('Brightness', DIAL.cx, DIAL.cy + 32, 15, t.dim, { align: 'center' });
            G.button(cv, t, 580, 464, 64, 44, '-', () => setBright(c.bright - 10), { key: 'b-' });
            G.button(cv, t, 666, 464, 64, 44, '+', () => setBright(c.bright + 10), { key: 'b+' });

            G.panel(cv, t, 776, 44, 800, 468, editing ? MODE_NAMES[editing] + ' will look' : 'In the car');
            if (lights.state === 'none' && !editing) return drawBmwColours(cv, t);
            drawCabin(cv, t, { x: 790, y: 92, w: 330, h: 404 }, shown(), pictureOf(carNow, l), { rhd: rhd() });
            const x = 1150;
            [['Upper', l.upper], ['Lower', l.lower]].forEach(([n, v], i) => {
                cv.roundRect(x, 104 + i * 40, 26, 26, 7, v.rgb);
                cv.text(n + ': ' + nearest(v.rgb) + ', ' + v.bright + '%', x + 38, 124 + i * 40, 20, t.text);
            });
            if (editing) return editBar(cv, t, x);
            G.button(cv, t, x, 210, 268, 48, 'Original colour', () => { control.carColour(); return redraw(); }, { primary: !control.on(), key: 'car' });
            G.button(cv, t, x, 270, 268, 48, 'Save favourite', () => { control.saveFav(); return redraw(); }, { key: 'save' });
            status(cv, t, x, 352);
        }

        // changing a driving mode's look: which mode, and Done back to the Driving modes tab
        function editBar(cv, t, x) {
            cv.text('Changing ' + MODE_NAMES[editing] + '\'s look', x, 222, 22, t.text, { font: 'bold' });
            cv.text('It shows whenever ' + MODE_NAMES[editing] + ' is on.', x, 250, 18, t.dim);
            G.button(cv, t, x, 280, 268, 48, 'Done', done, { primary: true, key: 'done' });
        }

        // the body controller did not answer: BMW's own colours, as BMW's menu has them
        function drawBmwColours(cv, t) {
            cv.text('Any colour needs the body module, which did not answer.', 796, 136, 20, t.warn);
            cv.text('BMW\'s own colours meanwhile:', 796, 164, 20, t.dim);
            const now = ambient.slot();
            for (let i = 0; i < SLOTS; i++) {
                const n = i + 1;
                G.button(cv, t, 796 + (i % 4) * 132, 186 + Math.floor(i / 4) * 62, 120, 50, String(n), () => { ambient.setSlot(n); return redraw(); },
                    { primary: n === now, busy: !ambient.available, key: 'slot-' + n });
            }
            G.button(cv, t, 796, 386, 0, 48, 'Look again', () => { lights.find(); return redraw(); }, { key: 'again' });
        }

        function drawAnimations(cv, t) {
            const l = look();
            G.panel(cv, t, 24, 44, 640, 468, editing ? 'Animation for ' + MODE_NAMES[editing] : 'Animation');
            const kinds = [['solid', 'No animation, a steady colour'], ['breathing', 'Slowly brighter and dimmer'], ['rainbow', 'Every colour in turn'],
                ['fade', 'Upper colour to lower colour and back'], ['wave', 'Colour moving from the dash to the rear']];
            kinds.forEach(([k, d], i) => {
                const y = 92 + i * 66, on = isOn() && l.kind === k;
                G.button(cv, t, 44, y, 220, 50, S.NAMES[k], () => { setLook({ kind: k }); return redraw(); }, { primary: on, key: 'k-' + k });
                cv.text(d, 284, y + 32, 20, on ? t.text : t.dim);
            });
            cv.text('Speed', 44, 470, 20, t.dim);
            [[1, 'Slow'], [2, 'Normal'], [3, 'Fast']].forEach(([v, n], i) => {
                G.button(cv, t, 120 + i * 150, 440, 136, 48, n, () => { setLook({ speed: v }); return redraw(); }, { primary: (l.speed || 2) === v, key: 'sp-' + v });
            });

            G.panel(cv, t, 678, 44, 898, 468, editing ? MODE_NAMES[editing] + ' will look' : 'In the car');
            // the picture shows the animation picked even before the car has answered
            const preview = (x) => (lights.scene ? lights.at(x) : control.on() ? S.lightAt(l, x, Date.now() - T0) : null);
            drawCabin(cv, t, { x: 700, y: 92, w: 420, h: 404 }, shown(), pictureOf(preview, l), { rhd: rhd() });
            const x = 1150;
            [['Upper', l.upper], ['Lower', l.lower]].forEach(([n, v], i) => {
                cv.roundRect(x, 104 + i * 40, 26, 26, 7, v.rgb);
                cv.text(n + ': ' + nearest(v.rgb), x + 38, 124 + i * 40, 20, t.text);
            });
            cv.text('Colours: on the Colour tab', x, 214, 18, t.dim);
            if (editing) return editBar(cv, t, x);
            G.button(cv, t, x, 240, 0, 48, 'Original colour', () => { control.carColour(); return redraw(); }, { primary: !control.on(), key: 'car2' });
            status(cv, t, x, 330);
            if (lights.state === 'ours' && S.moves(lights.scene)) cv.text(lights.rate.toFixed(0) + ' writes a second, ' + lights.fps.toFixed(1) + ' frames a second', x, 390, 18, t.dim);
        }

        function drawModes(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'By driving mode');
            const mine = control.look(), cur = ambient.mode();
            ambient.modes().forEach((m, i) => {
                const y = 92 + i * 72, ml = control.modeLook(m);
                if (m === cur) cv.roundRect(40, y - 6, 1520, 62, 10, withAlpha(t.accent, 0.14));
                cv.text(MODE_NAMES[m], 60, y + 34, 28, t.text, { font: 'bold' });
                const orig = control.modeOriginal(m);
                if (ml) { cv.roundRect(250, y + 6, 38, 38, 9, ml.upper.rgb); cv.text(nearest(ml.upper.rgb) + (ml.kind !== 'solid' ? ', ' + S.NAMES[ml.kind] : ''), 304, y + 33, 22, t.text); }
                else cv.text(orig ? 'BMW\'s original colour' : 'The Colour tab\'s colour', 250, y + 33, 22, t.dim);
                // any colour: the Colour and Animations tabs change this mode's look
                G.button(cv, t, 760, y + 1, 250, 48, 'Choose colour', () => { editing = m; page = 0; return redraw(); }, { primary: !!ml, key: m + '-any' });
                // the animation, one tap each: Solid, Breathing, Rainbow, Smooth fade, Colour wave
                const kind = ml ? ml.kind : 'solid', next = S.KINDS[(S.KINDS.indexOf(kind) + 1) % S.KINDS.length];
                G.button(cv, t, 1026, y + 1, 250, 48, S.NAMES[kind], () => { control.setModeLook(m, Object.assign(ml || mine, { kind: next })); return redraw(); },
                    { primary: !!ml && kind !== 'solid', key: m + '-anim' });
                // Original colour: BMW's colour in this mode; tapped again, the Colour tab's colour back
                G.button(cv, t, 1292, y + 1, 250, 48, 'Original colour', () => { control.setModeLook(m, orig ? null : 'original'); return redraw(); },
                    { primary: orig, key: m + '-orig' });
            });
            cv.text('Nothing chosen: the Colour tab\'s colour. Tap Original colour again to undo it.', 60, 412, 18, t.dim);
            const tog = (key, label, x) => x + 16 + G.button(cv, t, x, 440, 0, 48, label, () => { settings.set(key, !settings.get(key)); return redraw(); },
                { primary: ON_BY_DEFAULT.indexOf(key) >= 0 ? settings.get(key) !== false : !!settings.get(key), key: 'tog-' + key });
            let x = 60;
            x = tog('follow', settings.get('follow') !== false ? 'Following driving mode' : 'Not following', x);
            x = tog('welcome', 'Welcome sweep at start', x);
            x = tog('sportPulse', 'Sport pulse', x);
            tog('flashAlerts', 'Redline shift flash', x);
        }

        function drawFavs(cv, t) {
            G.panel(cv, t, 24, 44, 1552, 468, 'Favourites');
            const favs = control.favs(), mine = JSON.stringify(look());
            for (let i = 0; i < 6; i++) {
                const x = 44 + (i % 3) * 512, y = 92 + Math.floor(i / 3) * 206, f = favs[i];
                const on = f && control.on() && JSON.stringify(f) === mine;
                cv.roundRect(x, y, 492, 190, 16, on ? withAlpha(t.accent, 0.22) : withAlpha('#ffffff', 0.06));
                if (!f) {
                    cv.text('Empty', x + 246, y + 86, 26, t.dim, { align: 'center', font: 'bold' });
                    cv.text('Tap to save the look on now', x + 246, y + 118, 20, t.dim, { align: 'center' });
                    if (cv.target) cv.target(x, y, 492, 190, () => { control.saveFav(); return redraw(); }, 'fav-' + i);
                    continue;
                }
                cv.roundRect(x + 24, y + 24, 120, 66, 14, f.upper.rgb);
                cv.roundRect(x + 24, y + 98, 120, 66, 14, f.lower.rgb);
                cv.text(nearest(f.upper.rgb) + (nearest(f.lower.rgb) !== nearest(f.upper.rgb) ? ' / ' + nearest(f.lower.rgb) : ''), x + 166, y + 60, 26, t.text, { font: 'bold' });
                cv.text(S.NAMES[f.kind] + ', ' + f.upper.bright + '%', x + 166, y + 94, 20, t.dim);
                if (cv.target) cv.target(x, y, 340, 190, () => { control.useFav(i); return redraw(); }, 'fav-' + i);
                G.button(cv, t, x + 360, y + 130, 116, 44, 'Delete', () => { control.dropFav(i); return redraw(); }, { key: 'del-' + i, confirm: true });
            }
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            [drawColour, drawAnimations, drawModes, drawFavs][page](cv, t);
            G.frame(cv, t, TABS, page, []);
            dirty = false;
            await ui.image('MAIN_GFX', cv);
        }
        // moving lights redraw a few times a second, the rest when something changes
        const tick = () => {
            const moving = (lights.scene && S.moves(lights.scene)) || (page === 1 && control.on() && S.moves(look()));
            return dirty || (moving && page <= 1) ? render() : null;
        };

        if (ctx.onTap) {
            ctx.onTap((x, y) => {
                if (page !== 0) return null;
                const dx = x - RING.cx, dy = y - RING.cy, d = Math.sqrt(dx * dx + dy * dy);
                if (d >= RING.r - 12 && d <= RING.R + 12) return setRgb(S.hsv(S.snapHue((Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360), 1, 1));
                const ex = x - DIAL.cx, ey = y - DIAL.cy, e = Math.sqrt(ex * ex + ey * ey);
                if (e >= DIAL.r - 14 && e <= DIAL.R + 14) {
                    const a = Math.atan2(ex, -ey) * 180 / Math.PI;
                    if (a >= -140 && a <= 140) return setBright((Math.max(-135, Math.min(135, a)) + 135) / 270 * 100);
                }
                return null;
            });
        }
        ctx.onTab((i) => { page = i; if (i >= 2) editing = null; return redraw(); });
        lights.on('change', () => { dirty = true; });
        ambient.on('change', () => { dirty = true; });
        settings.onChange(() => { dirty = true; });
        ctx.loop('MAIN', 8, tick);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
