'use strict';
/**
 * Night Clock - one quiet screen for driving at night: the time, large and dim, on black, and if wanted the outside
 * temperature and the speed below it. Nothing moves but the minutes (and the colon, if set), so the centre screen
 * stops lighting up the cabin.
 *
 *   - brightness of the figures in steps down to 15 % (the screen's own backlight stays as the car sets it)
 *   - 24 h or 12 h, seconds or a blinking colon, outside temperature, speed
 *   - a standby status row along the bottom (setting): outside temperature, the 12 V battery's charge and the range,
 *     small and dim, for waiting in the car without opening anything else
 * Reads only what the car sends anyway; the outside temperature as Redline reads it (EnvironmentalInformation), the
 * 12 V charge as Redline reads it (CDS statusBattery2), the range as Live Data reads it (KombiIF statusRangeTankStatus).
 */
const mgu = require('./kit/mgu');
const Car = require('./kit/car');
const G = require('./kit/gauges');

const W = 1600, H = 520;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const two = (n) => (n < 10 ? '0' : '') + n;
const hex2 = (n) => ('0' + Math.round(Math.max(0, Math.min(255, n))).toString(16)).slice(-2);
/** A colour at a share of its brightness, on black. */
const dim = (c, f) => '#' + [1, 3, 5].map((i) => hex2(parseInt(c.slice(i, i + 2), 16) * f)).join('');
const TINT = { white: '#f2f4f6', red: '#ff3b2f', amber: '#ffb000', blue: '#5aa8ff' };

/** The clock's text for a time: { hm, sec, ampm }. */
function clockText(d, h12) {
    let h = d.getHours(), ampm = '';
    if (h12) { ampm = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12; }
    return { hm: (h12 ? String(h) : two(h)) + ':' + two(d.getMinutes()), sec: two(d.getSeconds()), ampm };
}

mgu.run({
    clockText,
    async start(ctx) {
        const { ui, settings, log } = ctx;
        const outside = { v: null, t: 0 }, soc = { v: null, t: 0 }, range = { v: null, t: 0 };
        const car = new Car(ctx, ['speed'], {
            'de.bmw.infrastructure.EnvironmentalInformation': {
                ExteriorTemperature: (v) => { const raw = v && v.temperatureExterior; if (typeof raw === 'number' && raw !== 255) { outside.v = raw * 0.5 - 40; outside.t = Date.now(); } },
            },
            'de.bmw.infotainment.vehicle.CDS': {
                statusBattery2: (v) => { const c = v && v.conditionBatteryChargingCondition; if (isNum(c) && c >= 0 && c <= 100) { soc.v = c; soc.t = Date.now(); } },
            },
            'de.bmw.infotainment.KombiIF': {
                statusRangeTankStatus: (v) => { const r = v && v.range; if (isNum(r) && r >= 0 && r < 4095) { range.v = r; range.t = Date.now(); } },
            },
        });

        function render() {
            const cv = ctx.canvas(W, H).clear('#000000'), d = car.data(), now = new Date();
            const f = (settings.get('brightness') || 40) / 100, col = dim(TINT[settings.get('tint')] || TINT.white, f), sub = dim('#8d969f', f);
            const ct = clockText(now, settings.get('format') === '12');
            const secs = settings.get('seconds');
            // a blinking colon instead of seconds: only its colour fades every other second; the hours, the colon and the
            // minutes each keep a fixed place (centred on the colon, the groups as wide as '88'), so nothing jumps
            const colonOn = secs || now.getSeconds() % 2 === 0;
            const bottom = G.pageBottom(cv);
            const mid = Math.round((44 + bottom) / 2);
            const size = 230, x = W / 2, opt = { font: 'light' };
            const parts = ct.hm.split(':'), cw = cv.textWidth(':', size, opt), gw = cv.textWidth('88', size, opt);
            const hx = x - cw / 2 - cv.textWidth(parts[0], size, opt), mx = x + cw / 2;
            cv.text(parts[0], hx, mid + 60, size, col, opt);
            cv.text(':', x - cw / 2, mid + 60, size, colonOn ? col : dim(TINT[settings.get('tint')] || TINT.white, f * 0.18), opt);
            cv.text(parts[1], mx, mid + 60, size, col, opt);
            const w = 2 * (cw / 2 + gw);
            if (secs) cv.text(ct.sec, x + w / 2 + 16, mid + 60, 70, sub, { font: 'light' });
            if (ct.ampm) cv.text(ct.ampm, x + w / 2 + 16, mid - 30, 40, sub, { font: 'bold' });
            const line = [];
            if (settings.get('outside') && isNum(outside.v) && Date.now() - outside.t < 600000) {
                const c = outside.v, fv = settings.get('tempUnit') === 'f';
                line.push(Math.round(fv ? c * 9 / 5 + 32 : c) + (fv ? ' °F' : ' °C'));
            }
            if (settings.get('speed') && isNum(d.speed)) line.push(Math.round(settings.get('speedUnit') === 'mph' ? d.speed / 1.609344 : d.speed) + (settings.get('speedUnit') === 'mph' ? ' mph' : ' km/h'));
            if (line.length) cv.text(line.join('     '), x, mid + 140, 40, sub, { align: 'center', font: 'light' });
            if (settings.get('status')) statusRow(cv, f, bottom, d.demo);
            if (d.demo && settings.get('speed')) cv.text('DEMO', W - 40, H - 30, 18, dim('#8d969f', 0.5), { align: 'right', font: 'bold' });
            return ui.image('MAIN_GFX', cv);
        }
        /* The standby row: three quiet readings along the bottom, each at a fixed place, '--' while the car has not
           said (never a guess); the demo shows made-up ones. */
        function statusRow(cv, f, bottom, demo) {
            const fresh = (x) => isNum(x.v) && Date.now() - x.t < 600000;
            const fv = settings.get('tempUnit') === 'f', mi = settings.get('speedUnit') === 'mph';
            const o = demo ? 4 : fresh(outside) ? outside.v : null, b = demo ? 82 : fresh(soc) ? soc.v : null, r = demo ? 412 : fresh(range) ? range.v : null;
            const items = [
                ['OUTSIDE', isNum(o) ? Math.round(fv ? o * 9 / 5 + 32 : o) + (fv ? ' °F' : ' °C') : '--'],
                ['12 V BATTERY', isNum(b) ? Math.round(b) + ' %' : '--', isNum(b) && b < 60],
                ['RANGE', isNum(r) ? Math.round(mi ? r / 1.609344 : r) + (mi ? ' mi' : ' km') : '--', isNum(r) && r < 60],
            ];
            const y = bottom - 26, lab = dim('#8d969f', Math.min(1, f * 1.1)), val = dim('#c9d0d6', Math.min(1, f * 1.15)), warn = dim(TINT.amber, f);
            cv.fillRect(W / 2 - 520, y - 46, 1040, 1, dim('#8d969f', f * 0.35));
            items.forEach((it, i) => {
                const cx = W / 2 + (i - 1) * 360;
                cv.text(it[0], cx, y - 22, 15, lab, { align: 'center', font: 'bold', spacing: 2 });
                cv.text(it[1], cx, y + 8, 28, it[2] ? warn : val, { align: 'center', font: 'light' });
            });
        }
        // the figures change once a second (the minutes, the seconds or the colon): 2 frames a second is plenty
        ctx.loop('MAIN', 2, render);
        render().then(() => log.info('first frame done')).catch((e) => log.warn('first render: ' + e));
    },
});
