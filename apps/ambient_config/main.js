'use strict';
/**
 * Ambient config - the ambient light's colour, set here or by the driving mode.
 *
 *   - the colour now, and BMW's colours by number to set one by hand
 *   - a colour for each driving mode the car has (Sport, Comfort, Eco Pro, Adaptive; on a plug-in hybrid Sport,
 *     Hybrid, Hybrid Eco Pro, Electric), set when the mode changes; "Leave as is" gives the driver's own colour back
 *
 * It runs from the platform's start (app.json "autostart"), so the driving modes work with the app closed.
 * ambient.js has the rules.
 */
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { withAlpha } = require('./kit/canvas');
const { Ambient, MODES, SLOTS } = require('./ambient');

const W = 1600, H = 520;
const MODE_NAMES = { sport: 'Sport', comfort: 'Comfort', eco: 'Eco Pro', adaptive: 'Adaptive', hybrid: 'Hybrid', hybridEco: 'Hybrid Eco Pro', electric: 'Electric' };

async function background(bg) {
    const ambient = new Ambient({ settings: bg.settings, signals: bg.signals, log: bg.log });
    bg.settings.onChange((key) => { if (key === 'follow' || MODES.indexOf(key) >= 0) ambient.follow(); });
    await ambient.start();
    return ambient;
}

mgu.run({
    background,
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const ambient = ctx.background || await background(ctx);
        const colourName = (n) => (n ? 'Colour ' + n : '--');
        const step = (key, d) => {
            const v = (Number(settings.get(key)) || 0) + d;
            settings.set(key, v < 0 ? SLOTS : v > SLOTS ? 0 : v);
            return render();
        };

        function drawColour(cv, t) {
            G.panel(cv, t, 24, 44, 760, 468, 'Colour');
            const now = ambient.slot();
            cv.text(colourName(now), 48, 150, 56, now ? t.text : t.dim, { font: 'bold' });
            const mode = ambient.mode();
            cv.text('Your own: ' + colourName(ambient.own()) + (mode ? '   ·   Driving mode: ' + MODE_NAMES[mode] : ''), 48, 190, 22, t.dim);
            for (let i = 0; i < SLOTS; i++) {
                const n = i + 1, x = 48 + (i % 6) * 118, y = 220 + Math.floor(i / 6) * 70;
                G.button(cv, t, x, y, 106, 56, String(n), () => { ambient.setSlot(n); return render(); }, { primary: n === now, busy: !ambient.available, key: 'slot-' + n });
            }
            const note = !ambient.available ? 'The car\'s ambient light does not answer' : ambient.error ? 'Not set: ' + ambient.error
                : 'Numbers as in BMW\'s own menu, Ambient light → Colour';
            cv.text(note, 48, 400 + G.pageBottom(cv) - G.BOTTOM, 20, ambient.available && !ambient.error ? t.dim : t.warn);
        }

        function drawModes(cv, t) {
            G.panel(cv, t, 804, 44, 772, 468, 'By driving mode');
            const follow = !!settings.get('follow'), mode = ambient.mode();
            ambient.modes().forEach((m, i) => {
                const y = 100 + i * 66, v = Number(settings.get(m)) || 0;
                if (m === mode) cv.roundRect(820, y - 6, 740, 60, 10, withAlpha(t.accent, 0.14));
                cv.text(MODE_NAMES[m], 840, y + 32, 26, follow ? t.text : t.dim, { font: 'bold' });
                G.button(cv, t, 1100, y, 64, 48, '-', () => step(m, -1), { key: m + '-' });
                cv.text(v ? colourName(v) : 'Leave as is', 1272, y + 32, 24, v ? t.text : t.dim, { align: 'center' });
                G.button(cv, t, 1380, y, 64, 48, '+', () => step(m, 1), { key: m + '+' });
            });
            const y = 380 + G.pageBottom(cv) - G.BOTTOM;
            let x = 840;
            x += G.button(cv, t, x, y, 0, 48, follow ? 'Following driving mode' : 'Not following', () => { settings.set('follow', !follow); return render(); },
                { primary: follow, key: 'follow' }) + 16;
            const restore = settings.get('restore') !== false;
            G.button(cv, t, x, y, 0, 48, restore ? 'Leave as is: my colour back' : 'Leave as is: no change', () => { settings.set('restore', !restore); return render(); },
                { primary: restore, key: 'restore' });
        }

        async function render() {
            const t = ctx.theme(), cv = ctx.canvas(W, H).clear(t.bg);
            drawColour(cv, t);
            drawModes(cv, t);
            G.frame(cv, t, ['Ambient config'], 0, []);
            await ui.image('MAIN_GFX', cv);
        }

        ambient.on('change', () => render().catch((e) => log.warn('render: ' + e)));
        settings.onChange(() => render().catch(() => {}));
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
