'use strict';
/**
 * Part of Redline's experimental features; README.md in this folder has the whole picture.
 *
 * Navigation probe: read-only, nothing is drawn yet. It records what BMW's guidance service and the CarPlay /
 * Android Auto managers send while a route runs, so Redline's own HUD directions can be built on what this car
 * really gives (hud-own-directions-plan.md, phase 1). The interfaces are the ones jaimeen77's Cluster Redline
 * reads (jaimeen77-cmyk/apps, MPL-2.0; only the interface names are taken from it, the code here is Redline's).
 *
 * Written to its own file, redline-nav.log beside redline.log (512 KiB, two files), so a long route can't push
 * the HUD's lines out of redline.log. Lines:
 *   nav: <source> <field> = <json>      every change of a field (the distance alone at most every 5 s)
 *   nav: shape <kind>: <key paths>      once per kind of manoeuvre: every key it has (to find lane data)
 *   nav: <source> available | not available | error ...
 * Keys that look like coordinates are dropped. Never throws: everything is caught and logged.
 */
const fs = require('fs');
const path = require('path');

const SOURCES = [
    { name: 'guidance', iface: 'de.bmw.infotainment.navigation.guiding.Guidance', inst: 'Main_Instance',
        fields: ['guidanceState', 'guidingProvider', 'conclusiveDart'] },
    { name: 'carplay', iface: 'de.bmw.infotainment.a4a.carplay.CarPlayManager', inst: 'CarPlayManagerInst1',
        fields: ['projectedGuidanceActive', 'projectedGuidanceMetadataAvailable'] },
    { name: 'androidauto', iface: 'de.bmw.infotainment.sdi.aap.androidautoprojectedmanager.AndroidAutoProjectedManager', inst: 'AndroidAutoProjectedManagerInst1',
        fields: ['projectedGuidanceActive', 'projectedGuidanceMetadataAvailable'] },
];
const MAX_BYTES = 512 * 1024, LINE = 3000, DIST_MS = 5000;
const COORD = /^(lat|lon|lng|latitude|longitude|wgs84|geo|coordinate|coordinates|position2d|geoPosition)$/i;

/** value without coordinate-like keys, functions or huge arrays. */
function clean(v, depth) {
    if (depth > 12) return '…';
    if (Array.isArray(v)) return v.slice(0, 40).map((x) => clean(x, depth + 1));
    if (v && typeof v === 'object') {
        const o = {};
        Object.keys(v).forEach((k) => { if (!COORD.test(k) && typeof v[k] !== 'function') o[k] = clean(v[k], depth + 1); });
        return o;
    }
    if (typeof v === 'number' && !isFinite(v)) return String(v);
    return v;
}
/** Every key path in v (arrays as []), for the shape lines. */
function paths(v, pre, out) {
    if (Array.isArray(v)) { if (v.length) paths(v[0], pre + '[]', out); else out.push(pre + '[]'); return out; }
    if (v && typeof v === 'object') { Object.keys(v).forEach((k) => paths(v[k], pre ? pre + '.' + k : k, out)); return out; }
    out.push(pre);
    return out;
}
const json = (v) => { try { const s = JSON.stringify(clean(v, 0)); return s.length > LINE ? s.slice(0, LINE) + '…(' + s.length + ' chars)' : s; } catch (e) { return '"(' + e + ')"'; } };
/** The manoeuvre's kind (the union's one key), and the value with its distance taken out (to tell a new turn from a nearer one). */
function kindOf(dart) {
    const m = dart && typeof dart === 'object' ? dart.maneuver : null;
    const k = m && typeof m === 'object' ? Object.keys(m).filter((x) => m[x] !== undefined && m[x] !== null) : [];
    return k.length === 1 ? k[0] : k.length ? k.join('+') : 'none';
}
function withoutDistance(v) {
    return JSON.stringify(v, (k, x) => (k === 'formattedDistance' || k === 'rawDistance' || k === 'distance' || k === 'timeStamp' ? undefined : x));
}

/**
 * start(ctx, log): watches the sources; returns { stop(), status() } (status: one short line, for later use on
 * the screen). log: Redline's log, for one line at start and errors.
 */
function start(ctx, log) {
    const file = path.join(ctx.dataDir || '.', 'redline-nav.log');
    const write = (msg) => {
        try {
            const st = fs.existsSync(file) ? fs.statSync(file) : null;
            if (st && st.size > MAX_BYTES) fs.renameSync(file, file + '.1');
            fs.appendFileSync(file, new Date().toISOString() + ' nav: ' + msg + '\n');
        } catch (e) { /* the log is best effort */ }
    };
    const last = {}, shapes = {}, subs = [];
    let lastDist = 0, lines = 0, latest = '';
    const got = (src, field, v) => {
        try {
            const key = src + '.' + field;
            if (field === 'conclusiveDart') {
                const kind = kindOf(v), core = withoutDistance(v);
                if (!shapes[kind]) { shapes[kind] = true; write('shape ' + kind + ': ' + paths(clean(v, 0), '', []).join(' ')); }
                // the same manoeuvre getting nearer: at most every 5 s
                if (last[key + ':core'] === core && Date.now() - lastDist < DIST_MS) return;
                last[key + ':core'] = core; lastDist = Date.now();
                latest = kind;
            }
            const s = json(v);
            if (last[key] === s) return;
            last[key] = s;
            lines++;
            write(src + ' ' + field + ' = ' + s);
        } catch (e) { write('error reading ' + src + '.' + field + ': ' + e); }
    };
    if (!ctx.signals || !ctx.signals.watch) { write('no signals here (preview)'); return { stop() {}, status: () => '' }; }
    write('probe started (' + new Date().toISOString() + ')');
    if (log) log.info('nav: probe on, writing redline-nav.log');
    SOURCES.forEach((S) => {
        const handlers = {};
        S.fields.forEach((f) => { handlers[f] = (v) => got(S.name, f, v); });
        Promise.resolve().then(() => ctx.signals.watch(S.iface, S.inst, handlers, null)).then((res) => {
            subs.push(res);
            if (res.error) { write(S.name + ' not here: ' + String(res.error).slice(0, 200)); return; }
            write(S.name + ' connected' + (res.available ? ', available' : ', waiting for the provider'));
            // availability changes, logged
            let was = res.available;
            const t = setInterval(() => { if (res.available !== was) { was = res.available; write(S.name + (was ? ' available' : ' not available')); } }, 2000);
            if (t.unref) t.unref();
            res.timer = t;
        }).catch((e) => write(S.name + ' error: ' + e));
    });
    return {
        stop() { subs.forEach((s) => { try { if (s.timer) clearInterval(s.timer); s.shutdown(); } catch (e) { /* gone */ } }); },
        status: () => (lines ? 'NAV: ' + lines + ' updates' + (latest ? ', last ' + latest : '') : ''),
    };
}

module.exports = { start, clean, paths, kindOf, SOURCES };
