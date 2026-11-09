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
const { withAlpha, mix } = require('./kit/canvas');
const { PALETTES } = require('./hud-draw');

const NW = 200, NH = 76;
const isNum = (x) => typeof x === 'number' && isFinite(x);

/*
 * Arrow geometry in a box of -40..40 (y down), drawn right-handed; mir -1 mirrors it for the left.
 * A shape: { path: [points] (the way to go, bright, ending at the arrow's tip), dim: [[points]...] (roads not
 * taken), mir, cut: [x, y, w, h] (an underpass: the bright road broken where the dim one crosses over it) }.
 * path null: no arrow (a dot, "follow the route").
 */
const SIDE = (d) => (/LEFT/.test(d) ? -1 : 1);
/** The angle of a turn direction name, degrees right of straight on (left ones: mirrored). */
function turnDeg(d) { return /SLIGHT/.test(d) ? 45 : /HARD|SHARP/.test(d) ? 135 : /LEFT|RIGHT/.test(d) ? 90 : 0; }
function turnPath(deg) {
    const a = deg * Math.PI / 180;
    if (deg === 0) return [[0, 36], [0, -36]];
    // a hard turn: the stem on the other side and bending high, so the way back down stands clear of it
    if (deg >= 135) return [[-15, 36], [-15, -22], [-15 + Math.sin(a) * 48, -22 - Math.cos(a) * 48]];
    return [[0, 36], [0, 2], [Math.sin(a) * 30, 2 - Math.cos(a) * 30]];
}
/** A turn by its direction name (TurnDirection: STRAIGHT_ON, LEFT, SLIGHT_RIGHT, HARD_LEFT, UTURN_RIGHT...). NONE: no arrow. */
function turnShape(dir) {
    const d = String(dir || '');
    if (d === 'NONE' || d === '') return { path: null, mir: 1 };
    const mir = SIDE(d);
    if (/UTURN|U_TURN/.test(d)) {
        // up on one side, round over the top, back down on the side it turns to (UTURN_LEFT: ends on the left)
        const p = [[13, 36], [13, -8]];
        for (let i = 1; i <= 10; i++) { const a = i * Math.PI / 10; p.push([13 * Math.cos(a), -8 - 13 * Math.sin(a)]); }
        p.push([-13, 24]);
        return { path: p, mir: -mir };
    }
    return { path: turnPath(turnDeg(d)), mir: mir };
}

/*
 * Every bright path ends in a straight run at least HEAD_RUN long, so the head sits on a straight piece: with the
 * bend under the head's base, the thick stroke coming into it bulged out on one side and that side of the head
 * looked smaller (2026-11-09 review). The tests check it for every arrow.
 */
const HEAD_RUN = 28;
// the legs of forks and branches, right-handed; the split is at y 10, the bend at y -6
const STEM = [[0, 36], [0, 10]];
const LEG = { left: [[0, 10], [-18, -6], [-18, -38]], right: [[0, 10], [18, -6], [18, -38]], center: [[0, 10], [0, -38]] };
/** A fork into legs (names of LEG), the one taken bright. */
function forkOf(legs, take) {
    return { path: STEM.concat(LEG[take].slice(1)), dim: legs.filter((l) => l !== take).map((l) => LEG[l]), mir: 1 };
}
/** A motorway exit on side ('left' / 'right'): the main road straight on, the slip road peeling off. take: 'exit' / 'main'. */
const EXIT_LEG = { right: [[0, 18], [8, 10], [20, -4], [20, -38]], left: [[0, 18], [-8, 10], [-20, -4], [-20, -38]] };
function exitOf(side, take) {
    const leg = EXIT_LEG[side];
    return take === 'exit' ? { path: [[0, 36]].concat(leg), dim: [[[0, 18], [0, -34]]], mir: 1 } : { path: [[0, 36], [0, -38]], dim: [leg], mir: 1 };
}
/** An exit on side that forks in two after it; sub: 'left' / 'right' (the branch of the slip road taken). */
function exitForkOf(side, sub) {
    const sx = side === 'left' ? -1 : 1, split = [sx * 16, 4];
    const leg = (t) => [split, [split[0] + (t === 'left' ? -9 : 9), -8], [split[0] + (t === 'left' ? -9 : 9), -38]];
    return { path: [[0, 36], [0, 22], [sx * 6, 16], split].concat(leg(sub).slice(1)), dim: [[[0, 22], [0, -34]], leg(sub === 'left' ? 'right' : 'left')], mir: 1 };
}
/** Straight on, under (cut) or over a road crossing it. */
function crossingOf(under) {
    return { path: [[0, 36], [0, -36]], dim: [[[-34, 0], [34, 0]]], mir: 1, cut: under ? [-11, -9, 22, 18] : null };
}

