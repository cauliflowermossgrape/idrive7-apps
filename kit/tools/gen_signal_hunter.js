'use strict';
/**
 * gen_signal_hunter.js - writes Signal Hunter's "signals" block: every status field ("rs" or "s") that another app in
 * apps/ already declares, so the hunter listens to exactly what the apps here are known to receive, nothing guessed.
 * Left out: interfaces declared with "_instances" (they need an instance of their own, not "1") and anything that is
 * a method, a broadcast or a write ("w"). Signal Hunter itself only reads; it never calls or sets anything.
 *
 *   node kit/tools/gen_signal_hunter.js            rewrite apps/signal_hunter/app.json "signals"
 *   node kit/tools/gen_signal_hunter.js --check    exit 1 when app.json is not what this would write (CI)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SELF = 'signal_hunter';
const OPTIONAL = 'read-only listening: Signal Hunter shows what this sends; a car without it just shows less';

function collect() {
    const ifaces = {};
    const skip = new Set();
    const apps = fs.readdirSync(path.join(ROOT, 'apps')).filter((d) => d !== SELF).sort();
    for (const id of apps) {
        let spec;
        try { spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', id, 'app.json'), 'utf8')); } catch (e) { continue; }
        for (const iface of Object.keys(spec.signals || {})) {
            const fields = spec.signals[iface];
            if (!fields || typeof fields !== 'object') continue;
            // an interface some app reaches through its own instance: not on instance "1", leave it out everywhere
            if (fields._instances) { skip.add(iface); continue; }
            for (const k of Object.keys(fields)) {
                if (k.startsWith('_')) continue;
                const flags = String(fields[k]);
                if (flags.indexOf('s') < 0) continue;          // status fields only (notified); "w" and "r"-only left out
                (ifaces[iface] = ifaces[iface] || {})[k] = flags.indexOf('r') >= 0 ? 'rs' : 's';
            }
        }
    }
    skip.forEach((i) => { delete ifaces[i]; });
    const out = {};
    Object.keys(ifaces).sort().forEach((i) => {
        out[i] = { _optional: OPTIONAL };
        Object.keys(ifaces[i]).sort().forEach((k) => { out[i][k] = ifaces[i][k]; });
    });
    return out;
}

function count(sig) {
    let n = 0;
    Object.keys(sig).forEach((i) => { n += Object.keys(sig[i]).filter((k) => !k.startsWith('_')).length; });
    return n;
}

if (require.main === module) {
    const file = path.join(ROOT, 'apps', SELF, 'app.json');
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    const want = collect();
    const n = count(want), ni = Object.keys(want).length;
    if (process.argv.includes('--check')) {
        const same = JSON.stringify(spec.signals || {}) === JSON.stringify(want);
        console.log(same ? 'signal_hunter signals up to date: ' + n + ' fields on ' + ni + ' interfaces'
            : 'FAIL apps/signal_hunter/app.json "signals" is out of date: run node kit/tools/gen_signal_hunter.js');
        process.exit(same ? 0 : 1);
    }
    spec.signals = want;
    fs.writeFileSync(file, JSON.stringify(spec, null, 2) + '\n');
    console.log('wrote ' + n + ' fields on ' + ni + ' interfaces');
}

module.exports = { collect, count };
