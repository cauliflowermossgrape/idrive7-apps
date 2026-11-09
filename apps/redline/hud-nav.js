'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Drawing Redline's own directions on the HUD (hud-own-directions-plan.md, phase 3): the next turn's arrow, its
 * distance, the street and the lanes, as a picture (a 200x76 image layer in the bottom right corner of the glass,
 * clear of BMW's speed and limit sign at the bottom left; hud.js places and sends it). Not the GPU: since 1.16.1 the
 * GPU draws the Arc only (shaders restarted the cluster).
 * The object drawn is nav.js's: { kind, dir, exit, exitAngle, side, dist, unit, road, lanes }.
 *
 *   [arrow] 450 m             [arrow] 700 m
 *           Example Street            ▏↑▏↑▏↱▏    (lanes, when there are some, in the street's place)
 *
 * Everything is right-aligned, so it hugs the corner. Arrows in the HUD colours' text colour (white), thick:
 * drawn right-handed and mirrored for the left. Straight, slight / normal / hard turns, U-turns, keep / fork / exit
 * (the road it leaves dim), motorway entry (the motorway dim), lane change, roundabout (the ring dim, the way round
 * and the exit bright, its number inside), destination flag, and a dot for anything else ("follow the route").
 * Black is see-through on the glass, like the tach.
 */
const { withAlpha } = require('./kit/canvas');
const { PALETTES } = require('./hud-draw');

const NW = 200, NH = 76;
const isNum = (x) => typeof x === 'number' && isFinite(x);

/*
 * Arrow geometry in a box of -40..40 (y down), drawn right-handed; mir -1 mirrors it for the left.
 * Each shape: { dim: [polylines], path: [points], head: true }; the path ends at the arrow's tip.
 */
const TURN_DEG = { STRAIGHT_ON: 0, SLIGHT: 45, NORMAL: 90, HARD: 135, SHARP: 135 };
function turnPath(deg) {
    const a = deg * Math.PI / 180;
    // a hard turn bends higher up, so the way back down has room
    const py = deg >= 135 ? -14 : 2;
    return deg === 0 ? [[0, 36], [0, -36]] : [[0, 36], [0, py], [Math.sin(a) * 30, py - Math.cos(a) * 30]];
}
/** The shape for a direction name (LEFT, SLIGHT_RIGHT, HARD_LEFT, UTURN_RIGHT, STRAIGHT_ON...): { path, mir }. */
function turnShape(dir) {
    const d = String(dir || '');
    const mir = /LEFT/.test(d) ? -1 : 1;
    if (/UTURN|U_TURN/.test(d)) {
        // up on the left, round over the top, down on the right (mirrored: the other way)
        const p = [[-12, 36], [-12, -10]];
        for (let i = 1; i <= 8; i++) { const a = Math.PI - i * Math.PI / 8; p.push([Math.cos(a) * 12, -10 - Math.sin(a) * 12]); }
        p.push([12, 22]);
        return { path: p, mir: mir };
    }
    const deg = /SLIGHT/.test(d) ? 45 : /HARD|SHARP/.test(d) ? 135 : /LEFT|RIGHT/.test(d) ? 90 : TURN_DEG.STRAIGHT_ON;
    return { path: turnPath(deg), mir: mir };
}
/** Keep / fork / exit to one side: the road it leaves dim, straight on. */
function forkShape(mir) {
    return { path: [[0, 36], [0, 6], [22, -16], [22, -36]], dim: [[[0, 6], [0, -32]]], mir: mir };
}
/** The shape for nav.js's object. */
function shapeOf(m) {
    if (!m) return { path: null, mir: 1 };
    const d = String(m.dir || ''), mir = /LEFT/.test(d) ? -1 : 1;
    switch (m.kind) {
    case 'turn': return turnShape(d);
    case 'keep': return /LEFT|RIGHT/.test(d) ? forkShape(mir) : turnShape('STRAIGHT_ON');
    case 'lanechange': return { path: [[-12, 36], [-12, 12], [12, -10], [12, -36]], mir: mir };
    case 'branch':
        if (/HIGHWAY_IN/.test(d)) {
            // onto the motorway: the motorway dim, the slip road joining it
            if (/STRAIGHT/.test(d)) return turnShape('STRAIGHT_ON');
            return { path: [[-16, 36], [-16, 14], [8, -10], [8, -36]], dim: [[[16, 36], [16, -36]]], mir: mir };
        }
        if (/TRIPLE_FORK/.test(d) && /STRAIGHT/.test(d)) return { path: [[0, 36], [0, -36]], dim: [[[0, 6], [-22, -16], [-22, -32]], [[0, 6], [22, -16], [22, -32]]], mir: 1 };
        if (/LEFT|RIGHT/.test(d)) return forkShape(mir);
        return turnShape('STRAIGHT_ON');         // BRANCH_STRAIGHT, HIGHWAY_OUT_STRAIGHT, OVERPASS, UNDERPASS
    default: return { path: null, mir: 1 };
    }
}

/** The exit's angle (degrees anticlockwise from straight on) from its number when the car gives none. */
function exitAngleOf(m) {
    if (isNum(m.exitAngle)) return m.exitAngle;
    const n = isNum(m.exit) && m.exit > 0 ? m.exit : 2;
    // a four-way roundabout: right first with the island on the left, left first with it on the right
    return m.side === 'right' ? ((90 - 90 * (n - 1)) % 360 + 360) % 360 : (270 + 90 * (n - 1)) % 360;
}

/** A polyline with round ends; the last segment stops short for the head. */
function stroke(cv, pts, X, Y, w, c) {
    for (let i = 1; i < pts.length; i++) cv.line(X(pts[i - 1]), Y(pts[i - 1]), X(pts[i]), Y(pts[i]), w, c);
}
/** The arrow head at the path's end, pointing along its last segment. */
function head(cv, pts, X, Y, s, c) {
    const a = pts[pts.length - 2], b = pts[pts.length - 1];
    const ax = X(a), ay = Y(a), bx = X(b), by = Y(b);
    const l = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)) || 1, ux = (bx - ax) / l, uy = (by - ay) / l;
    const L = 21 * s, W = 17 * s, tx = bx + ux * L * 0.35, ty = by + uy * L * 0.35;
    cv.triangle([[tx, ty], [tx - ux * L - uy * W, ty - uy * L + ux * W], [tx - ux * L + uy * W, ty - uy * L - ux * W]], c);
}