/**
 * detailedGeometry (ManeuverGeometry, 31 values in the car's catalog): the junction's exact shape when the car
 * gives one (seen on the drive: UNDEFINED). Over- / underpass variants are drawn as the plain fork. null: no shape.
 */
function geometryShape(g) {
    g = String(g || '');
    let r = /^EXIT_(LEFT|RIGHT)_TAKE_(LEFT|RIGHT)$/.exec(g);
    if (r) return exitOf(r[1].toLowerCase(), r[1] === r[2] ? 'exit' : 'main');
    r = /^EXIT_(LEFT|RIGHT)_TWO_WAY_FORK_TAKE_(?:LEFT|RIGHT)_(LEFT|RIGHT)$/.exec(g);
    if (r) return exitForkOf(r[1].toLowerCase(), r[2].toLowerCase());
    r = /^THREE_WAY_FORK_.*TAKE_(LEFT|CENTER|RIGHT)$/.exec(g);
    if (r) return forkOf(['left', 'center', 'right'], r[1].toLowerCase());
    r = /^TWO_WAY_FORK_.*TAKE_(LEFT|RIGHT)$/.exec(g);
    if (r) return forkOf(['left', 'right'], r[1].toLowerCase());
    return null;
}

/** A road branching off to one side (BRANCH_*, keep left / right along the main road): the way on dim, straight. */
function branchOf(side) { return { path: STEM.concat(LEG[side].slice(1)), dim: [LEG.center], mir: 1 }; }

/** BranchType (15 values in the catalog) as a shape. */
function branchShape(d) {
    const side = /LEFT/.test(d) ? 'left' : 'right';
    if (/^HIGHWAY_IN/.test(d)) {
        // onto the motorway: the motorway dim, the slip road joining it from the other side
        if (/STRAIGHT/.test(d)) return { path: [[0, 36], [0, -36]], dim: [[[-24, 36], [-6, 6]], [[24, 36], [6, 6]]], mir: 1 };
        return { path: [[-16, 36], [-16, 16], [8, -8], [8, -36]], dim: [[[16, 36], [16, -36]]], mir: SIDE(d) };
    }
    if (/^HIGHWAY_OUT/.test(d)) {
        // off the motorway; STRAIGHT: the motorway bends away on both sides, the way off goes on
        if (/STRAIGHT/.test(d)) return { path: [[0, 36], [0, -36]], dim: [LEG.left, LEG.right], mir: 1 };
        return exitOf(side, 'exit');
    }
    if (/^TRIPLE_FORK/.test(d)) return forkOf(['left', 'center', 'right'], /STRAIGHT/.test(d) ? 'center' : side);
    if (/^FORK/.test(d)) return forkOf(['left', 'right'], side);
    if (d === 'OVERPASS' || d === 'UNDERPASS') return crossingOf(d === 'UNDERPASS');
    if (/^BRANCH_(LEFT|RIGHT)$/.test(d)) return branchOf(side);
    return { path: [[0, 36], [0, -36]], mir: 1 };       // BRANCH_STRAIGHT and anything newer
}

