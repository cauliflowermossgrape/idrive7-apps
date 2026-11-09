'use strict';
// Redline's own directions on the HUD, the drawing side: hud-nav.js's picture (arrows, distance, street, lanes) and
// hud.js's directions layer against a stand-in cluster-render and a stand-in nav.js. Node 8 compatible.
//   node kit/tools/test_redline_hud_nav.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-hudnav-'));
const SHM = process.env.MGU_HUD_CLAIMS = path.join(TMP, 'shm');
const ROOT = path.join(__dirname, '..', '..');

let cr = null;
class FakeCr {
    constructor() { cr = this; this.ready = true; this.backend = 'test'; this.targets = 'hud'; this.n = 0; this.layers = {}; this.frames = []; this.h = {}; }
    on(ev, fn) { this.h[ev] = fn; }
    connect() {} close() {} removeAllListeners() {} status() {}
    set(ref, o) { if (this.layers[ref]) Object.assign(this.layers[ref], o); }
    _add(kind, o) { this.n++; this.layers[this.n] = Object.assign({ kind: kind }, o); return this.n; }
    image(o) { return this._add('image', o); }
    effect(o) { return this._add('effect', o); }
    uniform() {}
    pixels(ref, rects, px) { this.frames.push({ ref: ref, rects: rects, px: Buffer.from(px) }); return true; }
    drop(r) { delete this.layers[r]; }
    images() { return Object.keys(this.layers).map(Number).filter((r) => this.layers[r].kind === 'image'); }
}
const load = Module._load;
Module._load = function (req, parent, isMain) {
    if (req.startsWith('./kit/')) return load.call(this, path.join(ROOT, 'kit', 'runtime', req.slice(6)), parent, isMain);
    if (req === './cluster_render_client') return { ClusterRender: FakeCr };
    return load.call(this, req, parent, isMain);
};
const Hud = require(path.join(ROOT, 'apps', 'redline', 'hud'));
const N = require(path.join(ROOT, 'apps', 'redline', 'hud-nav'));
const { Canvas } = require(path.join(ROOT, 'kit', 'runtime', 'canvas'));
const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'redline', 'app.json'), 'utf8'));
const def = {};
spec.settings.forEach((s) => { if (s.key) def[s.key] = s.default; });

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---- the picture ---------------------------------------------------------------------------------------------------
const draw = (m, palette) => { const c = new Canvas(N.NW, N.NH); N.drawNav(c, m, { palette: palette || 'colour' }); return c; };
/** Lit pixels in x0..x1: { n, cx } (count, mean x), and how many are bright white (the arrows and text in 'colour'). */
function lit(c, x0, x1, y0, y1) {
    let n = 0, sx = 0, white = 0;
    for (let y = y0 || 0; y < (y1 || c.h); y++) for (let x = Math.max(0, x0); x < Math.min(c.w, x1); x++) {
        const i = (y * c.w + x) * 4;
        if (c.d[i + 3] > 128) { n++; sx += x; }
        if (c.d[i + 3] > 200 && c.d[i] > 200 && c.d[i + 1] > 200 && c.d[i + 2] > 200) white++;
    }
    return { n: n, cx: n ? sx / n : 0, white: white };
}
ok(N.NW === 200 && N.NH === 76, 'a small picture: 200x76');
ok(lit(draw(null), 0, N.NW).n === 0, 'nothing to show: an empty (see-through) picture');
Object.keys(N.SAMPLES).forEach((k) => {
    let c = null;
    try { c = draw(N.SAMPLES[k]); } catch (e) { ok(false, k + ' draws: ' + e); return; }
    const all = lit(c, 0, N.NW);
    ok(all.n > 200 && all.white > 150, k + ': drawn in white (' + all.n + ' px, ' + all.white + ' white)');
    let r = N.NW - 1; while (r > 0 && lit(c, r, r + 1).n === 0) r--;
    if (N.SAMPLES[k].dist) ok(r >= N.NW - 8 && r <= N.NW - 1, k + ': right-aligned, into the corner (last column ' + r + ')');
});
// the arrows are thick: a straight arrow's shaft is about 11 px wide
{
    const a = new Canvas(N.NW, N.NH), b = N.drawNav(a, { kind: 'turn', dir: 'STRAIGHT_ON', dist: '100', unit: 'm' }, { palette: 'colour' });
    let w = 0; for (let x = b.x; x < b.x + 68; x++) if (a.d[(60 * N.NW + x) * 4 + 3] > 128) w++;
    ok(w >= 10 && w <= 13, 'thick arrows: the shaft is ' + w + ' px wide');
}
// the arrow box (68 px) from where drawNav says it drew it
const arrowBox = (m) => { const c = new Canvas(N.NW, N.NH), b = N.drawNav(c, m, { palette: 'colour' }); return { c: c, x0: b.x }; };
const side = (m) => { const a = arrowBox(m); return lit(a.c, a.x0, a.x0 + 68).cx - (a.x0 + 34); };
// (hard turns: their stem stands on the other side; where they point is checked below)
['LEFT', 'SLIGHT_LEFT'].forEach((d) => ok(side({ kind: 'turn', dir: d, dist: '100', unit: 'm' }) < -3, d + ': the arrow leans left (' + side({ kind: 'turn', dir: d, dist: '100', unit: 'm' }).toFixed(1) + ')'));
['RIGHT', 'SLIGHT_RIGHT'].forEach((d) => ok(side({ kind: 'turn', dir: d, dist: '100', unit: 'm' }) > 3, d + ': the arrow leans right'));
ok(Math.abs(side({ kind: 'turn', dir: 'STRAIGHT_ON', dist: '100', unit: 'm' })) < 2, 'straight on: centred');
ok(side({ kind: 'branch', dir: 'BRANCH_LEFT', dist: '1', unit: 'km' }) < -3 && side({ kind: 'branch', dir: 'HIGHWAY_OUT_RIGHT', dist: '1', unit: 'km' }) > 3, 'exits lean to their side');
// the roundabout seen on the drive: first exit at 307 degrees with the island on the left: out to the upper right
{
    const a = arrowBox(N.SAMPLES.roundabout), cx = a.x0 + 34;
    const ur = lit(a.c, cx + 12, cx + 34, 0, 26).white, ul = lit(a.c, cx - 34, cx - 12, 0, 26).white;
    ok(ur > 20 && ul < 5, 'roundabout exit 1 at 307: the exit goes out upper right (' + ur + ' / ' + ul + ')');
    const b = arrowBox(N.SAMPLES.roundabout3), bx = b.x0 + 34;
    ok(lit(b.c, bx - 34, bx - 14, 18, 46).white > 20, 'roundabout exit 3 at 90: out to the left');
    ok(N.exitAngleOf({ exit: 1, side: 'left' }) === 270 && N.exitAngleOf({ exit: 3, side: 'left' }) === 90 && N.exitAngleOf({ exit: 1, side: 'right' }) === 90, 'no angle from the car: from the exit\'s number');
}
// lanes: under the distance, in the street's place; the highlighted lanes' arrows bright, the rest dim
{
    const c = new Canvas(N.NW, N.NH), b = N.drawNav(c, N.SAMPLES.lanes, { palette: 'colour' }), L = b.lanes;
    ok(L && L.w >= 18, 'lanes drawn (' + JSON.stringify(L) + ')');
    const cell = (i) => lit(c, Math.round(L.x + i * L.w + 3), Math.round(L.x + (i + 1) * L.w - 3), 42, 76);
    ok(cell(0).white > 15 && cell(1).white > 15, 'lanes 1 and 2 (straight on, highlighted): bright (' + cell(0).white + ', ' + cell(1).white + ')');
    ok(cell(2).white === 0 && cell(2).n > 5, 'lane 3 (right, not for this route): dim (' + cell(2).white + ' white, ' + cell(2).n + ' lit)');
    // eight lanes still fit
    const many = Object.assign({}, N.SAMPLES.lanes, { lanes: { lanes: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ follow: i === 3 ? 'STRAIGHT_ON' : 'NONE', others: i === 3 ? [] : ['STRAIGHT_ON'], hi: i === 3, info: 'NONE' })), rec: 3, markers: [] } });
    const c8 = new Canvas(N.NW, N.NH), b8 = N.drawNav(c8, many, { palette: 'colour' });
    ok(b8.x >= 0 && b8.lanes.x + 8 * b8.lanes.w <= N.NW, 'eight lanes fit (cells ' + b8.lanes.w.toFixed(1) + ' px)');
}
ok(lit(draw(Object.assign({}, N.SAMPLES.left, { dist: null, unit: null, road: '' })), 0, N.NW).n > 200, 'a turn with no distance: the arrow alone');
// a long street is cut to fit; the arrow stays whole
{
    const m = Object.assign({}, N.SAMPLES.left, { road: 'A very long street name that would never fit on the head-up display at all' });
    const c = new Canvas(N.NW, N.NH), b = N.drawNav(c, m, { palette: 'colour' });
    ok(b.x >= 0 && lit(c, 0, b.x).n === 0, 'a long street is cut, the arrow stays in the picture (at ' + b.x + ')');
}
// text
ok(N.foldText('Example Straße') === 'Example Strasse' && N.foldText('Café Élysée') === 'Cafe Elysee' && N.foldText('Øster­gade 東京') === 'Ostergade', 'street names folded to the HUD\'s fonts (' + N.foldText('Øster­gade 東京') + ')');
ok(N.navKey(N.SAMPLES.left, {}) !== N.navKey(Object.assign({}, N.SAMPLES.left, { dist: '400' }), {}) && N.navKey(N.SAMPLES.left, {}) === N.navKey(Object.assign({}, N.SAMPLES.left), {}), 'the key changes with the distance, not otherwise');
ok(N.navKey(N.SAMPLES.left, { palette: 'amber' }) !== N.navKey(N.SAMPLES.left, { palette: 'colour' }), 'the key changes with the palette');
ok(lit(draw(N.SAMPLES.left, 'amber'), 0, N.NW).white === 0 && lit(draw(N.SAMPLES.left, 'amber'), 0, N.NW).n > 300, 'Night amber: in amber, not white');

