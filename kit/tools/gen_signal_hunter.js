'use strict';
/**
 * gen_signal_hunter.js - the fields Live Data's Signal Hunter tab listens to: every status field ("rs" or "s") an app in
 * apps/ already declares (Live Data's own included), so the hunter listens to exactly what the apps here are known to
 * receive, nothing guessed. Left out: interfaces declared with "_instances" (they need an instance of their own, not
 * "1") and anything that is a method, a broadcast or a write ("w"). The hunter only reads; it never calls or sets.
 *
 *   node kit/tools/gen_signal_hunter.js            write apps/live_data/hunter_fields.js, and add to Live Data's app.json
 *                                                  "signals" the fields other apps declare that Live Data does not (an
 *                                                  interface new to Live Data is marked "_optional": a car without it
 *                                                  still installs; Live Data's own entries are never changed or removed)
 *   node kit/tools/gen_signal_hunter.js --check    (CI) checks Live Data's own files only: exit 1 only when
 *                                                  hunter_fields.js is missing or lists a field Live Data's app.json does
 *                                                  not declare. What other apps do (a field one adds, or drops while the
 *                                                  hunter still lists it) is only reported as a warning (exit 0), so a PR
 *                                                  on another app never turns CI red here
 * hunter_fields.js: { fields: { <interface>: [field, ...] }, added: ['<interface>.<field>', ...] } - the list as a module
 * the app requires at run time (build.py ships an app's .js files, not its app.json "signals"), and which of Live Data's
 * declarations exist only for the hunter (so a later run can tell them from Live Data's own).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SELF = 'live_data';
const OPTIONAL = 'read-only listening for the Signal Hunter tab (Settings > Advanced): a car without it just shows less';

const statusFlags = (flags) => (String(flags).indexOf('s') < 0 ? null : String(flags).indexOf('r') >= 0 ? 'rs' : 's');

/** Status fields per interface of spec.signals, and the interfaces it reaches through an instance of their own. */
function statusOf(spec) {
    const out = {}, skip = new Set();
    for (const iface of Object.keys(spec.signals || {})) {
        const fields = spec.signals[iface];
        if (!fields || typeof fields !== 'object') continue;
        if (fields._instances) { skip.add(iface); continue; }
        for (const k of Object.keys(fields)) {
            if (k.startsWith('_')) continue;
            const f = statusFlags(fields[k]);
            if (f) (out[iface] = out[iface] || {})[k] = f;
        }
    }
    return { out, skip };
}

/** The other apps' status fields: { iface: { field: flags } }, and every interface some app reaches by instance. */
function others() {
    const all = {}, skip = new Set();
    const apps = fs.readdirSync(path.join(ROOT, 'apps')).filter((d) => d !== SELF).sort();
    for (const id of apps) {
        let spec;
        try { spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', id, 'app.json'), 'utf8')); } catch (e) { continue; }
        const s = statusOf(spec);
        s.skip.forEach((i) => skip.add(i));
        Object.keys(s.out).forEach((i) => Object.keys(s.out[i]).forEach((k) => { (all[i] = all[i] || {})[k] = s.out[i][k]; }));
    }
    return { all, skip };
}

const keysOf = (sig) => {
    const out = [];
    Object.keys(sig || {}).forEach((i) => Object.keys(sig[i] || {}).forEach((k) => { if (!k.startsWith('_')) out.push(i + '.' + k); }));
    return out.sort();
};
const listKeys = (fields) => {
    const out = [];
    Object.keys(fields || {}).forEach((i) => (fields[i] || []).forEach((k) => out.push(i + '.' + k)));
    return out.sort();
};

/**
 * plan(ld, prev): what to write. ld = Live Data's app.json, prev = the current hunter_fields.js (or null).
 * Live Data's own fields = its declared status fields minus those only the hunter added (prev.added).
 * Returns { signals (Live Data's new "signals"), fields, added }.
 */
function plan(ld, prev) {
    const o = others(), added0 = new Set((prev && prev.added) || []);
    const signals = JSON.parse(JSON.stringify(ld.signals || {}));
    // drop what only the hunter added and no other app declares any more
    added0.forEach((key) => {
        const i = key.slice(0, key.lastIndexOf('.')), k = key.slice(key.lastIndexOf('.') + 1);
        if (!(o.all[i] && o.all[i][k]) && signals[i]) {
            delete signals[i][k];
            if (!Object.keys(signals[i]).some((x) => !x.startsWith('_'))) delete signals[i];
        }
    });
    const added = [];
    Object.keys(o.all).sort().forEach((i) => {
        if (o.skip.has(i)) return;
        Object.keys(o.all[i]).sort().forEach((k) => {
            if (signals[i] && signals[i]._instances) return;
            if (signals[i] && signals[i][k] !== undefined) {
                if (added0.has(i + '.' + k)) added.push(i + '.' + k);
                return;
            }
            if (!signals[i]) signals[i] = { _optional: OPTIONAL };
            signals[i][k] = o.all[i][k];
            added.push(i + '.' + k);
        });
    });
    const fields = {};
    const merged = statusOf({ signals }).out;
    Object.keys(merged).sort().forEach((i) => {
        if (o.skip.has(i)) return;
        fields[i] = Object.keys(merged[i]).sort();
    });
    return { signals, fields, added: added.sort() };
}

function fieldsJs(fields, added) {
    return "'use strict';\n// hunter_fields.js - written by kit/tools/gen_signal_hunter.js (do not edit): every status field the Signal Hunter\n"
        + "// tab listens to, per interface, read only; added: the ones Live Data's app.json declares only for the hunter.\n"
        + 'module.exports = ' + JSON.stringify({ fields, added }, null, 1) + ';\n';
}

/** text with its top-level "signals" block replaced (the rest of app.json keeps its own layout). */
function replaceSignals(text, signals) {
    const at = text.indexOf('"signals": {');
    if (at < 0) throw new Error('no "signals" block in apps/live_data/app.json');
    let i = text.indexOf('{', at), depth = 0, inStr = false;
    for (; i < text.length; i++) {
        const c = text[i];
        if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (!depth) break; }
    }
    const block = JSON.stringify(signals, null, 2).split('\n').map((l, n) => (n ? '  ' + l : l)).join('\n');
    return text.slice(0, text.indexOf('{', at)) + block + text.slice(i + 1);
}