/** The shape for nav.js's object (roundabouts, flags and transport are drawn by their own functions). */
function shapeOf(m) {
    if (!m) return { path: null, mir: 1 };
    const d = String(m.dir || '');
    // the exact shape first, when the car gives one
    const g = (m.kind === 'turn' || m.kind === 'branch') && m.geom ? geometryShape(m.geom) : null;
    if (g) return g;
    switch (m.kind) {
    case 'turn': return turnShape(d);
    case 'keep': return /LEFT|RIGHT/.test(d) ? branchOf(/LEFT/.test(d) ? 'left' : 'right') : turnShape('STRAIGHT_ON');
    case 'lanechange': return { path: [[-12, 36], [-12, 14], [12, -8], [12, -36]], dim: [[[-12, 14], [-12, -32]]], mir: SIDE(d) };
    case 'branch': return branchShape(d);
    default: return { path: null, mir: 1 };
    }
}

/**
 * The exit's direction for drawing: degrees ANTICLOCKWISE from straight on (90: left).
 * The car's exitAngle is read as degrees CLOCKWISE from straight on: the drive (left-hand traffic, Australia)
 * had exit 1 at 307, i.e. 53 degrees left, where a first exit is in clockwise roundabouts; it's also how a
 * CarPlay angle of -53 wraps into 0..359. Not yet seen: a roundabout in right-hand traffic.
 * No angle: from the exit's number, a four-way roundabout (left traffic: left first; right traffic: right first).
 */
function exitAngleOf(m) {
    if (isNum(m.exitAngle)) return ((360 - m.exitAngle) % 360 + 360) % 360;
    const n = isNum(m.exit) && m.exit > 0 ? m.exit : 2;
    return m.side === 'left' ? ((90 - 90 * (n - 1)) % 360 + 360) % 360 : (270 + 90 * (n - 1)) % 360;
}

/** A polyline with round joins and ends. */
function stroke(cv, pts, X, Y, w, c) {
    for (let i = 1; i < pts.length; i++) cv.line(X(pts[i - 1]), Y(pts[i - 1]), X(pts[i]), Y(pts[i]), w, c);
}
/** The bright path and its head: the head's tip at the path's end, along the last segment; the shaft runs into its base. */
function arrowPath(cv, path, X, Y, s, W, col) {
    const p = path.slice(), a = p[p.length - 2], b = p[p.length - 1];
    const ax = X(a), ay = Y(a), bx = X(b), by = Y(b);
    const l = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay)) || 1, ux = (bx - ax) / l, uy = (by - ay) / l;
    const L = 20 * s, HW = 15 * s;
    const back = Math.min(L * 0.7, l * 0.9) / l;
    p[p.length - 1] = [b[0] + (a[0] - b[0]) * back, b[1] + (a[1] - b[1]) * back];
    stroke(cv, p, X, Y, W, col);
    const qx = bx - ux * L, qy = by - uy * L;
    cv.triangle([[bx, by], [qx - uy * HW, qy + ux * HW], [qx + uy * HW, qy - ux * HW]], col);
}

/**
 * The arrow for m, centred at cx, cy, s: scale (1 = an 80 px box). col: bright, dim: the roads not taken.
 * Draws nothing for null.
 */
function drawArrow(cv, m, cx, cy, s, col, dim) {
    if (!m) return;
    const W = 12 * s;
    if (m.kind === 'roundabout') { drawRoundabout(cv, m, cx, cy, s, col, dim); return; }
    if (m.kind === 'destination') { if (m.flag === false) drawStop(cv, m, cx, cy, s, col); else drawFlag(cv, m, cx, cy, s, col, dim); return; }
    if (m.kind === 'transport') { drawTransport(cv, m, cx, cy, s, col, dim); return; }
    const sh = shapeOf(m);
    // follow the route: a dot in a ring
    if (!sh.path) { cv.circle(cx, cy, 10 * s, col); cv.arc(cx, cy, 17 * s, 21 * s, 0, 360, dim); return; }
    const X = (p) => cx + p[0] * sh.mir * s, Y = (p) => cy + p[1] * s;
    const dims = () => (sh.dim || []).forEach((p) => stroke(cv, p, X, Y, W * 0.8, dim));
    // an underpass: the bright road first, broken where the dim road passes over it
    if (!sh.cut) dims();
    arrowPath(cv, sh.path, X, Y, s, W, col);
    if (sh.cut) { cv.fillRect(cx + sh.cut[0] * s, cy + sh.cut[1] * s, sh.cut[2] * s, sh.cut[3] * s, [0, 0, 0, 255]); dims(); }
}

