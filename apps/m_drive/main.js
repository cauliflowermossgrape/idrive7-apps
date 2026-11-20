'use strict';
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Controller } = require('./controller');
const { TuneControl } = require('./tune');
const { AutoFlap } = require('./auto');
const { Lane } = require('./lane');
const { Telemetry } = require('./telemetry');
const M = require('./model');
const UI = require('./ui');

// Drive mode is never followed here: the driving mode must not move the flap
const FLAP = { driveLink: 'off', hold: 'on', closeLimit: String(M.CLOSE_LIMIT) };
const VIN = /"vin":"[^"]*"/g;

function withoutVin(log) {
    const out = {};
    ['error', 'warn', 'info', 'debug'].forEach((level) => {
        out[level] = function () {
            const args = Array.prototype.map.call(arguments, (x) => (typeof x === 'string' ? x.replace(VIN, '"vin":"-"') : x));
            (log[level] || log.info).apply(log, args);
        };
    });
    return out;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const telemetry = new Telemetry(ctx);
        let ready = false, loop = null, phase = null, session = null, pollTimer = null, polling = false;
        let flapQueue = Promise.resolve();

        const mode = () => M.transportMode(telemetry.demo(), settings.get('controls'));
        const visible = () => ui.isVisible('MAIN');
        const linkUp = () => ready && !!(controller.link && controller.link.available);
        const lane = new Lane((job, sid, data) => M.blockReason(sid, data, job ? job.gen : -1,
            { mode: mode(), gen: lane.gen, visible: visible(), link: linkUp(), rpm: telemetry.rpm() }));
        const armed = () => ready && mode() === 'live';
        const shared = {
            get: (k) => (k === 'arm' ? (armed() ? 'on' : 'off') : k === 'tuner' ? (armed() ? 'mhd' : 'off') : settings.get(k)),
            set() {},
            onChange() {},
        };
        const controller = new Controller({ log: withoutVin(log), signals: lane.signals(ctx.signals), settings: shared, spec: ctx.spec });
        const repaint = () => { if (loop) loop.kick(); };

        // a session lives for one phase (mode, link, screen shown): the next phase revokes its flap commands and
        // hold, so nothing asked for before a change goes after it
        const sessionFor = (gen) => {
            const s = { flap: {}, preview: {}, last: null };
            const current = () => lane.gen === gen;
            s.tune = new TuneControl({ log, settings: shared, spec: ctx.spec }, { rpm: () => telemetry.rpm() });
            if (controller.link) {
                const link = controller.link;
                s.tune.start({
                    diag: link.diag,
                    get available() { return current() && link.available; },
                    sendToDme(sid, data) {
                        if (!current()) return Promise.reject(new Error('Not sent · M Drive changed state before it could go'));
                        return link.sendToDme(sid, data);
                    },
                }).then(repaint).catch((e) => log.error('tune start', e));
            }
            const port = {
                get armedSetting() { return current() && controller.armedSetting; },
                setMode(m) {
                    if (m !== s.flap.accepted) s.flap = { accepted: s.flap.accepted, sending: m };
                    flapQueue = flapQueue.then(() => (current() ? controller.setMode(m) : null)).then(() => {
                        if (!current()) return;
                        const v = controller.view();
                        s.flap = v.accepted ? { accepted: m }
                            : { accepted: s.flap.accepted, error: String(v.error || 'no answer from the DME').replace(/^real control blocked: /, '') };
                        repaint();
                    }).catch((e) => log.error('flap', e));
                    return flapQueue;
                },
            };
            s.auto = new AutoFlap({ controller: port, get: (k) => FLAP[k], rpm: () => telemetry.rpm(), log, onChange: repaint });
            return s;
        };
        session = sessionFor(lane.gen);

        const press = (id) => {
            const a = M.ACTION[id], m = mode(), s = session;
            s.last = { group: a.group, note: null };
            log.info('press ' + id + ' (' + m + ')');
            if (m === 'demo') s.preview[a.group] = a.value;
            else if (m === 'live' && !linkUp()) s.last.note = M.NOTE.link;
            else if (m === 'live') {
                const run = a.group === 'map' ? s.tune.setMap(a.value) : a.group === 'cooling' ? s.tune.setCooling(a.value === 'ON') : s.auto.press(a.value);
                Promise.resolve(run).then(repaint).catch((e) => log.error('press ' + id, e));
            }
            repaint();
        };
        const acts = {};
        M.ACTIONS.forEach((a) => { acts[a.id] = () => press(a.id); });

        const view = () => {
            const m = mode();
            return {
                mode: m,
                link: linkUp(),
                telemetry: telemetry.snapshot(),
                commands: M.commandView({ mode: m, tune: session.tune.view(), flap: session.flap, flapNote: session.auto.note(), preview: session.preview,
                    last: session.last, rpm: telemetry.rpm() }),
            };
        };
        const render = async () => {
            const cv = ctx.canvas(UI.W, UI.H);
            UI.draw(cv, G, ctx.theme(), view(), acts);
            await ui.image('MAIN_GFX', cv);
        };

        const poll = async () => {
            pollTimer = null;
            if (!visible() || telemetry.demo() || !linkUp()) return;
            polling = true;
            try { await telemetry.poll(controller.link.diag); } catch (e) { log.warn('poll: ' + e); }
            polling = false;
            pollSoon(1000);
        };
        const pollSoon = (ms) => { if (!pollTimer && !polling) pollTimer = setTimeout(poll, ms || 0); };

        const reconcile = () => {
            if (!ready) return;
            const next = { mode: mode(), link: linkUp(), visible: visible() };
            const prev = phase;
            if (prev && prev.mode === next.mode && prev.link === next.link && prev.visible === next.visible) return;
            phase = next;
            lane.gen++;
            session = sessionFor(lane.gen);
            if (next.visible && (!prev || !prev.visible || prev.mode !== next.mode || prev.link !== next.link)) {
                flapQueue = flapQueue.then(() => controller.refresh()).then(repaint).catch((e) => log.error('refresh', e));
            }
            if (next.visible) pollSoon();
            log.info('phase ' + next.mode + (next.link ? ', link up' : ', no link') + (next.visible ? ', shown' : ', hidden'));
            repaint();
        };

        loop = ctx.loop('MAIN', 10, render);
        M.ACTIONS.forEach((a) => {
            ctx.hideButton(a.button);
            ui.onClick(a.button, acts[a.id]);
        });
        ctx.onTab(repaint);

        await controller.start();
        if (controller.link) {
            lane.wrap(controller.link.diag);
            controller.link.onAvailable(reconcile);
        }
        ready = true;
        telemetry.onSwitch(reconcile);
        ui.onVisible((name) => { if (name === 'MAIN') reconcile(); });
        settings.onChange(() => { reconcile(); repaint(); });
        setInterval(() => {
            reconcile();
            session.auto.tick().catch((e) => log.error('rpm guard', e));
        }, 250);
        reconcile();
        log.info('m_drive ready');
    },
});
