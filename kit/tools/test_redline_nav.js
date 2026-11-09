'use strict';
// Redline's own HUD directions, the data side (apps/redline/nav.js): the decoder, run on the replies a G21 sent with
// CarPlay / Apple Maps (2026-11-09, Redline 1.16.5's probe; street names already replaced by their length), then the
// tracker's freshness and give-way rules on a driven clock, then the probe's tap. Node 8 compatible.
//   node kit/tools/test_redline_nav.js
const fs = require('fs'), os = require('os'), path = require('path');
const APP = path.join(__dirname, '..', '..', 'apps', 'redline');
const Nav = require(path.join(APP, 'nav'));
const NavLog = require(path.join(APP, 'navlog'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')');

// ---- the car's replies -------------------------------------------------------------------------------------------
const FIX = path.join(__dirname, 'fixtures', 'redline-nav-carplay-2026-11-09.txt');
const rows = fs.readFileSync(FIX, 'utf8').trim().split('\n').map((l) => {
    const m = l.match(/^(\S+) nav: (\S+) (?:(\S+) )?= (.*)$/);
    return m ? { t: Date.parse(m[1]), src: m[2], field: m[3] || '', v: JSON.parse(m[4]) } : null;
}).filter((r) => r);
const replies = rows.filter((r) => r.src === 'events');
const laneRows = rows.filter((r) => r.field === 'currentLaneGuiding');
ok(replies.length === 149 && laneRows.length > 100, 'the fixture has the drive\'s replies (' + replies.length + ' events, ' + laneRows.length + ' lanes)');

// every reply decodes, its first event is a manoeuvre with a distance; the second (the turn after it) has none
const firsts = [], kinds = {};
replies.forEach((r, i) => {
    const d = Nav.decodeEvents(r.v);
    if (!d.ok) { ok(false, 'reply ' + i + ' decodes: ' + d.error); return; }
    ok(d.events.length === d.raw, 'reply ' + i + ': every event is a manoeuvre (' + d.events.length + '/' + d.raw + ')');
    const m = d.events[0];
    firsts.push(m);
    kinds[m.kind] = (kinds[m.kind] || 0) + 1;
    ok(m.dist && /^\d+(\.\d+)?$/.test(m.dist) && (m.unit === 'm' || m.unit === 'km'), 'reply ' + i + ': the next turn has a distance (' + m.dist + ' ' + m.unit + ')');
    ok(/^<\d+ chars>$/.test(m.road), 'reply ' + i + ': its description is the road (' + m.road + ')');
    if (d.events[1]) ok(d.events[1].dist === null && d.events[1].unit === null, 'reply ' + i + ': the turn after it, unit NONE: no distance');
});
eq(Object.keys(kinds).sort().map((k) => k + ' ' + kinds[k]), ['branch 41', 'destination 5', 'roundabout 13', 'turn 90'], 'the drive\'s next turns by kind');

// the first reply: left in 1 km
eq(Nav.decodeEvents(replies[0].v).events[0], { kind: 'turn', dir: 'LEFT', geom: null, exit: null, exitAngle: null, side: null, flag: null, stop: null, dist: '1', unit: 'km', road: '<12 chars>', unreliable: false, dtd: 8985 },
    'first reply: a left turn in 1 km (rawDistance 1 isn\'t metres)');
// directions seen
const dirs = {};
firsts.filter((m) => m.kind === 'turn').forEach((m) => { dirs[m.dir] = true; });
eq(Object.keys(dirs).sort(), ['LEFT', 'RIGHT', 'STRAIGHT_ON'], 'turn directions seen');
// the motorway exit counted down from 4.7 km to metres
const exits = firsts.filter((m) => m.kind === 'branch');
ok(exits.every((m) => m.dir === 'BRANCH_LEFT'), 'the exit is BRANCH_LEFT');
ok(exits[0].dist === '5.1' && exits[0].unit === 'km' && exits.some((m) => m.dist === '4.7') && exits.some((m) => m.unit === 'm'), 'the exit counts down from 5.1 km into metres (' + exits[0].dist + ' ' + exits[0].unit + ')');
ok(Nav.metres(exits[0]) === 5100, '5.1 km is 5100 m');
// the roundabout: first exit at 307 degrees, island on the left
const rb = firsts.filter((m) => m.kind === 'roundabout')[0];
ok(rb.exit === 1 && rb.exitAngle === 307 && rb.side === 'left' && rb.dir === null, 'roundabout: exit 1 at 307, anticlockwise (' + Nav.describe(rb) + ')');
// arrival on the left
const dest = firsts.filter((m) => m.kind === 'destination')[0];
ok(dest.dir === 'LEFT', 'destination on the left');
// distances only ever count down for one turn (the same kind and direction in a row)
let rises = 0;
for (let i = 1; i < firsts.length; i++) {
    const a = firsts[i - 1], b = firsts[i];
    if (a.kind === b.kind && a.dir === b.dir && a.road === b.road && Nav.metres(b) > Nav.metres(a) + 150) rises++;
}
ok(rises <= 2, 'distances count down per turn (' + rises + ' rises)');
// metres() from the car's text
ok(Nav.metres({ dist: '1,234', unit: 'ft' }) === 1234 * 0.3048 && Nav.metres({ dist: '1,5', unit: 'km' }) === 1500, 'metres(): "1,234 ft" is thousands, "1,5 km" a decimal comma');
ok(Nav.metres({ dist: '450', unit: 'm' }) === 450 && Nav.metres({ dist: '0,5', unit: 'km' }) === 500 && Nav.metres({ dist: null, unit: null }) === null, 'metres() reads 450 m, 0,5 km, none');

// ---- lanes ---------------------------------------------------------------------------------------------------------
const lanes = laneRows.map((r) => Nav.decodeLanes(r.v));
ok(lanes.some((l) => l === null), 'rows: [] decode to no lanes');
const pats = {};
lanes.filter((l) => l).forEach((l) => { pats[l.lanes.map((x) => (x.hi ? '*' : '') + x.follow + (x.others.length ? '/' + x.others.join('+') : '')).join(' ') + ' rec' + l.rec] = true; });
eq(Object.keys(pats).sort(), [
    'NONE/LEFT *RIGHT/STRAIGHT_ON rec1',
    '*SLIGHT_LEFT NONE/STRAIGHT_ON NONE/STRAIGHT_ON rec0',
    '*STRAIGHT_ON *STRAIGHT_ON NONE/RIGHT rec1',
    '*STRAIGHT_ON NONE/RIGHT rec0',
    'NONE/STRAIGHT_ON *RIGHT/UTURN_RIGHT rec1',
].sort(), 'the drive\'s five lane pictures');
const three = lanes.filter((l) => l && l.lanes.length === 3 && l.lanes[2].others[0] === 'RIGHT')[0];
eq(three, { lanes: [{ follow: 'STRAIGHT_ON', follows: ['STRAIGHT_ON'], others: [], hi: true, info: 'NONE' }, { follow: 'STRAIGHT_ON', follows: ['STRAIGHT_ON'], others: [], hi: true, info: 'NONE' }, { follow: 'NONE', follows: [], others: ['RIGHT'], hi: false, info: 'NONE' }],
    rec: 1, markers: ['DASHED', 'DASHED', 'DASHED', 'DASHED'] }, '3 lanes: two straight on highlighted, the right one not');
// BMW's and the phone's lane lines are the same data
const phone = laneRows.filter((r) => r.src === 'phone'), bmw = laneRows.filter((r) => r.src === 'guidance');
ok(phone.every((p) => bmw.some((g) => JSON.stringify(g.v) === JSON.stringify(p.v))), 'the phone\'s lane rows are BMW\'s');

// ---- other shapes (not seen on the drive yet; the names are the service's) -------------------------------------
const fd = (d, u) => ({ distance: d, unit: u, rawDistance: 1 });
eq(Nav.decodeEvent({ alongMainRoad: { mainRoadDirection: 'LEFT', formattedDistance: fd('300', 'METER') } }).kind + Nav.decodeEvent({ alongMainRoad: { mainRoadDirection: 'LEFT', formattedDistance: fd('300', 'METER') } }).dir, 'keepLEFT', 'alongMainRoad: keep left');
eq(Nav.decodeEvent({ laneChange: { changeSide: 'RIGHT', formattedDistance: fd('200', 'METER') } }).kind, 'lanechange', 'laneChange');
eq(Nav.decodeEvent({ branch: { branchType: 'HIGHWAY_OUT_RIGHT', formattedDistance: fd('0.5', 'MILE_US') } }).unit, 'mi', 'miles');
eq(Nav.decodeEvent({ intersection: { direction: 'HARD_RIGHT', formattedDistance: fd('800', 'FEET') } }).unit, 'ft', 'feet');
eq(Nav.decodeEvent({ roundabout: { exitNumber: 3, exitAngle: -90, driveDirection: 'RIGHT', formattedDistance: fd('150', 'YARD') } }), { kind: 'roundabout', dir: null, geom: null, exit: 3, exitAngle: 270, side: 'right', flag: null, stop: null, dist: '150', unit: 'yd', road: '', unreliable: false, dtd: null }, 'roundabout, left-hand traffic, angle wrapped');
eq(Nav.decodeEvent({ ferry: { formattedDistance: fd('2', 'KM') } }).kind, 'follow', 'an unknown kind with a distance: follow the route');
ok(Nav.decodeEvent({ pointOfInterest: { formattedDistance: fd('2', 'KM') } }) === null, 'a point of interest isn\'t a turn');
ok(Nav.decodeEvent({ laneGuiding: { lanes: [] } }) === null && Nav.decodeEvent(null) === null && Nav.decodeEvent({ a: {}, b: {} }) === null, 'not a manoeuvre: null');
ok(Nav.decodeEvent({ intersection: { direction: 'LEFT', formattedDistance: fd('', 'METER') } }).dist === null, 'an empty distance is none');
// replies that say nothing
eq(Nav.decodeEvents({ GuidanceEventListError: 'NOT_AVAILABLE' }), { ok: false, error: 'NOT_AVAILABLE', events: [], raw: 0 }, 'an error reply');
eq(Nav.decodeEvents({ GuidanceEventListError: 'NO_ERROR', viewContent: [] }).error, 'no view', 'no view');
eq(Nav.decodeEvents({ GuidanceEventListError: 'NO_ERROR', viewContent: [{ eventsInView: [] }] }), { ok: true, error: null, events: [], raw: 0 }, 'no events: ok, no turn');
ok(Nav.decodeEvents('x').ok === false && Nav.decodeEvents(null).ok === false, 'nonsense: not ok');
// enum values as numbers (another firmware): the turn still shows, with the number as its direction
ok(Nav.decodeEvent({ intersection: { direction: 2, formattedDistance: fd('100', 4) } }).dir === 'LEFT' && Nav.decodeEvent({ intersection: { direction: 2, formattedDistance: fd('100', 4) } }).unit === 'm', 'numeric enums: the catalog\'s numbers (direction 2 = LEFT, unit 4 = METER)');
// anything not a direction gives no arrow (the dot), never a guess (2026-11-09 bug review: these drew straight on)
ok(Nav.decodeEvent({ intersection: { formattedDistance: fd('100', 'METER') } }).dir === 'NONE', 'an intersection with no direction: NONE');
ok(Nav.decodeEvent({ intersection: { direction: 'WIGGLE', formattedDistance: fd('100', 'METER') } }).dir === 'NONE' && Nav.decodeEvent({ intersection: { direction: 42, formattedDistance: fd('100', 'METER') } }).dir === 'NONE', 'an unknown direction (name or number): NONE');
ok(Nav.decodeEvent({ branch: { formattedDistance: fd('100', 'METER') } }).dir === 'NONE', 'a branch with no type: NONE');
ok(Nav.decodeEvent({ roundabout: { exitNumber: 1, exitAngle: 90, driveDirection: 2, formattedDistance: fd('100', 'METER') } }).side === 'right', 'driveDirection 2 = RIGHT');
ok(Nav.decodeLanes({ rows: [{ lanes: [{ directionToFollow: 5, otherDirections: [1, 99], isHighlighted: true, additionalLaneInfo: 9 }] }] }).lanes[0].follow === 'RIGHT' &&
    Nav.decodeLanes({ rows: [{ lanes: [{ directionToFollow: 5, otherDirections: [1, 99], isHighlighted: true, additionalLaneInfo: 9 }] }] }).lanes[0].others.join() === 'STRAIGHT_ON' &&
    Nav.decodeLanes({ rows: [{ lanes: [{ directionToFollow: 5, otherDirections: [1, 99], isHighlighted: true, additionalLaneInfo: 9 }] }] }).lanes[0].info === 'BLOCKED', 'lanes with numbers: 5 = RIGHT, 1 = STRAIGHT_ON, 99 dropped, info 9 = BLOCKED');
// the wrapped form ({ maneuver: { ... } }) and conclusiveDart
ok(Nav.decodeEvents({ viewContent: [{ eventsInView: [{ maneuver: { intersection: { direction: 'SLIGHT_LEFT', formattedDistance: fd('799', 'METER') } } }] }] }).events[0].dir === 'SLIGHT_LEFT', 'events wrapped in maneuver');
ok(Nav.decodeDart({ maneuver: { pointOfInterest: {} } }) === null && Nav.decodeDart({}) === null, 'CarPlay\'s empty conclusiveDart: nothing');
ok(Nav.decodeDart({ maneuver: { intersection: { direction: 'RIGHT', formattedDistance: fd('300', 'METER') } } }).dir === 'RIGHT', 'BMW\'s own conclusiveDart');
// the log line never carries the street
const named = Nav.decodeEvent({ intersection: { direction: 'LEFT', formattedDistance: fd('450', 'METER'), description: { elements: [{ text: 'Example' }, { text: 'Street' }] } } });
ok(named.road === 'Example Street' && Nav.describe(named) === 'turn LEFT 450 m <14 chars>', 'describe(): the road as its length (' + Nav.describe(named) + ')');

// ---- every kind in the car's catalog (GuidanceEventUnion, 22 members) -------------------------------------------
{
    const ev = (kind, body) => { const e = {}; e[kind] = Object.assign({ formattedDistance: fd('500', 'METER') }, body || {}); return e; };
    const TURNS = { intersection: 'turn', branch: 'branch', roundabout: 'roundabout', destinationManeuver: 'destination', laneChange: 'lanechange', alongMainRoad: 'keep', vehicleTransportation: 'transport' };
    const MEMBERS = ['pointOfInterest', 'intersection', 'tunnel', 'branch', 'roundabout', 'destinationManeuver', 'placeholderElement', 'laneGuiding', 'trafficEvent',
        'trafficFlowItem', 'routeSegmentItem', 'laneChange', 'tollgate', 'border', 'vehicleTransportation', 'passiveManeuver', 'speedLimitAssist', 'speedCamera',
        'speedSectionCamera', 'dangerousCurve', 'schoolZone', 'alongMainRoad'];
    MEMBERS.forEach((k) => {
        const m = Nav.decodeEvent(ev(k));
        if (TURNS[k]) ok(m && m.kind === TURNS[k], k + ': a manoeuvre (' + (m && m.kind) + ')');
        else ok(m === null && Nav.SKIP[k], k + ': not a turn, skipped');
    });
    // an info event ahead of the turn doesn't hide it
    const r = Nav.decodeEvents({ viewContent: [{ eventsInView: [ev('tunnel'), ev('tollgate', { tollGateType: 'TOLL_GATE' }), ev('placeholderElement', { type: 'LOADING_INDICATOR' }),
        ev('intersection', { direction: 'RIGHT', formattedDistance: fd('900', 'METER') })] }] });
    ok(r.events.length === 1 && r.events[0].dir === 'RIGHT' && r.events[0].dist === '900', 'a tunnel, a toll gate and a placeholder ahead: the turn after them is the next turn');
    // a kind newer than the catalog, with a distance: the dot, not a guess
    ok(Nav.decodeEvent(ev('hovercraft')).kind === 'follow', 'a kind newer than the catalog: follow the route');
    // detailedGeometry carried when it says something
    ok(Nav.decodeEvent(ev('branch', { branchType: 'HIGHWAY_OUT_RIGHT', detailedGeometry: 'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_LEFT' })).geom === 'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_LEFT', 'detailedGeometry kept');
    ok(Nav.decodeEvent(ev('intersection', { direction: 'LEFT', detailedGeometry: 'UNDEFINED' })).geom === null, 'UNDEFINED geometry: none');
    // stopovers, ferries, trains
    const stop = Nav.decodeEvent(ev('destinationManeuver', { position: 'RIGHT', isCheckeredFlag: false, stopOverNumber: 2 }));
    ok(stop.flag === false && stop.stop === 2 && /stopover 2/.test(Nav.describe(stop)), 'a stopover: no flag, its number (' + Nav.describe(stop) + ')');
    ok(Nav.decodeEvent(ev('destinationManeuver', { position: 'NOT_DIGITIZED', isCheckeredFlag: true, stopOverNumber: 0 })).dir === 'NOT_DIGITIZED', 'a destination off the map');
    ok(Nav.decodeEvent(ev('vehicleTransportation', { type: 'CAR_TRAIN' })).dir === 'CAR_TRAIN' && Nav.decodeEvent(ev('vehicleTransportation', { type: 'FERRY' })).dir === 'FERRY', 'ferry and car train');
    ok(Nav.decodeEvent(ev('intersection', { direction: 'NONE' })).dir === 'NONE', 'TurnDirection NONE kept (drawn as follow the route)');
    // the catalog itself, when it's here (reference/ is git-ignored: CI skips this)
    const CAT = path.join(__dirname, '..', '..', 'reference', 'someip-interfaces.json');
    if (fs.existsSync(CAT)) {
        const D = JSON.parse(fs.readFileSync(CAT, 'utf8')).datatypes, T = (n) => D['de.bmw.infotainment.navigation.GuidingTypes.' + n];
        eq(T('GuidanceEventUnion').members.map((x) => x.name).sort(), MEMBERS.slice().sort(), 'the catalog\'s union members are the ones checked');
        eq(Object.keys(T('DestinationPosition').items).sort(), ['CENTER', 'LEFT', 'NOT_DIGITIZED', 'RIGHT'], 'destination positions');
        eq(Object.keys(T('VehicleTransportationType').items).sort(), ['CAR_TRAIN', 'FERRY'], 'transport types');
    } else console.log('(the car\'s catalog is not here: its cross-check skipped)');
}

// ---- "then": the turn close behind the next one -------------------------------------------------------------------
{
    // the drive (CarPlay): a second turn comes only when Apple Maps shows its "Then", with no distance: shown as it comes
    const two = replies.filter((r) => r.v.viewContent[0].eventsInView.length === 2);
    const T = Nav.Tracker();
    T.field('carplay', 'projectedGuidanceActive', true, 0);
    let withThen = 0;
    two.forEach((r) => { T.events(r.v, r.t); const v = T.view('route', r.t); if (v.show && v.show.then && v.show.then.gap === null) withThen++; });
    ok(two.length > 30 && withThen === two.length, 'the drive: every reply with a second turn shows "then" (' + withThen + '/' + two.length + ')');
    const one = replies.filter((r) => r.v.viewContent[0].eventsInView.length === 1)[0];
    T.events(one.v, one.t);
    ok(T.view('route', one.t).show.then === null, 'one turn only: no "then"');
    const exitThenRight = two.map((r) => Nav.decodeEvents(r.v).events).filter((e) => e[0].kind === 'branch' && e[1].dir === 'RIGHT')[0];
    ok(exitThenRight && Nav.thenOf(exitThenRight[0], exitThenRight[1]).dir === 'RIGHT', 'the motorway exit, then right');
    ok(/then turn RIGHT$/.test(Nav.describe(Object.assign({}, exitThenRight[0], { lanes: null, then: Nav.thenOf(exitThenRight[0], exitThenRight[1]) }))), 'logged: "... then turn RIGHT"');
    // with distances (BMW's own navigation): only within THEN_M of the next turn
    const ev = (dir, d, dtd) => ({ kind: 'turn', dir: dir, dist: String(d), unit: 'm', dtd: dtd, road: '' });
    ok(Nav.thenOf(ev('RIGHT', 300, 5000), ev('LEFT', 350, 4950)).gap === 50, '50 m after: "then", 50 m (from the distances to the destination)');
    ok(Nav.thenOf(ev('RIGHT', 300, null), ev('LEFT', 420, null)).gap === 120, '120 m after (from the turns\' own distances): "then"');
    ok(Nav.thenOf(ev('RIGHT', 300, 5000), ev('LEFT', 700, 4600)) === null, '400 m after: no "then"');
    ok(Nav.thenOf(ev('RIGHT', 300, 5000), ev('LEFT', 300 + Nav.THEN_M, 5000 - Nav.THEN_M)) !== null, 'exactly ' + Nav.THEN_M + ' m: still "then"');
    ok(Nav.thenOf(ev('RIGHT', 300, null), { kind: 'turn', dir: 'LEFT', dist: '2', unit: 'km', dtd: null, road: '' }) === null, 'a later turn with a distance but no gap known: no "then"');
    ok(Nav.thenOf(ev('RIGHT', 300, 5000), { kind: 'follow', dir: 'x', dist: null, unit: null, dtd: null }) === null, 'an unknown kind after: no "then"');
}

// ---- the tracker on a driven clock ---------------------------------------------------------------------------------
{
    const T = Nav.Tracker();
    const t0 = 1000000;
    ok(T.view('route', t0).show === null && !T.view('route', t0).giveWay, 'nothing running: nothing, no giving way');
    T.field('guidance', 'guidingProvider', 'CAR_PLAY', t0);
    ok(T.routing() && !T.view('route', t0 + 10000).giveWay, 'CarPlay as provider alone: routing, but never giving way on it (it may stay CAR_PLAY with no route)');
    T.field('carplay', 'projectedGuidanceActive', true, t0);
    ok(!T.view('route', t0 + 1000).giveWay, 'routing, no turn yet: wait');
    ok(T.view('route', t0 + Nav.GIVE_WAY_MS).giveWay, 'routing, no readable turn for ' + Nav.GIVE_WAY_MS + ' ms: give way to BMW');
    T.events(replies[0].v, t0 + 5000);
    const v = T.view('route', t0 + 5000);
    ok(v.show && v.show.kind === 'turn' && v.show.dist === '1' && !v.giveWay, 'a turn: shown');
    ok(T.view('off', t0 + 5000).show === null, 'Directions off: nothing');
    ok(T.view('near', t0 + 5000).show === null && !T.view('near', t0 + 5000).giveWay, '"Near turns" at 1 km: not yet, not giving way');
    T.events(replies.filter((r) => /"distance":"300","unit":"METER"/.test(JSON.stringify(r.v.viewContent[0].eventsInView[0])))[0].v, t0 + 6000);
    ok(T.view('near', t0 + 6000).show !== null, '"Near turns" at 300 m: shown');
    ok(T.view('route', t0 + 6000 + Nav.STALE_MS).show !== null, 'still fresh at ' + Nav.STALE_MS + ' ms');
    ok(T.view('route', t0 + 6001 + Nav.STALE_MS).show === null, 'stale after ' + Nav.STALE_MS + ' ms: not shown');
    ok(!T.view('route', t0 + 6001 + Nav.STALE_MS).giveWay, 'stale, but a turn only ' + (1 + Nav.STALE_MS) + ' ms ago: not giving way yet');
    ok(T.view('route', t0 + 6000 + Nav.GIVE_WAY_MS).giveWay, Nav.GIVE_WAY_MS + ' ms since the last readable turn: give way');
    // lanes ride along while fresh
    T.events(replies[0].v, t0 + 20000);
    T.field('guidance', 'currentLaneGuiding', laneRows[0].v, t0 + 20000);
    ok(T.view('route', t0 + 20500).show.lanes.lanes.length === 3, 'fresh lanes ride with the turn');
    T.events(replies[0].v, t0 + 24000);
    ok(T.view('route', t0 + 24000).show.lanes !== null, 'lanes stay with their turn (the car may send them only when they change)');
    const other = replies.filter((r) => /"direction":"RIGHT"/.test(JSON.stringify(r.v.viewContent[0].eventsInView[0])))[0].v;
    T.events(other, t0 + 24050);
    ok(T.view('route', t0 + 24050).show.lanes === null, 'a new turn after ' + Nav.STALE_MS + ' ms: the old lanes are dropped');
    T.field('guidance', 'currentLaneGuiding', { rows: [], carPositionLaneIndex: 255 }, t0 + 24100);
    ok(T.view('route', t0 + 24100).show.lanes === null, 'rows: [] clears the lanes');
    // "Near turns": lanes always show
    T.events(replies[0].v, t0 + 30000);
    T.field('guidance', 'currentLaneGuiding', laneRows[0].v, t0 + 30000);
    ok(T.view('near', t0 + 30000).show !== null, '"Near turns" far away but with lanes: shown');
    // a failed query doesn't clear a turn at once; it goes stale
    T.failed('timeout');
    ok(T.view('route', t0 + 30500).show !== null && T.error() === 'timeout', 'a failed query: the turn stays until stale');
    // the route ends: nothing old comes back
    T.field('guidance', 'guidingProvider', 'NONE', t0 + 31000);
    T.field('carplay', 'projectedGuidanceActive', false, t0 + 31000);
    ok(!T.routing() && T.view('route', t0 + 31000).show === null && !T.view('route', t0 + 31000).giveWay, 'the route ended: nothing, no giving way');
    // BMW's own navigation: conclusiveDart
    T.field('guidance', 'guidanceState', 'ACTIVE', t0 + 40000);
    T.field('guidance', 'conclusiveDart', { maneuver: { intersection: { direction: 'HARD_RIGHT', formattedDistance: fd('250', 'METER') } } }, t0 + 40000);
    const bm = T.view('route', t0 + 40500).show;
    ok(bm && bm.src === 'dart' && bm.dir === 'HARD_RIGHT', 'BMW navigation: conclusiveDart shown');
    T.events(replies[0].v, t0 + 40600);
    ok(T.view('route', t0 + 40700).show.src === 'events', 'the event list wins over conclusiveDart');
    // an error reply: the old turn goes stale, no new one
    T.events({ GuidanceEventListError: 'NOT_AVAILABLE' }, t0 + 41000);
    ok(T.view('route', t0 + 41000).show.src === 'events' && T.error() === 'NOT_AVAILABLE', 'an error reply keeps the last turn until stale');
    // CarPlay's flag alone counts as routing
    const T2 = Nav.Tracker();
    T2.field('carplay', 'projectedGuidanceActive', true, 0);
    ok(T2.routing() && T2.view('route', Nav.GIVE_WAY_MS).giveWay, 'CarPlay guidance active, nothing readable: give way');
    T2.field('carplay', 'projectedGuidanceActive', false, 5000);
    ok(!T2.routing() && !T2.view('route', 5000).giveWay, 'CarPlay guidance over: back');
}

// ---- from the 2026-11-09 bug review ------------------------------------------------------------------------------
{
    const T = Nav.Tracker(), t0 = 5000000;
    T.field('carplay', 'projectedGuidanceActive', true, t0);
    T.events(replies[0].v, t0 + 1000, t0 + 900);
    // one reply with no turn in it (lane rows only) mustn't hide the HUD at once
    T.events(replies[0].v, t0 + 8000, t0 + 7900);
    T.events({ GuidanceEventListError: 'NO_ERROR', viewContent: [{ eventsInView: [{ laneGuiding: { lanes: [] } }] }] }, t0 + 9000, t0 + 8900);
    ok(!T.view('route', t0 + 9000).giveWay, 'a route running 9 s, one reply without a turn: not giving way at once');
    // a reply asked before the route ended lands after it: dropped, no old arrow
    T.field('carplay', 'projectedGuidanceActive', false, t0 + 20000);
    const late = T.events(replies[0].v, t0 + 20300, t0 + 19800);
    ok(late.stale && T.view('route', t0 + 20300).show === null, 'a reply asked before the route ended: dropped, no old arrow');
    // the same after the provider changes
    T.field('carplay', 'projectedGuidanceActive', true, t0 + 30000);
    T.events(replies[0].v, t0 + 30500, t0 + 30400);
    T.field('guidance', 'guidingProvider', 'ANDROID_AUTO', t0 + 31000);
    ok(T.events(replies[0].v, t0 + 31200, t0 + 30900).stale && T.view('route', t0 + 31200).show === null, 'a reply asked before the provider changed: dropped');
    ok(!T.events(replies[0].v, t0 + 32200, t0 + 31900).stale && T.view('route', t0 + 32200).show !== null, 'one asked after it: shown');
}

// ---- the drive replayed: what the HUD would have shown --------------------------------------------------------
{
    const T = Nav.Tracker();
    T.field('carplay', 'projectedGuidanceActive', true, replies[0].t - 1000);
    let shown = 0, gaps = 0;
    replies.forEach((r) => {
        T.events(r.v, r.t);
        const v = T.view('route', r.t + 500);
        if (v.show) shown++;
        if (v.giveWay) gaps++;
    });
    ok(shown === replies.length && gaps === 0, 'every reply of the drive shows a turn half a second later (' + shown + '/' + replies.length + ')');
}

// ---- the probe's tap feeds the tracker -----------------------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-dir-'));
const H = {};
let reply = replies[0].v;
const signals = {
    proxy: () => Promise.resolve({ fake: true }),
    call: () => Promise.resolve(reply),
    watch(iface, inst, handlers) { H[iface.split('.').pop()] = handlers; return Promise.resolve({ available: true, shutdown() {} }); },
};
const logged = [];
const log = { info: (m) => logged.push(m), warn: (m) => logged.push(m) };
let nav = null;
const probe = NavLog.start({ signals: signals, dataDir: dir }, log, (s, f, v) => nav.tap(s, f, v));
nav = Nav.start({}, log, probe);
setTimeout(() => {
    H.CarPlayManager.projectedGuidanceActive(true);
    H.Guidance.currentLaneGuiding(laneRows[0].v);
    setTimeout(() => {
        const v = nav.view('route');
        ok(v.show && v.show.kind === 'turn' && v.show.lanes && v.show.lanes.lanes.length === 3, 'probe -> tap -> tracker: the turn with its lanes');
        reply = { GuidanceEventListError: 'NO_ERROR', viewContent: [{ eventsInView: [{ intersection: { direction: 'RIGHT', formattedDistance: fd('50', 'METER'), description: { elements: [{ text: 'Example Street' }] } } }] }] };
        setTimeout(() => {
            ok(nav.view('route').show.dir === 'RIGHT', 'the next reply replaces the turn');
            const text = fs.readFileSync(path.join(dir, 'redline-nav.log'), 'utf8');
            ok(/ nav: dir: turn LEFT 1 km <\d+ chars> lanes \*STRAIGHT_ON,\*STRAIGHT_ON,NONE/.test(text) && / nav: dir: turn RIGHT 50 m <14 chars>/.test(text), 'what shows is logged, one line per turn');
            ok(!/Example/.test(text), 'no street names in the log');
            probe.stop();
            console.log(checks + ' checks, ' + fails + ' failed');
            process.exit(fails ? 1 : 0);
        }, 1300);
    }, 1300);
}, 100);