/**
 * The roundabout: the ring dim; one bright path in from below, round the island's way and out at the exit's
 * angle, with the head; the exit's number in the middle. side: the traffic side (the car's driveDirection):
 * 'left' (left-hand traffic, the drive): clockwise; 'right': anticlockwise.
 * Back the way it came (a U-turn, exit at about 180): the way in comes up on the drive side of the bottom and the
 * way out goes straight down beside it, two strokes apart, not one on the other (2026-11-09 review).
 */
const RB_IN = 42;            // the way in, degrees to the drive side of the bottom; exits closer to 180 than this: beside it
const RB_BACK = 45;          // exits this close to 180 leave straight down, parallel to the way in
function drawRoundabout(cv, m, cx, cy, s, col, dim) {
    const R = 16, oy = -2, W = 9 * s;
    const X = (p) => cx + p[0] * s, Y = (p) => cy + p[1] * s;
    cv.arc(cx, cy + oy * s, (R - 4) * s, (R + 4) * s, 0, 360, dim);
    const dir = m.side === 'left' ? -1 : 1;           // +1: angles grow (anticlockwise on the map); left traffic: clockwise
    const inA = 180 + dir * RB_IN;
    let a = exitAngleOf(m);
    // an exit in the way in's place: just past the bottom on the other side
    if (Math.abs(a - 180) < RB_IN) a = 180 - dir * RB_IN;
    let to = a;
    while (dir > 0 ? to <= inA : to >= inA) to += dir * 360;
    while (Math.abs(to - inA) > 360) to -= dir * 360;
    const pt = (deg, r) => { const t = deg * Math.PI / 180; return [-Math.sin(t) * r, oy - Math.cos(t) * r]; };
    const path = [[pt(inA, R)[0], 40], pt(inA, R)];
    const n = Math.max(2, Math.ceil(Math.abs(to - inA) / 12));
    for (let i = 1; i <= n; i++) path.push(pt(inA + (to - inA) * i / n, R));
    // out: a spoke long enough that the head sits clear of the ring; backwards: straight down beside the way in
    const end = pt(to, R);
    if (Math.abs(a - 180) <= RB_BACK) path.push([end[0], end[1] + 4], [end[0], 40]);
    else path.push(pt(to, R + 5), pt(to, R + 26));
    arrowPath(cv, path, X, Y, s * 0.7, W, col);
    if (isNum(m.exit)) cv.text(String(m.exit), cx, cy + (oy + 5.5) * s, 15 * s, col, { align: 'center', font: 'bold', literal: true });
}

/** Arrival: a chequered flag; LEFT / RIGHT: a small arrow on the ground towards that side (CENTER, NOT_DIGITIZED: none). */
function drawFlag(cv, m, cx, cy, s, col, dim) {
    const d = String(m.dir || ''), mir = /LEFT/.test(d) ? -1 : /RIGHT/.test(d) ? 1 : 0;
    const px = cx - (mir || 1) * 10 * s;
    cv.line(px, cy + 26 * s, px, cy - 32 * s, 6 * s, col);
    const fw = 32 * s, fh = 24 * s, cw = fw / 4, ch = fh / 2, x0 = mir < 0 ? px - fw : px, y0 = cy - 32 * s;
    for (let i = 0; i < 4; i++) for (let j = 0; j < 2; j++) cv.fillRect(x0 + i * cw, y0 + j * ch, cw, ch, (i + j) % 2 ? dim : col);
    if (mir) cv.triangle([[cx + mir * 32 * s, cy + 30 * s], [cx + mir * 16 * s, cy + 20 * s], [cx + mir * 16 * s, cy + 40 * s]], col);
}

