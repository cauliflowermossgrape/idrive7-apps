'use strict';
/**
 * Exhaust Remote - the exhaust flap on its own, on a picture of the rear silencer (ui.js), with:
 *   - Open / Close / OEM over BMW's own 2F 60FD on the head unit's diagnostic link (DME 0x12), the same controller,
 *     adapters and link as Engine Config's Exhaust Flap tab (controller.js, adapters.js, real_adapters.js,
 *     diaglink.js: kept identical to apps/live_adjustments, test_exhaust_remote.js checks it), each command taking
 *     only its own reply. The Exhaust Flap setting ships Disarmed: simulated, nothing is sent to the car;
 *   - Drive mode (auto.js; the choice is saved with the settings, not shown in the menu): Sport -> Open,
 *     Comfort / Adaptive -> OEM, Eco Pro -> Close on every driving mode change; Open / Close / OEM stop following it;
 *   - Hold (setting, On): Open / Close sent again every 15 s (the DME hands the flap back after ~20 s);
 *   - Close: hand back above N rpm (setting, 4,000 by default): Close paused while the live engine speed is above
 *     it, resumed 500 rpm below it;
 *   - no live engine speed (armed, a limit set): a manual Close -> OEM, latched until Close is pressed again;
 *     Drive mode's Eco Pro -> OEM, paused until a live engine speed below the limit is back.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Canvas } = require('./kit/canvas');
const Car = require('./kit/car');
const UI = require('./ui');
const { Controller, REFRESH_KEYS } = require('./controller');
const { AutoFlap } = require('./auto');

const FES = 'de.bmw.infotainment.drivingexcitement.FES';

// eased valve angle toward the current state (0 = shut, 1 = open)
function targetAngle(v) {
    const s = v.confirmed !== 'UNKNOWN' ? v.confirmed : v.requested;
    if (s === 'OPEN') return 1;
    if (s === 'CLOSED') return 0;
    if (s === 'OEM') return 0.18;          // DME in control: shown slightly ajar
    return 0.5;
}

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const controller = new Controller(ctx);
        const car = new Car(ctx, ['rpm']);
        const RPM_STALE_MS = 5000; // previous RPM must have been refreshed recently
        const rpm = () => {
            const d = car.data();
            if (d.demo || !Number.isFinite(d.rpm) || d.rpm < 0 || !car.lastCar ||
                Date.now() - car.lastCar > RPM_STALE_MS) return null;
            return d.rpm;
        }; // live only, never demo or stale
        let angle = 0.18;
        let loop = null;

        const repaint = () => (loop && loop.kick ? loop.kick() : render());
        const auto = new AutoFlap({ controller, get: (k) => settings.get(k), set: (k, v) => settings.set(k, v), rpm, log, onChange: () => repaint() });
        const press = (mode) => () => { const p = auto.press(mode); repaint(); return p.then(repaint).catch((e) => log.error('action', e)); };
        const acts = { oem: press('OEM'), open: press('OPEN'), close: press('CLOSED'), drive: press('DRIVE') };

        const render = async () => {
            const v = controller.view();
            const tgt = targetAngle(v);
            angle += (tgt - angle) * 0.25;
            if (Math.abs(tgt - angle) < 0.003) angle = tgt;
            v.angle = angle;
            v.requested = auto.desired;          // the word when there is no read-back
            v.selected = auto.selected();        // the button lit: DRIVE MODE, or the mode pressed (Close stays lit while paused)
            v.note = auto.note();
            const cv = ctx.canvas(UI.W, UI.H) || new Canvas(UI.W, UI.H);
            UI.draw(cv, G, ctx.theme(), v, acts);
            await ui.image('MAIN_GFX', cv);
        };

        loop = ctx.loop('MAIN', 20, render);

        ['BTN_OPEN', 'BTN_CLOSE', 'BTN_OEM', 'BTN_DRIVE'].forEach((b) => ctx.hideButton && ctx.hideButton(b));
        ui.onClick('BTN_OPEN', acts.open);
        ui.onClick('BTN_CLOSE', acts.close);
        ui.onClick('BTN_OEM', acts.oem);
        ui.onClick('BTN_DRIVE', acts.drive);
        // the DME is looked at again for the arm switch, or (armed) while none was found yet
        const lost = () => controller.armedSetting && !(controller.ident && controller.ident.present);
        settings.onChange((key) => Promise.resolve((REFRESH_KEYS.indexOf(key) >= 0 || lost()) && controller.refresh())
            .then(() => auto.settingsChanged(key))
            .then(repaint).catch((e) => log.error('settings', e)));

        // the driving mode (notified on change), also while the app is not on screen
        ctx.signals.watch(FES, '1', {
            statusFESVehicleDynamicSwitchHMI: (v) => {
                const raw = v && v.actualValueModeDrivingExperience;
                const p = auto.driveMode(raw);
                if (p) p.then(repaint);
            },
        }, log).then((s) => log.info('drive mode ' + (s && s.error ? 'error: ' + s.error : 'subscribed')));

        // the Close rpm guard, also while the app is not on screen
        setInterval(() => { auto.tick().catch((e) => log.error('rpm', e)); }, 250);

        await controller.start();        // read-only: detect the DME + read the flap state, no actuation
        // the diagnostic link often comes up after the app started (at boot): detect again, then send what is wanted
        if (controller.link) controller.link.onAvailable((on) => controller.refresh()
            .then(() => (on ? auto.linkUp() : null)).then(repaint).catch((e) => log.error('link', e)));
        await render();
        log.info('exhaust_remote ready (source=' + controller.source + ', adapter=' + controller.adapter.name + ')');
    },
});
