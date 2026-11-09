'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Redline's own directions on the HUD, the data side (hud-own-directions-plan.md, phase 2): what BMW's guidance
 * service says about the next turn and the lanes, decoded into one small object the HUD draws (hud-nav.js).
 *
 * Where it comes from (proven on a G21 with CarPlay / Apple Maps, 2026-11-09, Redline 1.16.5 probe):
 *   - GuidanceEventList.queryContent (navlog.js asks it while a route runs): viewContent[0].eventsInView[], each a
 *     union keyed by its kind (intersection, branch, roundabout, destinationManeuver, ...). The first is the next
 *     turn; a second one, when there, is the turn after it (its distance unit NONE).
 *   - Guidance.currentLaneGuiding and ProjectedModeGuiding.currentLaneGuiding (the same rows, ~1 Hz while lanes
 *     apply; rows: [] when none).
 *   - Guidance.conclusiveDart, the same union under .maneuver: BMW's own navigation (CarPlay leaves it empty).
 *   - Whether a route runs: Guidance.guidanceState / guidingProvider, CarPlay's and Android Auto's
 *     projectedGuidanceActive (guidanceState stays INACTIVE during CarPlay routes).
 * The interfaces are the ones jaimeen77's Cluster Redline reads (jaimeen77-cmyk/apps, MPL-2.0); none of its code
 * is used here, the decoder is Redline's own, written from the replies this car sent.
 *
 * The object (null when there's nothing to show):
 *   { kind, dir, geom, exit, exitAngle, side, flag, stop, dist: '450', unit: 'm', road, lanes, unreliable, t, src }
 *   kind: 'turn' (dir: TurnDirection: STRAIGHT_ON, LEFT, SLIGHT_LEFT, HARD_LEFT, UTURN_LEFT, the right ones, NONE),
 *         'branch' (dir: BranchType: BRANCH_LEFT, FORK_RIGHT, TRIPLE_FORK_STRAIGHT, HIGHWAY_OUT_RIGHT, OVERPASS...),
 *           both with geom: detailedGeometry (ManeuverGeometry: EXIT_RIGHT_TAKE_LEFT, THREE_WAY_FORK_TAKE_CENTER...)
 *           when the car gives one (null for UNDEFINED, the only value seen yet),
 *         'roundabout' (exit: the exit's number, exitAngle as the car gives it, side: the traffic side 'left' / 'right'),
 *         'keep' (dir LEFT / RIGHT: along the main road), 'lanechange' (dir LEFT / RIGHT),
 *         'destination' (dir: LEFT / CENTER / RIGHT / NOT_DIGITIZED; flag false: a stopover, stop its number),
 *         'transport' (dir FERRY / CAR_TRAIN: onto a ferry or a car train),
 *         'follow' (a kind not in the car's catalog: "follow the route")
 *   Not turns, skipped, so they never stand in for the next turn: points of interest, lane rows, traffic, route
 *   segments, tunnels, borders, toll gates, passive manoeuvres (straight through), speed cameras and limits,
 *   dangerous curves, school zones, placeholders (GAP / LOADING_INDICATOR).
 *   dist, unit: as the car formats them ('1' 'km', '450' 'm'); null when it gives none
 *   lanes: { lanes: [{ follow, others: [], hi, info }], rec, markers } or null
 *
 * Safety: a turn older than STALE_MS isn't shown. While a route runs and Redline has no turn it can read (for
 * GIVE_WAY_MS), view() says to give way, so the driver gets BMW's own card rather than nothing.
 * Never throws: everything is caught. Street names never go to a log (their length only).
 */

const STALE_MS = 3000;       // a turn or lanes older than this aren't shown
const GIVE_WAY_MS = 4000;    // routing without a readable turn this long: BMW's own card instead
const NEAR_M = 1000;         // "Near turns": under this ("1 km" is not yet; lanes always)

const UNITS = { KM: 'km', METER: 'm', MILE_UK: 'mi', MILE_US: 'mi', YARD: 'yd', FEET: 'ft' };
const UNIT_M = { km: 1000, m: 1, mi: 1609.344, yd: 0.9144, ft: 0.3048 };

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : typeof v === 'number' && isFinite(v) ? String(v) : null);

/*
 * The enums that decide an arrow, from the car's catalog (navigation.GuidingTypes, CommonTypes.DistanceUnit):
 * index = the number a firmware might send instead of the name. A value that is neither a name nor one of these
 * numbers gives no direction (the "follow the route" dot), never a guessed arrow.
 */
const ENUMS = {
    TurnDirection: ['NONE', 'STRAIGHT_ON', 'LEFT', 'SLIGHT_LEFT', 'HARD_LEFT', 'RIGHT', 'SLIGHT_RIGHT', 'HARD_RIGHT', 'UTURN_RIGHT', 'UTURN_LEFT'],
    BranchType: [null, 'BRANCH_LEFT', 'BRANCH_RIGHT', 'HIGHWAY_IN_LEFT', 'HIGHWAY_IN_RIGHT', 'HIGHWAY_IN_STRAIGHT', 'HIGHWAY_OUT_LEFT', 'HIGHWAY_OUT_RIGHT',
        'HIGHWAY_OUT_STRAIGHT', 'FORK_LEFT', 'FORK_RIGHT', 'TRIPLE_FORK_LEFT', 'TRIPLE_FORK_RIGHT', 'TRIPLE_FORK_STRAIGHT', 'OVERPASS', 'UNDERPASS'],
    Side: [null, 'LEFT', 'RIGHT'],
    DestinationPosition: [null, 'LEFT', 'CENTER', 'RIGHT', 'NOT_DIGITIZED'],
    MainRoadDirection: ['LEFT', 'RIGHT'],
    VehicleTransportationType: ['FERRY', 'CAR_TRAIN'],
    AdditionalLaneInfo: ['NONE', 'ELLIPSIS', 'BUS', 'HOV', 'SCOOTER', 'BIKE', 'TOLL_ETC', 'TOLL_CASH', 'TOLL_ETC_CASH', 'BLOCKED'],
    LaneMarker: [null, 'SOLID', 'DASHED'],
    DistanceUnit: ['NONE', 'KM', 'MILE_UK', 'MILE_US', 'METER', 'YARD', 'FEET'],
};
/** An enum value as its catalog name, or null (not a name or number of that enum). */
function enumOf(type, v) {
    const names = ENUMS[type];
    if (typeof v === 'string') return names.indexOf(v) >= 0 ? v : null;
    if (typeof v === 'number' && v >= 0 && v < names.length && v === Math.floor(v)) return names[v];
    return null;
}

/** The union's kind and its body: { kind, body } for { intersection: {...} } (null / undefined members ignored). */
function unionOf(e) {
    if (!isObj(e)) return null;
    const keys = Object.keys(e).filter((k) => isObj(e[k]));
    if (keys.length !== 1) return null;
    return { kind: keys[0], body: e[keys[0]] };
}

/** The street (or exit) name: the description's text pieces joined. '' when none. */
function roadOf(b) {
    const els = b && b.description && Array.isArray(b.description.elements) ? b.description.elements : [];
    return els.map((x) => (x && typeof x.text === 'string' ? x.text : '')).filter((s) => s).join(' ').trim();
}

/** formattedDistance as the car gives it: { dist: '450', unit: 'm' }; unit NONE (or unknown): no distance. */
function distOf(b) {
    const f = b && b.formattedDistance;
    const d = f ? str(f.distance) : null, u = f ? UNITS[enumOf('DistanceUnit', f.unit) || ''] : null;
    if (!d || !u || !/\d/.test(d)) return { dist: null, unit: null };
    return { dist: d.trim(), unit: u };
}

/** About how far, in metres, from the car's own text ('0,5' km = 500 m); null if it can't be read. */
function metres(m) {
    if (!m || !m.dist || !m.unit) return null;
    // "1,234" (thousands) is 1234, "1,5" (a decimal comma) is 1.5
    const t = String(m.dist).trim(), v = parseFloat(/^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.'));
    return isFinite(v) ? v * UNIT_M[m.unit] : null;
}

/*
 * Union members (GuidanceEventUnion, 22 in the car's catalog) that aren't a manoeuvre: skipped. Most aren't asked
 * for (eventQuery's includedTypes), but if one comes it mustn't hide the turn after it.
 */
const SKIP = { pointOfInterest: 1, laneGuiding: 1, trafficEvent: 1, trafficFlowItem: 1, routeSegmentItem: 1, placeholderElement: 1,
    tunnel: 1, border: 1, tollgate: 1, passiveManeuver: 1, speedLimitAssist: 1, speedLimit: 1, speedCamera: 1, speedSectionCamera: 1,
    dangerousCurve: 1, schoolZone: 1 };
/** detailedGeometry when it says something (not UNDEFINED / NONE / missing). */
function geomOf(b) { const g = str(b.detailedGeometry); return g && g !== 'UNDEFINED' && g !== 'NONE' ? g : null; }


/**
 * One route event (an eventsInView item, or conclusiveDart.maneuver) as Redline's object, without t / src / lanes.
 * null for kinds that aren't a manoeuvre (lane rows, points of interest, empty).
 */
function decodeEvent(e) {
    const u = unionOf(e);
    if (!u) return null;
    const b = u.body, d = distOf(b);
    if (SKIP[u.kind]) return null;
    const m = { kind: null, dir: null, geom: null, exit: null, exitAngle: null, side: null, flag: null, stop: null, dist: d.dist, unit: d.unit, road: roadOf(b), unreliable: b.unreliable === true };
    switch (u.kind) {
    case 'intersection':
        m.kind = 'turn'; m.dir = enumOf('TurnDirection', b.direction) || 'NONE'; m.geom = geomOf(b);
        break;
    case 'branch':
        m.kind = 'branch'; m.dir = enumOf('BranchType', b.branchType) || 'NONE'; m.geom = geomOf(b);
        break;
    case 'roundabout': {
        m.kind = 'roundabout';
        const n = Number(b.exitNumber), a = Number(b.exitAngle);
        m.exit = isFinite(n) && n > 0 ? Math.round(n) : null;
        m.exitAngle = isFinite(a) ? ((a % 360) + 360) % 360 : null;
        // driveDirection: the traffic side (LEFT: drive on the left, clockwise roundabouts; seen: LEFT on the drive, in
        // Australia, with a lane for right turns and U-turns). exitAngle: degrees clockwise from straight on (hud-nav.js)
        // missing or unknown: left (the only side seen on a car yet; the arrow still points at the exit's angle)
        m.side = enumOf('Side', b.driveDirection) === 'RIGHT' ? 'right' : 'left';
        break;
    }
    case 'alongMainRoad':
        m.kind = 'keep'; m.dir = enumOf('MainRoadDirection', b.mainRoadDirection) || 'NONE';
        break;
    case 'laneChange':
        m.kind = 'lanechange'; m.dir = enumOf('Side', b.changeSide) || 'NONE';
        break;
    case 'destinationManeuver':
        m.kind = 'destination'; m.dir = enumOf('DestinationPosition', b.position) || 'CENTER';
        // a stopover on the way: isCheckeredFlag false (the drive's destination: true)
        m.flag = b.isCheckeredFlag !== false;
        m.stop = isFinite(Number(b.stopOverNumber)) && Number(b.stopOverNumber) > 0 ? Math.round(Number(b.stopOverNumber)) : null;
        break;
    case 'vehicleTransportation':
        m.kind = 'transport'; m.dir = enumOf('VehicleTransportationType', b.type) || 'FERRY';
        break;
    default:
        // a kind newer than the catalog: shown as "follow the route" (a dot) if it has a distance, logged by kind
        if (!b.formattedDistance) return null;
        m.kind = 'follow'; m.dir = u.kind;
    }
    return m;
}

/**
 * A queryContent reply: { ok, error, events: [decoded...], raw: number of events }. ok false: an error reply or no
 * view (the turn isn't known; not the same as "no turns ahead").
 */
function decodeEvents(reply) {
    const out = { ok: false, error: null, events: [], raw: 0 };
    if (!isObj(reply)) { out.error = 'no reply'; return out; }
    const err = reply.GuidanceEventListError;
    if (err !== undefined && err !== 'NO_ERROR' && err !== 0) { out.error = String(err); return out; }
    const v = Array.isArray(reply.viewContent) ? reply.viewContent[0] : null;
    const evs = v && Array.isArray(v.eventsInView) ? v.eventsInView : null;
    if (!evs) { out.error = 'no view'; return out; }
    out.ok = true; out.raw = evs.length;
    evs.forEach((e) => { const m = decodeEvent(e && isObj(e.maneuver) ? e.maneuver : e); if (m) out.events.push(m); });
    return out;
}

/** The kinds in a reply (the union keys), for the log. */
function kindsOf(reply) {
    const v = isObj(reply) && Array.isArray(reply.viewContent) ? reply.viewContent[0] : null;
    const evs = v && Array.isArray(v.eventsInView) ? v.eventsInView : [];
    return evs.map((e) => { const u = unionOf(e && isObj(e.maneuver) ? e.maneuver : e); return u ? u.kind : '?'; });
}

/** Guidance.conclusiveDart: its manoeuvre, or null (CarPlay leaves it at an empty pointOfInterest). */
function decodeDart(v) {
    return isObj(v) && isObj(v.maneuver) ? decodeEvent(v.maneuver) : null;
}

/**
 * currentLaneGuiding: { lanes: [{ follow, others, hi, info }], rec, markers } for the first row, or null (no rows).
 *   follow: the arrow to take in that lane (NONE: none, the lane isn't for this route), others: its other arrows,
 *   hi: highlighted (a lane to be in), info: additionalLaneInfo (NONE, bus, HOV...), rec: the recommended lane's
 *   index, markers: the lines between lanes (DASHED / SOLID), one more than lanes.
 */
function decodeLanes(v) {
    const row = isObj(v) && Array.isArray(v.rows) ? v.rows[0] : null;
    if (!isObj(row) || !Array.isArray(row.lanes) || !row.lanes.length) return null;
    const lanes = row.lanes.slice(0, 12).map((l) => {
        l = isObj(l) ? l : {};
        // the arrows to take: directionsToFollow (a lane can be for straight on and right), else directionToFollow
        const list = (a) => (Array.isArray(a) ? a : []).map((x) => enumOf('TurnDirection', x)).filter((s) => s && s !== 'NONE');
        let follows = list(l.directionsToFollow);
        const one = enumOf('TurnDirection', l.directionToFollow) || 'NONE';
        if (one !== 'NONE' && follows.indexOf(one) < 0) follows = [one].concat(follows);
        const others = list(l.otherDirections).filter((s) => follows.indexOf(s) < 0);
        return { follow: follows[0] || 'NONE', follows: follows, others: others, hi: l.isHighlighted === true, info: enumOf('AdditionalLaneInfo', l.additionalLaneInfo) || 'NONE' };
    });
    const rec = Number(row.recommendedCarPositionLaneIndex);
    return {
        lanes: lanes,
        rec: isFinite(rec) && rec >= 0 && rec < lanes.length ? rec : null,
        markers: Array.isArray(row.laneMarkers) ? row.laneMarkers.map((x) => enumOf('LaneMarker', x)) : [],
    };
}

/** A route for certain: BMW's guidance active, or the phone's (CarPlay / Android Auto) guiding. */
function routeSure(r) { return r.state === 'ACTIVE' || r.state === 2 || r.carplay === true || r.aa === true; }
/** True while some navigation runs: BMW's own, or the phone's (CarPlay / Android Auto). */
function routingOf(r) {
    return r.state === 'ACTIVE' || r.state === 2 || r.carplay === true || r.aa === true ||
        (r.provider !== null && r.provider !== undefined && r.provider !== 'NONE' && r.provider !== 0);
}

/** One short log line for a manoeuvre, without the street (its length only). */
function describe(m) {
    if (!m) return 'none';
    const what = m.kind === 'roundabout' ? 'roundabout exit ' + m.exit + ' at ' + m.exitAngle + ' (' + m.side + ')'
        : m.kind + ' ' + m.dir + (m.geom ? ' ' + m.geom : '') + (m.kind === 'destination' && m.flag === false ? ' stopover ' + (m.stop || '?') : '');
    return what + ' ' + (m.dist ? m.dist + ' ' + m.unit : '-') + (m.road ? ' <' + m.road.length + ' chars>' : '') +
        (m.lanes ? ' lanes ' + m.lanes.lanes.map((l) => (l.hi ? '*' : '') + l.follow).join(',') : '') + (m.unreliable ? ' unreliable' : '');
}

/**
 * The state behind the HUD's directions: fed the values as they come (with the time), asked for what to show.
 * now() is a parameter everywhere so the tests can drive the clock.
 */
function Tracker() {
    const route = { state: null, provider: null, carplay: false, aa: false, since: null, resetAt: -Infinity };
    let turn = null, turnAt = 0, dart = null, dartAt = 0, lanes = null, lanesAt = 0, lastErr = null;
    // the last time a turn could be read (giving way counts from it); the current turn's identity and since when
    let lastTurnAt = -Infinity, turnKey = '', turnSince = 0;
    const keyOf = (m) => (m ? [m.kind, m.dir, m.geom, m.exit, m.exitAngle, m.road].join('|') : '');
    const seen = (m, now) => {
        if (!m) return;
        lastTurnAt = now;
        const k = keyOf(m);
        if (k !== turnKey) { turnKey = k; turnSince = now; }
    };
    const self = {
        /** A field of one of the sources (navlog.js's names): guidance / phone / carplay / androidauto. */
        field(src, name, v, now) {
            const was = routingOf(route);
            if (src === 'guidance' && name === 'guidanceState') route.state = v;
            else if (src === 'guidance' && name === 'guidingProvider') route.provider = v;
            else if (name === 'projectedGuidanceActive') route[src === 'carplay' ? 'carplay' : 'aa'] = v === true;
            else if (name === 'conclusiveDart') { dart = decodeDart(v); dartAt = now; seen(dart, now); }
            else if (name === 'currentLaneGuiding') { lanes = decodeLanes(v); lanesAt = now; }
            const is = routingOf(route);
            if (is && !was) route.since = now;
            // a route ended or changed hands: nothing old comes back, nor a reply asked for before it
            if ((was && !is) || (src === 'guidance' && name === 'guidingProvider')) {
                turn = null; dart = null; lanes = null; turnKey = ''; route.resetAt = now;
                if (!is) route.since = null;
            }
        },
        /**
         * A queryContent reply; askedAt: when it was asked. One asked before the route ended or changed hands
         * (a 900 ms query in flight) is dropped: it would put the old route's arrow back.
         */
        events(reply, now, askedAt) {
            if (typeof askedAt === 'number' && askedAt <= route.resetAt) return { ok: false, error: 'from before the route changed', events: [], raw: 0, stale: true };
            const r = decodeEvents(reply);
            if (!r.ok) { lastErr = r.error; return r; }
            lastErr = null;
            turn = r.events[0] || null; turnAt = now;
            seen(turn, now);
            return r;
        },
        /** The query failed (timeout, refused): the old turn just goes stale. */
        failed(err) { lastErr = String(err); },
        routing: () => routingOf(route),
        /** The next turn, with lanes when fresh, or null. Phone turns first, then BMW's own. */
        current(now) {
            let m = turn && now - turnAt <= STALE_MS ? turn : dart && now - dartAt <= STALE_MS ? dart : null;
            if (!m) return null;
            // lanes: fresh, or sent since this turn began (the car may only send them when they change: standing at
            // the lights they'd go stale otherwise); rows: [], the route ending or a new turn clear them
            const fresh = lanes && (now - lanesAt <= STALE_MS || (lanesAt >= turnSince && keyOf(m) === turnKey)) ? lanes : null;
            m = Object.assign({}, m, { lanes: fresh, t: m === turn ? turnAt : dartAt, src: m === turn ? 'events' : 'dart' });
            return m;
        },
        /**
         * What the HUD does: { show: object | null, giveWay }. mode: 'off' | 'route' | 'near'.
         * giveWay: a route runs but no turn could be read for GIVE_WAY_MS: BMW's card instead of Redline.
         */
        view(mode, now) {
            if (mode === 'off') return { show: null, giveWay: false };
            if (!routingOf(route)) return { show: null, giveWay: false };
            const m = self.current(now);
            // give way only on a route for certain, and only after GIVE_WAY_MS with no readable turn (from the route's
            // start or the last turn, whichever is later: one reply without a turn mustn't hide the whole HUD)
            if (!m) return { show: null, giveWay: routeSure(route) && route.since !== null && now - Math.max(route.since, lastTurnAt) >= GIVE_WAY_MS };
            if (mode === 'near') {
                const d = metres(m);
                if (!m.lanes && (d === null || d >= NEAR_M)) return { show: null, giveWay: false };
            }
            return { show: m, giveWay: false };
        },
        error: () => lastErr,
    };
    return self;
}

/**
 * start(ctx, log, probe): the tracker, fed by the navigation probe (navlog.js's tap), and a line in redline-nav.log
 * for each change of what would show. Returns { tap, view(mode), routing() }.
 */
function start(ctx, log, probe) {
    const T = Tracker();
    let lastLine = '', lastGive = false;
    const note = (s) => { if (probe && probe.write) probe.write(s); };
    const tap = (src, name, v, askedAt) => {
        try {
            const now = Date.now();
            if (src === 'events') {
                if (name === 'reply') {
                    const r = T.events(v, now, askedAt);
                    if (r.stale) return;
                    if (!r.ok) note('dir: event list ' + r.error);
                    else if (r.raw && !r.events.length) note('dir: no turn in ' + kindsOf(v).join(','));
                } else if (name === 'error') T.failed(v);
                return;
            }
            T.field(src, name, v, now);
        } catch (e) { note('dir: error ' + e); }
    };
    return {
        tap: tap,
        view(mode) {
            try {
                const v = T.view(mode, Date.now());
                const line = v.show ? describe(v.show) : v.giveWay ? 'giving way to BMW (no turn data)' : 'none';
                // the distance counting down isn't a new line: what changed apart from it
                const core = line.replace(/ [\d.,]+ (km|m|mi|yd|ft)\b/, '');
                if (core !== lastLine) { lastLine = core; note('dir: ' + line); }
                if (v.giveWay !== lastGive) { lastGive = v.giveWay; if (log) log.info('hud: ' + (v.giveWay ? 'route without readable turns, BMW\'s directions shown' : 'own directions')); }
                return v;
            } catch (e) { return { show: null, giveWay: false }; }
        },
        routing: () => T.routing(),
    };
}

module.exports = { start, SKIP, ENUMS, enumOf, routeSure, Tracker, decodeEvent, decodeEvents, decodeLanes, decodeDart, kindsOf, metres, describe, routingOf, STALE_MS, GIVE_WAY_MS, NEAR_M };