/** A stopover on the way (isCheckeredFlag false): a pin with its number. */
function drawStop(cv, m, cx, cy, s, col) {
    const r = 18 * s, py = cy - 10 * s;
    cv.circle(cx, py, r, col);
    cv.triangle([[cx - r * 0.75, py + r * 0.65], [cx + r * 0.75, py + r * 0.65], [cx, cy + 34 * s]], col);
    cv.circle(cx, py, r - 5 * s, [0, 0, 0, 255]);
    if (isNum(m.stop) && m.stop > 0) cv.text(String(m.stop), cx, py + 7 * s, 20 * s, col, { align: 'center', font: 'bold', literal: true });
}

/** Onto a ferry or a car train (vehicleTransportation). */
function drawTransport(cv, m, cx, cy, s, col, dim) {
    const X = (x) => cx + x * s, Y = (y) => cy + y * s;
    if (/TRAIN/.test(String(m.dir))) {
        cv.roundRect(X(-24), Y(-30), 48 * s, 48 * s, 9 * s, col);
        cv.fillRect(X(-17), Y(-22), 34 * s, 14 * s, [0, 0, 0, 255]);
        cv.circle(X(-12), Y(6), 5 * s, [0, 0, 0, 255]); cv.circle(X(12), Y(6), 5 * s, [0, 0, 0, 255]);
        cv.line(X(-14), Y(20), X(-24), Y(34), 5 * s, col); cv.line(X(14), Y(20), X(24), Y(34), 5 * s, col);
        cv.line(X(-30), Y(30), X(30), Y(30), 3 * s, dim);
        return;
    }
    // ferry: a cabin, the hull, two waves
    cv.fillRect(X(-10), Y(-30), 20 * s, 14 * s, col);
    cv.convex([[X(-32), Y(-12)], [X(32), Y(-12)], [X(22), Y(10)], [X(-22), Y(10)]], col);
    [20, 32].forEach((y, i) => {
        const pts = [];
        for (let x = -34; x <= 34; x += 4) pts.push([X(x), Y(y + Math.sin(x / 6) * 3)]);
        cv.polyline(pts, 4 * s, i ? dim : col);
    });
}

/*
 * The lanes: one cell per lane, the lines between them (SOLID / DASHED, from the car). Each lane's arrows are
 * lane glyphs, not the big turn arrows: one stem from the bottom shared by all of a lane's arrows, a turn's arm
 * leaving low, straight on running to the top, so a straight-and-right lane shows both heads well apart (with the
 * big arrows the straight head sat just over the turn's arm: 2026-11-09 review). The arrows to take (in a lane to
 * be in) bright, the others dim. BLOCKED: a dim cross; ELLIPSIS (more lanes than shown): three dots.
 */