function count(fields) { return Object.keys(fields).reduce((n, i) => n + fields[i].length, 0); }

/**
 * check(ld, listed): what --check reports. problems (fail), Live Data's own files only: hunter_fields.js missing; a
 * listed field Live Data's app.json does not declare. Warnings only (other apps): added, declared by another app and not
 * listed yet; gone, added for the hunter but no other app declares it any more (Live Data still declares it, marked
 * _optional, so it still installs and runs).
 */
function check(ld, listed) {
    const problems = [];
    if (!listed || !listed.fields) return { problems: ['apps/live_data/hunter_fields.js is missing or does not load: run node kit/tools/gen_signal_hunter.js'], added: [], gone: [] };
    const declared = new Set(keysOf(statusOf(ld).out)), list = listKeys(listed.fields), have = new Set(list);
    const undeclared = list.filter((k) => !declared.has(k));
    if (undeclared.length) problems.push(undeclared.length + ' listed field(s) Live Data\'s app.json does not declare (' + undeclared.slice(0, 5).join(', ') + '): run node kit/tools/gen_signal_hunter.js');
    const o = others();
    const gone = (listed.added || []).filter((key) => { const i = key.slice(0, key.lastIndexOf('.')), k = key.slice(key.lastIndexOf('.') + 1); return !(o.all[i] && o.all[i][k]); }).sort();
    const want = [];
    Object.keys(o.all).forEach((i) => { if (!o.skip.has(i)) Object.keys(o.all[i]).forEach((k) => want.push(i + '.' + k)); });
    return { problems, added: want.filter((k) => !have.has(k)).sort(), gone };
}

if (require.main === module) {
    const file = path.join(ROOT, 'apps', SELF, 'app.json');
    const ffile = path.join(ROOT, 'apps', SELF, 'hunter_fields.js');
    const text = fs.readFileSync(file, 'utf8'), ld = JSON.parse(text);
    let prev = null;
    try { delete require.cache[ffile]; prev = require(ffile); } catch (e) { /* first run */ }
    if (process.argv.includes('--check')) {
        const r = check(ld, prev);
        r.problems.forEach((m) => console.log('FAIL ' + m));
        const some = (l) => l.slice(0, 5).join(', ') + (l.length > 5 ? ', ...' : '');
        if (r.added.length) console.log('warning: ' + r.added.length + ' new field(s) not yet listed (' + some(r.added) + '): run node kit/tools/gen_signal_hunter.js');
        if (r.gone.length) console.log('warning: ' + r.gone.length + ' field(s) added for the hunter that no other app declares any more (' + some(r.gone) + '): run node kit/tools/gen_signal_hunter.js');
        if (!r.problems.length) console.log('Signal Hunter fields consistent: ' + count(prev.fields) + ' fields on ' + Object.keys(prev.fields).length + ' interfaces');
        process.exit(r.problems.length ? 1 : 0);
    }
    const p = plan(ld, prev);
    fs.writeFileSync(file, replaceSignals(text, p.signals));
    fs.writeFileSync(ffile, fieldsJs(p.fields, p.added));
    console.log('wrote ' + count(p.fields) + ' fields on ' + Object.keys(p.fields).length + ' interfaces (' + p.added.length + ' added to Live Data\'s app.json for the hunter)');
}

module.exports = { others, plan, check, fieldsJs, count, statusOf, replaceSignals };