/**
 * The arrow for m, centred at cx, cy, s: scale (1 = an 80 px box). col: bright, dim: the roads not taken.
 * Returns nothing; draws nothing for null.
 */
function drawArrow(cv, m, cx, cy, s, col, dim) {
    if (!m) return;
    const W = 13 * s;
    if (m.kind === 'roundabout') { drawRoundabout(cv, m, cx, cy, s, col, dim); return; }
    if (m.kind === 'destination') { drawFlag(cv, m, cx, cy, s, col, dim); return; }
    const sh = shapeOf(m);
    if (!sh.path) { cv.circle(cx, cy, 11 * s, col); cv.arc(cx, cy, 17 * s, 20 * s, 0, 360, dim); return; }      // follow the route
    const X = (p) => cx + p[0] * sh.mir * s, Y = (p) => cy + p[1] * s;
    (sh.dim || []).forEach((p) => stroke(cv, p, X, Y, W * 0.75, dim));
    // the shaft ends where the head begins
    const p = sh.path.slice(), a = p[p.length - 2], b = p[p.length - 1];
    const l = Math.sqrt((b[0] - a[0]) * (b[0] - a[0]) + (b[1] - a[1]) * (b[1] - a[1])) || 1, cut = Math.min(l * 0.8, 10);
    p[p.length - 1] = [b[0] - (b[0] - a[0]) / l * cut, b[1] - (b[1] - a[1]) / l * cut];
    stroke(cv, p, X, Y, W, col);
    head(cv, [p[p.length - 2], b], X, Y, s, col);
}

/** The roundabout: the ring dim, the way in, round (the drive side's way) and out bright, the exit's number inside. */
function drawRoundabout(cv, m, cx, cy, s, col, dim) {
    const R = 17 * s, oy = cy - 6 * s, W = 11 * s;
    cv.arc(cx, oy, R - 3 * s, R + 3 * s, 0, 360, dim);
    // the way in from below
    cv.line(cx, cy + 36 * s, cx, oy + R, W, col);
    // round: from the entry (anticlockwise angle 180) to the exit, the island on m.side
    const a = exitAngleOf(m);
    const to = m.side === 'right' ? (a < 180 ? a : a - 360) : (a > 180 ? a : a + 360);
    // canvas angles are clockwise from 12 o'clock: anticlockwise a is 360 - a
    const c0 = 180, c1 = 360 - to;
    cv.arc(cx, oy, R - W / 2, R + W / 2, Math.min(c0, c1), Math.max(c0, c1), col, { round: true });
    // out along the exit's direction
    const r = to * Math.PI / 180, ux = -Math.sin(r), uy = -Math.cos(r);
    const pts = [[ux * R / s, uy * R / s - 6], [ux * 31, uy * 31 - 6]];
    const X = (p) => cx + p[0] * s, Y = (p) => cy + p[1] * s;
    stroke(cv, [pts[0], [pts[0][0] + (pts[1][0] - pts[0][0]) * 0.6, pts[0][1] + (pts[1][1] - pts[0][1]) * 0.6]], X, Y, W, col);
    head(cv, pts, X, Y, s * 0.9, col);
    if (isNum(m.exit)) cv.text(String(m.exit), cx, oy + 6 * s, 17 * s, col, { align: 'center', font: 'bold', literal: true });
}