const LANE_W = 22, LANE_H = 32, LANES_MAX = 8, LANE_S = 0.4;
/** The lanes' cell width for n lanes in at most maxW px. */
const laneW = (n, maxW) => Math.min(LANE_W, maxW / Math.max(1, n));
/** A lane glyph's path (box -40..40, right-handed; LEFT ones mirrored): the stem from the bottom, then the arm. */
function lanePath(dir) {
    const d = String(dir || ''), mir = SIDE(d);
    if (/UTURN|U_TURN/.test(d)) {
        // up the stem, over the top towards the side, back down beside it (UTURN_LEFT: on the left)
        // ends above where a turn's arm leaves (y 22), so a turn-and-U-turn lane keeps them apart
        const p = [[0, 36], [0, -14]];
        for (let i = 1; i <= 8; i++) { const a = Math.PI - i * Math.PI / 8; p.push([7 + 7 * Math.cos(a), -14 - 7 * Math.sin(a)]); }
        p.push([14, 4]);
        return { path: p, mir: mir };
    }
    const deg = turnDeg(d);
    if (deg === 0) return { path: [[0, 36], [0, -38]], mir: 1 };
    if (deg === 45) return { path: [[0, 36], [0, 14], [22, -10]], mir: mir };
    if (deg === 90) return { path: [[0, 36], [0, 22], [26, 22]], mir: mir };
    return { path: [[0, 36], [0, -16], [24, 10]], mir: mir };          // hard: up, then back down to the side
}
/** One lane's arrows at cx, cy: dim ones first, the ones to take over them. */
function drawLaneArrows(cv, lane, cx, cy, k, col, dim) {
    // thinner than the big arrows (9 against 12): in a 22 px cell the big stroke looked heavy (2026-11-09 review)
    const s = LANE_S * k, W = 9 * s;
    const one = (d, c) => {
        if (!d || d === 'NONE') return;
        const g = lanePath(d), X = (p) => cx + p[0] * g.mir * s, Y = (p) => cy + p[1] * s;
        // a smaller head than the big arrows' (in a 22 px cell), on the same stroke
        arrowPath(cv, g.path, X, Y, s * 0.8, W, c);
    };
    if (lane.info === 'ELLIPSIS') { [-7, 0, 7].forEach((dx) => cv.circle(cx + dx * k, cy, 1.8 * k, dim)); return; }
    const follows = lane.follows || (lane.follow && lane.follow !== 'NONE' ? [lane.follow] : []);
    const blocked = lane.info === 'BLOCKED';
    lane.others.forEach((d) => one(d, dim));
    follows.forEach((d) => one(d, lane.hi && !blocked ? col : dim));
    if (blocked) { const r = 7 * k; cv.line(cx - r, cy - r, cx + r, cy + r, 2.5 * k, col); cv.line(cx - r, cy + r, cx + r, cy - r, 2.5 * k, col); }
}
function drawLanes(cv, L, x, cy, w, col, dim) {
    if (!L || !L.lanes || !L.lanes.length) return 0;
    const n = Math.min(L.lanes.length, LANES_MAX), k = w / LANE_W, h = LANE_H, y0 = cy - h / 2;
    for (let i = 0; i <= n; i++) {
        const mk = L.markers && L.markers[i], lx = x + i * w;
        if (mk === 'SOLID') cv.line(lx, y0, lx, y0 + h, 1.5, dim);
        else for (let j = 0; j < 3; j++) cv.line(lx, y0 + j * h / 3 + 2, lx, y0 + j * h / 3 + h / 6 + 2, 1.5, dim);
    }
    for (let i = 0; i < n; i++) drawLaneArrows(cv, L.lanes[i], x + (i + 0.5) * w, cy, Math.min(1, k), col, dim);
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
    // dim: a solid dark shade, not a see-through one (overlapping strokes of a see-through colour add up at every bend)
    const col = P.text, dim = mix('#000000', P.text, 0.35);
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
    const L = m.lanes ? m.lanes.lanes.map((l) => (l.hi ? '*' : '') + (l.follows || [l.follow]).join('+') + '/' + l.others.join('+') + '/' + l.info).join(',') + '|' + (m.lanes.markers || []).join(',') : '';
    return [m.kind, m.dir, m.geom, m.exit, m.exitAngle, m.side, m.flag, m.stop, m.dist, m.unit, m.road, L, opts && opts.palette].join('|');
}

/*
 * Every value the car's catalog (someip-interfaces.json, navigation.GuidingTypes) has for what decides the arrow,
 * so the tests and the review sheet draw them all: TurnDirection, BranchType, ManeuverGeometry, Side,
 * DestinationPosition, MainRoadDirection, VehicleTransportationType.
 */
const TURN_DIRECTIONS = ['STRAIGHT_ON', 'SLIGHT_LEFT', 'LEFT', 'HARD_LEFT', 'UTURN_LEFT', 'SLIGHT_RIGHT', 'RIGHT', 'HARD_RIGHT', 'UTURN_RIGHT', 'NONE'];
const BRANCH_TYPES = ['BRANCH_LEFT', 'BRANCH_RIGHT', 'FORK_LEFT', 'FORK_RIGHT', 'TRIPLE_FORK_LEFT', 'TRIPLE_FORK_STRAIGHT', 'TRIPLE_FORK_RIGHT',
    'HIGHWAY_OUT_LEFT', 'HIGHWAY_OUT_STRAIGHT', 'HIGHWAY_OUT_RIGHT', 'HIGHWAY_IN_LEFT', 'HIGHWAY_IN_STRAIGHT', 'HIGHWAY_IN_RIGHT', 'OVERPASS', 'UNDERPASS'];