// ---- every arrow the car's catalog can ask for ---------------------------------------------------------------------
{
    // the lists are the catalog's (reference/ is git-ignored: CI skips this cross-check)
    const CAT = path.join(ROOT, 'reference', 'someip-interfaces.json');
    if (fs.existsSync(CAT)) {
        const D = JSON.parse(fs.readFileSync(CAT, 'utf8')).datatypes, T = (n) => Object.keys(D['de.bmw.infotainment.navigation.GuidingTypes.' + n].items).sort();
        ok(JSON.stringify(T('TurnDirection')) === JSON.stringify(N.TURN_DIRECTIONS.slice().sort()), 'every TurnDirection in the catalog has an arrow');
        ok(JSON.stringify(T('BranchType')) === JSON.stringify(N.BRANCH_TYPES.slice().sort()), 'every BranchType in the catalog has an arrow');
        ok(JSON.stringify(T('ManeuverGeometry')) === JSON.stringify(N.GEOMETRIES.slice().sort()), 'every ManeuverGeometry in the catalog has an arrow');
    } else console.log('(the car\'s catalog is not here: its cross-check skipped)');
    ok(N.ALL_ARROWS.length >= 75, 'the arrows to check: ' + N.ALL_ARROWS.length);
    // each one draws, inside its 80 px box (at 1.0, centred in 100x100)
    N.ALL_ARROWS.forEach((m) => {
        const c = new Canvas(100, 100);
        N.drawArrow(c, m, 50, 50, 1, '#ffffff', [255, 255, 255, 89]);
        const all = lit(c, 0, 100), edge = lit(c, 0, 100, 0, 6).n + lit(c, 0, 100, 94, 100).n + lit(c, 0, 6).n + lit(c, 94, 100).n;
        ok(all.white > 150 && edge === 0, m.label + ': drawn, inside its box (' + all.white + ' px, ' + edge + ' outside)');
    });
    // where the bright path ends: left values left, right right, straight in the middle
    const endX = (m) => { const s = N.shapeOf(m); const p = s.path[s.path.length - 1]; return p[0] * s.mir; };
    const want = (name) => (/TAKE_(LEFT|RIGHT|CENTER)$/.test(name) ? null : /LEFT/.test(name) ? -1 : /RIGHT/.test(name) ? 1 : 0);
    N.TURN_DIRECTIONS.filter((d) => d !== 'NONE').concat(N.BRANCH_TYPES).forEach((d) => {
        const m = { kind: N.TURN_DIRECTIONS.indexOf(d) >= 0 ? 'turn' : 'branch', dir: d }, x = endX(m), w = want(d);
        ok(w === 0 ? Math.abs(x) < 1 : x * w > 3, d + ': the arrow ends ' + (w < 0 ? 'left' : w > 0 ? 'right' : 'straight on') + ' (' + x.toFixed(1) + ')');
    });
    N.GEOMETRIES.forEach((g) => {
        const r = /^EXIT_(LEFT|RIGHT)_TAKE_(LEFT|RIGHT)$/.exec(g), f = /^EXIT_(LEFT|RIGHT)_TWO_WAY/.exec(g);
        // an exit taken: its side; not taken: straight on; an exit's fork: the exit's side; a fork: the leg taken
        const w = r ? (r[1] === r[2] ? (r[1] === 'LEFT' ? -1 : 1) : 0) : f ? (f[1] === 'LEFT' ? -1 : 1) : /TAKE_LEFT$/.test(g) ? -1 : /TAKE_RIGHT$/.test(g) ? 1 : 0;
        const x = endX({ kind: 'branch', dir: 'BRANCH_LEFT', geom: g });
        ok(w === 0 ? Math.abs(x) < 1 : x * w > 3, g + ': the arrow ends on the right side (' + x.toFixed(1) + ')');
    });
    // the head sits on a straight run (a bend under its base bulged out on one side: that side looked smaller)
    N.ALL_ARROWS.forEach((m) => {
        const s = N.shapeOf(m);
        if (!s.path) return;
        const p = s.path, a = p[p.length - 2], b = p[p.length - 1], l = Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1]));
        ok(l >= N.HEAD_RUN, m.label + ': the head on a straight run of ' + l.toFixed(1) + ' (at least ' + N.HEAD_RUN + ')');
    });
    // U-turns and hard turns point back down
    ['UTURN_LEFT', 'UTURN_RIGHT', 'HARD_LEFT', 'HARD_RIGHT'].forEach((d) => {
        const s = N.shapeOf({ kind: 'turn', dir: d }), p = s.path, a = p[p.length - 2], b = p[p.length - 1];
        ok(b[1] > a[1], d + ': the head points back down');
    });
    // left and right are mirror images, pixel for pixel, at the HUD's own size (no head bigger on one side)
    const mirrorDiff = (m1, m2) => {
        const a = new Canvas(N.NW, N.NH), b = new Canvas(N.NW, N.NH);
        N.drawArrow(a, m1, 100, 38, 0.85, '#ffffff', [255, 255, 255, 89]); N.drawArrow(b, m2, 100, 38, 0.85, '#ffffff', [255, 255, 255, 89]);
        let d = 0;
        for (let y = 0; y < N.NH; y++) for (let x = 0; x < N.NW; x++) if (Math.abs(a.d[(y * N.NW + x) * 4 + 3] - b.d[(y * N.NW + (199 - x)) * 4 + 3]) > 8) d++;
        return d;
    };
    const pairs = [];
    N.ALL_ARROWS.forEach((m) => {
        if (m.kind === 'roundabout' || m.kind === 'destination' || m.kind === 'transport') return;
        const key = m.geom || m.dir, other = key.replace(/LEFT/g, '\u0001').replace(/RIGHT/g, 'LEFT').replace(/\u0001/g, 'RIGHT');
        if (other !== key && /LEFT/.test(key.split('_').pop() + key)) pairs.push([m, Object.assign({}, m, m.geom ? { geom: other } : { dir: other })]);
    });
    pairs.forEach((p) => { const d = mirrorDiff(p[0], p[1]); ok(d === 0, (p[0].geom || p[0].dir) + ' mirrors ' + (p[1].geom || p[1].dir) + ' exactly (' + d + ' px differ)'); });
    ok(pairs.length >= 20, pairs.length + ' left / right pairs checked');
    // every roundabout exit, both traffic sides: the head leaves the ring at the exit's angle
    [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].forEach((a) => ['left', 'right'].forEach((sd) => {
        const c = new Canvas(100, 100);
        N.drawArrow(c, { kind: 'roundabout', exit: 1, exitAngle: a, side: sd }, 50, 50, 1, '#ffffff', [255, 255, 255, 89]);
        if (Math.abs(a - 180) <= 45) {
            // back the way it came: in on the drive side, out straight down on the other, two strokes with a gap
            const inX = sd === 'left' ? 1 : -1;            // the way in: right of the middle with the island on the left
            // the strokes stand about 10.7 px either side of the middle; the gap is between them, above the head
            const win = (x0, x1, y0, y1) => lit(c, Math.min(x0, x1), Math.max(x0, x1), y0, y1);
            const inS = win(50 + inX * 6, 50 + inX * 16, 70, 92), outS = win(50 - inX * 6, 50 - inX * 16, 70, 92), gap = win(48, 53, 68, 76);
            ok(inS.white > 20 && outS.white > 20 && gap.white === 0, 'roundabout exit at ' + a + ' (island ' + sd + '): in and back out side by side, apart (' + inS.white + ', ' + outS.white + ', gap ' + gap.white + ')');
            return;
        }
        const t = a * Math.PI / 180, tx = Math.round(50 - Math.sin(t) * 38), ty = Math.round(48 - Math.cos(t) * 38);
        const near = lit(c, tx - 7, tx + 8, Math.max(0, ty - 7), Math.min(100, ty + 8)).white;
        ok(near > 15, 'roundabout exit at ' + a + ' (island ' + sd + '): the head out there (' + near + ' px)');
    }));
}