/** Arrival: a chequered flag, on the side the destination is (centre: straight up). */
function drawFlag(cv, m, cx, cy, s, col, dim) {
    const mir = /LEFT/.test(String(m.dir)) ? -1 : 1, px = cx - mir * 10 * s;
    cv.line(px, cy + 34 * s, px, cy - 32 * s, 7 * s, col);
    const fw = 30 * s, fh = 22 * s, cw = fw / 4, ch = fh / 2, x0 = mir > 0 ? px : px - fw, y0 = cy - 32 * s;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) cv.fillRect(x0 + i * cw, y0 + j * ch, cw, ch, (i + j) % 2 ? dim : col);
}

/**
 * The lanes: one cell per lane, each with its arrows (the one to take bright in a highlighted lane, the others
 * dim), the lines between them. Returns the width drawn (0: none).
 */
const LANE_W = 22, LANE_H = 32, LANES_MAX = 8;
/** The lanes' cell width for n lanes in at most maxW px. */
const laneW = (n, maxW) => Math.min(LANE_W, maxW / Math.max(1, n));
function drawLanes(cv, L, x, cy, w, col, dim) {
    if (!L || !L.lanes || !L.lanes.length) return 0;
    const n = Math.min(L.lanes.length, LANES_MAX), k = w / LANE_W, h = LANE_H, y0 = cy - h / 2;
    for (let i = 0; i <= n; i++) {
        const mk = L.markers && L.markers[i], lx = x + i * w;
        if (mk === 'SOLID') cv.line(lx, y0, lx, y0 + h, 1.5, dim);
        else for (let j = 0; j < 3; j++) cv.line(lx, y0 + j * h / 3 + 2, lx, y0 + j * h / 3 + h / 6 + 2, 1.5, dim);
    }
    for (let i = 0; i < n; i++) {
        const lane = L.lanes[i], lx = x + (i + 0.5) * w, s = 0.34 * k;
        lane.others.forEach((d) => drawArrow(cv, { kind: 'turn', dir: d }, lx, cy, s, dim, dim));
        if (lane.follow !== 'NONE') drawArrow(cv, { kind: 'turn', dir: lane.follow }, lx, cy, s, lane.hi ? col : dim, dim);
    }
    return n * w;
}

/** Street names in the HUD's fonts (ASCII and a few signs): accents taken off, others left out. */
const FOLD = { 'ß': 'ss', 'ẞ': 'SS', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O', 'œ': 'oe', 'Œ': 'OE', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ı': 'i' };
function foldText(s) {
    let t = String(s || '');
    try { t = t.normalize('NFD'); } catch (e) { /* no ICU: left as it is */ }
    t = t.replace(/[̀-ͯ]/g, '').replace(/[^\u0000-~]/g, (ch) => FOLD[ch] || (ch === '…' || ch === '–' || ch === '·' ? ch : ''));
    return t.replace(/\s+/g, ' ').trim();
}
/** s cut with … to fit w px at size. */
function fit(cv, s, size, w, opts) {
    if (cv.textWidth(s, size, opts) <= w) return s;
    let n = s.length;
    while (n > 1 && cv.textWidth(s.slice(0, n) + '…', size, opts) > w) n--;
    return n > 1 ? s.slice(0, n).trim() + '…' : '';
}

/** Text sizes: the distance (its unit smaller), the street. */
const DIST = 34, UNIT = 20, ROAD = 18;
const DOPTS = { font: 'bold', literal: true }, UOPTS = { font: 'bold', literal: true }, ROPTS = { font: 'label', literal: true };
const AW = 68, GAP = 6;          // the arrow's box, the gap after it

/**
 * The directions picture: cv a NW x NH Canvas (cleared here). m: nav.js's object (null: left empty).
 * opts: { palette } (hud-draw's names; arrows and text in its text colour, roads not taken dim).
 * Right-aligned: [arrow] then the distance over the street, or over the lanes when there are some.
 * Returns where it drew: { x (the arrow's box), lanes: { x, w (a cell) } | null }, or null.
 */
