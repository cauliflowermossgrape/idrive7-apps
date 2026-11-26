'use strict';
/**
 * kit_harness.js - mgu.js's real run() on the PC, for tests of what the kit does at start (safe boot, Stop all): the
 * kit copied into a temp app folder (source/javascript/kit, data/) as on the car, oap-sdk a stand-in whose
 * OnlineApp has no screens (rhmiApplication null: a start in the background, as autostart does it).
 *
 *   const h = harness({ id: 'test', settings: [...] });
 *   const ctx = await h.start({ background(bg) { ... } });   // a fresh process each time (the kit's modules reloaded)
 *   h.dataDir                                               // the app's data folder (kept between starts)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const KIT = path.join(__dirname, '..', 'runtime');

// (no mkdirSync recursive: the car's Node 8 has none, and the node8 job runs this too)
function mkdirp(d) { if (!fs.existsSync(d)) { mkdirp(path.dirname(d)); fs.mkdirSync(d); } }
function copyDir(from, to) {
    mkdirp(to);
    fs.readdirSync(from).forEach((n) => {
        const a = path.join(from, n), b = path.join(to, n);
        if (fs.statSync(a).isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
    });
}

function harness(spec) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-harness-'));
    const kit = path.join(root, 'source', 'javascript', 'kit');
    copyDir(KIT, kit);
    fs.writeFileSync(path.join(kit, 'app-spec.json'), JSON.stringify(Object.assign({ id: 'test', title: 'Test', version: '1.0.0', screens: [], settings: [] }, spec)));
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir);
    // the SDK stand-in: no screens, every call answered
    const sdk = path.join(root, 'node_modules', 'oap-sdk');
    mkdirp(sdk);
    fs.writeFileSync(path.join(sdk, 'index.js'), [
        "const EventEmitter = require('events');",
        'class OnlineApp extends EventEmitter {',
        '    constructor() { super(); this.rhmiApplication = null; this.startReason = "TEST"; }',
        '    async start() {} async registerActive() {} async initialized() {} async registerHmiVisible() {} async unregisterHmiVisible() {}',
        '}',
        'const quiet = { info() {}, warn() {}, error() {}, debug() {} };',
        'module.exports = { OnlineApp, logging: { getSDKLogger: () => quiet } };',
    ].join('\n'));
    const h = {
        root, kit, dataDir,
        /** mgu.run(impl) in a fresh copy of the kit's modules; resolves once its start is through */
        async start(impl) {
            Object.keys(require.cache).forEach((k) => { if (k.indexOf(root) === 0) delete require.cache[k]; });
            const mgu = require(path.join(kit, 'mgu.js'));
            return mgu.run(impl);
        },
        log() { try { return fs.readFileSync(path.join(dataDir, (spec.id || 'test') + '.log'), 'utf8'); } catch (e) { return ''; } },
    };
    return h;
}

module.exports = { harness, mkdirp };