// ---- the layer in hud.js -------------------------------------------------------------------------------------------
(async () => {
    fs.mkdirSync(SHM);
    fs.writeFileSync(path.join(SHM, 'redline'), JSON.stringify({ held: false, at: Date.now() }) + '\n');
    const v = Object.assign({}, def, { hud: 'on', hudStyle: 'standard', hudFps: 30 }), fns = [];
    const settings = { get: (k) => v[k], set: (k, x) => { v[k] = x; fns.forEach((f) => f(k, x)); }, onChange: (f) => fns.push(f) };
    let view = { show: null, giveWay: false }, modes = [];
    const nav = { view: (mode) => { modes.push(mode); return view; } };
    const src = { data: () => ({ rpm: 2500, gear: 3, stage: 'D', speed: 50, oil: 95, coolant: 92 }), shiftPoint: () => ({ rpm: 6200, cold: false }), redline: () => 6550,
        maxRpm: () => 8000, driveMode: () => 'sport', nav: nav };
    const lines = [];
    const log = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
    const h = Hud.start({ settings: settings, log: log, dataDir: TMP }, src);
    await sleep(150);
    ok(cr.images().length === 1, 'no route: the tach alone');
    ok(modes.length > 0 && modes.every((m) => m === 'route'), 'Directions default: while a route runs');

    view = { show: N.SAMPLES.left, giveWay: false };
    await sleep(150);
    const imgs = cr.images();
    ok(imgs.length === 2, 'a turn: a second image layer (' + imgs.length + ')');
    const tach = cr.layers[imgs[0]], nl = cr.layers[imgs[1]] || {};
    // the glass's bottom right corner (x 120..680, y 120..360 seen), clear of the tach and of BMW's speed at the bottom left
    ok(nl.iw === N.NW && nl.ih === N.NH && nl.w === 200 && nl.h === 76 && nl.target === 'hud' && nl.x + nl.w === 672 && nl.y + nl.h === 356, 'the directions in the bottom right corner (' + [nl.x, nl.y, nl.w, nl.h].join(',') + ')');
    ok(nl.y >= tach.y + tach.h && nl.x >= 400, 'below the tach, in the right half');
    const navFrames = () => cr.frames.filter((f) => f.ref === imgs[1]);
    ok(navFrames().length === 1 && !navFrames()[0].rects, 'sent whole once');
    await sleep(150);
    ok(navFrames().length === 1, 'the same turn: nothing sent again');
    view = { show: Object.assign({}, N.SAMPLES.left, { dist: '400' }), giveWay: false };
    await sleep(120);
    ok(navFrames().length === 2 && navFrames()[1].rects && navFrames()[1].rects.length >= 1, 'nearer: only what changed is sent');

    // their own place: the tach's size and place don't move them, their own settings do
    settings.set('hudSize', 80); settings.set('hudX', -40); await sleep(100);
    const nl2 = cr.layers[imgs[1]];
    ok(nl2 && nl2.w === 200 && nl2.x === 472 && nl2.y === 280, 'the tach at 80 % and moved: the directions stay');
    settings.set('hudNavY', -20); settings.set('hudNavX', -40); await sleep(100);
    ok(cr.layers[imgs[1]].y === 260 && cr.layers[imgs[1]].x === 432, 'Directions left / right and up / down move them');
    settings.set('hudSize', 100); settings.set('hudX', 0); settings.set('hudNavY', 0); settings.set('hudNavX', 0); await sleep(100);

    // the turn goes: the layer goes
    view = { show: null, giveWay: false };
    await sleep(120);
    ok(cr.images().length === 1, 'no turn: the directions layer dropped, the tach stays');

    // a route without readable turns: Redline out of the way, BMW's card shows
    view = { show: null, giveWay: true };
    await sleep(120);
    ok(cr.images().length === 0 && h.status() === 'HUD: giving way to BMW\'s directions', 'giving way: no layers (' + h.status() + ')');
    const claim = JSON.parse(fs.readFileSync(path.join(SHM, 'redline'), 'utf8'));
    ok(claim.held === false, 'giving way: the HUD claim let go');
    ok(!lines.some((l) => /hidden in/.test(l)), 'giving way isn\'t logged as a driving-mode hide');
    view = { show: N.SAMPLES.exit, giveWay: false };
    await sleep(150);
    ok(cr.images().length === 2, 'a turn again: the tach and the directions back');

    // paused behind BMW's content: nothing sent; after it, sent whole
    const before = cr.frames.length;
    cr.h.target('hud', 'parked', 'bmw', '', false, false);
    view = { show: N.SAMPLES.roundabout, giveWay: false };
    await sleep(120);
    ok(cr.frames.length === before, 'parked: nothing drawn');
    cr.h.target('hud', 'shown', '', '', false, false);
    await sleep(120);
    const nref = cr.images()[1];
    ok(cr.frames.filter((f) => f.ref === nref && !f.rects).length >= 1, 'shown again: the directions sent whole');

    // Directions off
    settings.set('hudNav', 'off'); await sleep(120);
    ok(modes[modes.length - 1] === 'off', 'Directions off: asked as off');
    settings.set('hudNav', 'near'); await sleep(120);
    ok(modes[modes.length - 1] === 'near', 'Near turns: asked as near');
    settings.set('hudNav', 'route');

    // the test pattern shows where they go
    settings.set('hud', 'test'); await sleep(120);
    const r = Hud.navPlaceOf(settings);
    const whiteIn = (px) => { let n = 0; for (let y = r.y + 4; y < r.y + r.h - 4; y++) for (let x = r.x + 4; x < r.x + r.w - 4; x++) { const i = (y * 800 + x) * 4; if (px[i] > 200 && px[i + 1] > 200 && px[i + 2] > 200) n++; } return n; };
    const withNav = whiteIn(cr.frames[cr.frames.length - 1].px);
    settings.set('hudNav', 'off'); await sleep(120);
    const without = whiteIn(cr.frames[cr.frames.length - 1].px);
    ok(withNav - without > 300, 'test pattern: a sample turn where the directions go (' + withNav + ' white px, ' + without + ' with Directions off)');
    settings.set('hudNav', 'route');

    ok(!lines.some((l) => /^hud \w+: /.test(l) && /Error/.test(l)), 'no errors in the HUD\'s log (' + lines.filter((l) => /Error/.test(l)).join(' / ').slice(0, 300) + ')');
    h.stop();
    console.log(checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e && e.stack || e)); process.exit(1); });