function drawNav(cv, m, opts) {
    cv.clear();
    if (!m) return null;
    const P = PALETTES[(opts && opts.palette) || 'colour'] || PALETTES.colour;
    const col = P.text, dim = withAlpha(P.text, 0.35);
    const textMax = NW - AW - GAP - 2;
    const dist = m.dist ? String(m.dist) : '', unit = m.unit || '';
    const distW = dist ? cv.textWidth(dist, DIST, DOPTS) + 4 + cv.textWidth(unit, UNIT, UOPTS) : 0;
    const nL = m.lanes ? Math.min(m.lanes.lanes.length, LANES_MAX) : 0, lw = nL ? laneW(nL, textMax) : 0;
    // the street only without lanes (both don't fit)
    const road = !nL && m.road ? fit(cv, foldText(m.road), ROAD, textMax, ROPTS) : '';
    const roadW = road ? cv.textWidth(road, ROAD, ROPTS) : 0;
    const tw = Math.min(textMax, Math.max(distW, roadW, nL * lw));
    let x = Math.round(NW - 2 - tw - (tw ? GAP : 0) - AW);
    const out = { x: x, lanes: null };
    drawArrow(cv, m, x + AW / 2, NH / 2, 0.85, col, dim);
    x += AW + GAP;
    // the distance on top, the street or the lanes under it; alone: in the middle
    const under = !!(road || nL);
    if (dist) {
        const dw = cv.text(dist, x, under ? 32 : 50, DIST, col, DOPTS);
        cv.text(unit, x + dw + 4, under ? 32 : 50, UNIT, col, UOPTS);
    }
    if (road) cv.text(road, x, dist ? 60 : 46, ROAD, withAlpha(col, 0.85), ROPTS);
    if (nL) { drawLanes(cv, m.lanes, x, dist ? 57 : NH / 2, lw, col, dim); out.lanes = { x: x, w: lw }; }
    return out;
}

/** Everything the picture depends on (the same key: the same picture). */
function navKey(m, opts) {
    if (!m) return '';
    const L = m.lanes ? m.lanes.lanes.map((l) => (l.hi ? '*' : '') + l.follow + '/' + l.others.join('+')).join(',') + '|' + (m.lanes.markers || []).join(',') : '';
    return [m.kind, m.dir, m.exit, m.exitAngle, m.side, m.dist, m.unit, m.road, L, opts && opts.palette].join('|');
}

/** Sample turns for the test pattern, the previews and the tests. */
const SAMPLES = {
    left: { kind: 'turn', dir: 'LEFT', dist: '450', unit: 'm', road: 'Example Straße', lanes: null },
    lanes: { kind: 'turn', dir: 'STRAIGHT_ON', dist: '700', unit: 'm', road: 'Example Road',
        lanes: { lanes: [{ follow: 'STRAIGHT_ON', others: [], hi: true, info: 'NONE' }, { follow: 'STRAIGHT_ON', others: [], hi: true, info: 'NONE' }, { follow: 'NONE', others: ['RIGHT'], hi: false, info: 'NONE' }], rec: 1, markers: ['SOLID', 'DASHED', 'DASHED', 'SOLID'] } },
    exit: { kind: 'branch', dir: 'BRANCH_LEFT', dist: '4.7', unit: 'km', road: 'Exit 72', lanes: null },
    roundabout: { kind: 'roundabout', dir: null, exit: 1, exitAngle: 307, side: 'left', dist: '300', unit: 'm', road: 'Ring', lanes: null },
    roundabout3: { kind: 'roundabout', dir: null, exit: 3, exitAngle: 90, side: 'left', dist: '150', unit: 'm', road: '', lanes: null },
    uturn: { kind: 'turn', dir: 'UTURN_LEFT', dist: '200', unit: 'm', road: '', lanes: null },
    slight: { kind: 'turn', dir: 'SLIGHT_RIGHT', dist: '0.3', unit: 'mi', road: 'Sample Ave', lanes: null },
    hard: { kind: 'turn', dir: 'HARD_LEFT', dist: '25', unit: 'm', road: '', lanes: null },
    merge: { kind: 'branch', dir: 'HIGHWAY_IN_RIGHT', dist: '1', unit: 'km', road: '', lanes: null },
    keep: { kind: 'keep', dir: 'RIGHT', dist: '800', unit: 'ft', road: '', lanes: null },
    lanechange: { kind: 'lanechange', dir: 'LEFT', dist: '300', unit: 'm', road: '', lanes: null },
    destination: { kind: 'destination', dir: 'LEFT', dist: '50', unit: 'm', road: '', lanes: null },
    follow: { kind: 'follow', dir: 'ferry', dist: null, unit: null, road: '', lanes: null },
    exitLanes: { kind: 'turn', dir: 'RIGHT', dist: '300', unit: 'm', road: 'Am Beispielplatz',
        lanes: { lanes: [{ follow: 'NONE', others: ['LEFT'], hi: false, info: 'NONE' }, { follow: 'RIGHT', others: ['STRAIGHT_ON'], hi: true, info: 'NONE' }], rec: 1, markers: ['SOLID', 'DASHED', 'SOLID'] } },
};

module.exports = { drawNav, drawArrow, drawLanes, navKey, foldText, shapeOf, exitAngleOf, SAMPLES, NW, NH };