const GEOMETRIES = ['EXIT_LEFT_TAKE_LEFT', 'EXIT_LEFT_TAKE_RIGHT', 'EXIT_RIGHT_TAKE_LEFT', 'EXIT_RIGHT_TAKE_RIGHT',
    'EXIT_LEFT_TWO_WAY_FORK_TAKE_LEFT_LEFT', 'EXIT_LEFT_TWO_WAY_FORK_TAKE_LEFT_RIGHT', 'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_LEFT', 'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_RIGHT',
    'THREE_WAY_FORK_TAKE_LEFT', 'THREE_WAY_FORK_TAKE_CENTER', 'THREE_WAY_FORK_TAKE_RIGHT',
    'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_LEFT', 'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_CENTER', 'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_RIGHT',
    'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_LEFT', 'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_CENTER', 'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_RIGHT',
    'TWO_WAY_FORK_TAKE_LEFT', 'TWO_WAY_FORK_TAKE_RIGHT',
    'TWO_WAY_FORK_OVERPASS_LEFT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_LEFT_TAKE_RIGHT', 'TWO_WAY_FORK_OVERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_RIGHT_TAKE_RIGHT',
    'TWO_WAY_FORK_UNDERPASS_LEFT_TAKE_LEFT', 'TWO_WAY_FORK_UNDERPASS_LEFT_TAKE_RIGHT', 'TWO_WAY_FORK_UNDERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_UNDERPASS_RIGHT_TAKE_RIGHT',
    'TWO_WAY_FORK_OVERPASS_LEFT_UNDERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_LEFT_UNDERPASS_RIGHT_TAKE_RIGHT',
    'TWO_WAY_FORK_UNDERPASS_LEFT_OVERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_UNDERPASS_LEFT_OVERPASS_RIGHT_TAKE_RIGHT'];
/** One object per arrow the car can ask for (label: the value it stands for). */
const ALL_ARROWS = [].concat(
    TURN_DIRECTIONS.map((d) => ({ kind: 'turn', dir: d, label: d })),
    BRANCH_TYPES.map((d) => ({ kind: 'branch', dir: d, label: d })),
    GEOMETRIES.map((g) => ({ kind: 'branch', dir: 'BRANCH_LEFT', geom: g, label: g.replace('TWO_WAY_FORK', '2FORK').replace('THREE_WAY_FORK', '3FORK').replace(/DERPASS|ERPASS/g, '') })),
    [270, 315, 0, 45, 90, 180, 307].map((a, i) => ({ kind: 'roundabout', exit: i + 1, exitAngle: a, side: 'left', label: 'RB left ' + a })),
    [90, 0, 270, 180].map((a, i) => ({ kind: 'roundabout', exit: i + 1, exitAngle: a, side: 'right', label: 'RB right ' + a })),
    [{ kind: 'roundabout', exit: 2, exitAngle: null, side: 'left', label: 'RB exit 2, no angle' }],
    ['LEFT', 'CENTER', 'RIGHT', 'NOT_DIGITIZED'].map((d) => ({ kind: 'destination', dir: d, flag: true, label: 'DEST ' + d })),
    [{ kind: 'destination', dir: 'RIGHT', flag: false, stop: 2, label: 'STOPOVER 2' }],
    ['LEFT', 'RIGHT'].map((d) => ({ kind: 'keep', dir: d, label: 'ALONG MAIN ' + d })),
    ['LEFT', 'RIGHT'].map((d) => ({ kind: 'lanechange', dir: d, label: 'LANE CHANGE ' + d })),
    ['FERRY', 'CAR_TRAIN'].map((d) => ({ kind: 'transport', dir: d, label: d })),
    [{ kind: 'follow', dir: 'unknown', label: 'FOLLOW (unknown)' }]);

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

module.exports = { HEAD_RUN, lanePath, drawLaneArrows, drawNav, drawArrow, drawLanes, navKey, foldText, shapeOf, geometryShape, exitAngleOf, SAMPLES, NW, NH, ALL_ARROWS, TURN_DIRECTIONS, BRANCH_TYPES, GEOMETRIES };
