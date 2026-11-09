'use strict';
// Redline's navigation probe (apps/redline/navlog.js): what it writes to redline-nav.log for the guidance
// service's values, with stand-in signals. Node 8 compatible.
const fs = require('fs'), os = require('os'), path = require('path');
const NavLog = require(path.join(__dirname, '..', '..', 'apps', 'redline', 'navlog'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redline-nav-'));
    const H = {};
    const signals = {
        watch(iface, inst, handlers) {
            if (/AndroidAuto/.test(iface)) return Promise.resolve({ error: 'no SOME/IP config for ' + iface, available: false, shutdown() {} });
            H[iface.split('.').pop()] = handlers;
            return Promise.resolve({ available: true, shutdown() {} });
        },
    };
    const logged = [];
    const p = NavLog.start({ signals: signals, dataDir: dir }, { info: (m) => logged.push(m), warn: (m) => logged.push(m) });
    await sleep(50);
    const dart = (dist, dir2) => ({ timeStamp: { date: {}, time: {} }, position: { latitude: 37.5, longitude: 127.0 },
        maneuver: { intersection: { direction: dir2 || 'LEFT', formattedDistance: { distance: String(dist), unit: 'METER', rawDistance: dist }, lanes: [{ arrows: ['LEFT'], recommended: true }] } } });
    H.Guidance.guidanceState('ACTIVE');
    H.Guidance.guidingProvider('CAR_PLAY');
    H.CarPlayManager.projectedGuidanceActive(true);
    H.Guidance.conclusiveDart(dart(400));
    H.Guidance.conclusiveDart(dart(380));            // nearer, same turn, within 5 s: not logged
    H.Guidance.conclusiveDart(dart(380, 'RIGHT'));   // a new turn: logged at once
    H.Guidance.guidanceState('ACTIVE');              // the same value again: not logged
    H.Guidance.currentLaneGuiding({ rows: [{ lanes: [{ directionToFollow: 'LEFT', isHighlighted: true }, { directionToFollow: 'STRAIGHT_ON', isHighlighted: false }] }], carPositionLaneIndex: 1 });
    H.ProjectedModeGuiding.currentLaneGuiding({ rows: [], carPositionLaneIndex: 0 });
    const text = fs.readFileSync(path.join(dir, 'redline-nav.log'), 'utf8');
    const lines = text.trim().split('\n');
    ok(/probe started/.test(lines[0]), 'the probe says it started');
    ok(/guidance connected, available/.test(text) && /carplay connected/.test(text), 'the sources it reached are logged');
    ok(/androidauto not here: no SOME\/IP config/.test(text), 'a source the car lacks is logged, not fatal');
    ok(/guidance guidanceState = "ACTIVE"/.test(text) && /guidance guidingProvider = "CAR_PLAY"/.test(text) && /carplay projectedGuidanceActive = true/.test(text), 'each field logged with its value');
    ok((text.match(/guidanceState = /g) || []).length === 1, 'a repeated value is logged once');
    const shape = lines.filter((l) => / shape intersection: /.test(l));
    ok(shape.length === 1 && /maneuver\.intersection\.lanes\[\]\.arrows\[\]/.test(shape[0]) && /maneuver\.intersection\.formattedDistance\.unit/.test(shape[0]), 'the manoeuvre\'s shape once, every key path (lanes would show)');
    const darts = lines.filter((l) => /conclusiveDart = /.test(l));
    ok(darts.length === 2 && /"distance":"400"/.test(darts[0]) && /RIGHT/.test(darts[1]), 'the same turn nearer is held back for 5 s, a new turn logged at once (' + darts.length + ')');
    ok(!/latitude|longitude|37\.5|127/.test(text), 'no coordinates in the log');
    ok(/guidance currentLaneGuiding = .*"directionToFollow":"LEFT"/.test(text) && /phone currentLaneGuiding = /.test(text), 'lanes logged, from BMW and the phone');
    ok(logged.some((m) => /probe on/.test(m)), 'one line in redline.log');
    ok(/NAV: \d+ updates, last intersection/.test(p.status()), 'status: ' + p.status());
    // no signals (the preview): nothing breaks
    const q = NavLog.start({ dataDir: dir }, null);
    ok(q.status() === '', 'no signals: a quiet stub');
    p.stop();
    console.log('redline nav probe: ' + checks + ' checks, ' + fails + ' failed');
    process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL ' + (e.stack || e)); process.exit(1); });
