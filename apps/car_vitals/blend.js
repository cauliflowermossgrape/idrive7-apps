'use strict';
/**
 * blend.js - the ethanol blend calculator (M Vitals' Fuel mix page, issue #203): how much E85 and how much pump fuel
 * to put in to reach a target ethanol share, from what is in the tank now. No car data needed but the fuel level
 * (the cluster's, in litres) when there is one.
 *
 *   blend({ tank, now, nowE, target, e85, pump, fill })
 *     tank    the tank's size, l
 *     now     fuel in the tank now, l
 *     nowE    its ethanol share now, % (the last mix, or 10 for E10)
 *     target  the share wanted, %
 *     e85     the ethanol share of the station's E85, % (often 70 - 85, lower in winter)
 *     pump    the ethanol share of the pump fuel, % (10 for E10, 5 for E5, 0)
 *     fill    litres to put in (default: up to full)
 *   -> { e85L, pumpL, result, fill, ok, why }
 *     e85L / pumpL   litres of each to put in (rounded to 0.1 l)
 *     result         the share the tank ends at, % (the target when it can be reached, else the nearest)
 *     ok             the target can be reached with this fill; why says why not
 */

const r1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function blend(o) {
    const tank = Number(o.tank), now = clamp(Number(o.now) || 0, 0, tank), nowE = Number(o.nowE) || 0;
    const target = Number(o.target), e85 = Number(o.e85), pump = Number(o.pump) || 0;
    const room = tank - now;
    const fill = clamp(o.fill === undefined || o.fill === null ? room : Number(o.fill), 0, room);
    if (!(tank > 0) || !(e85 > pump)) return { e85L: 0, pumpL: 0, result: nowE, fill: 0, ok: false, why: 'check the settings' };
    if (fill <= 0) return { e85L: 0, pumpL: 0, result: r1(nowE), fill: 0, ok: Math.abs(nowE - target) < 0.5, why: 'the tank is full' };
    const total = now + fill;
    // now * nowE + x * e85 + (fill - x) * pump = total * target
    const x = (total * target - now * nowE - fill * pump) / (e85 - pump);
    const e85L = clamp(x, 0, fill), pumpL = fill - e85L;
    const result = (now * nowE + e85L * e85 + pumpL * pump) / total;
    const ok = x >= -0.05 && x <= fill + 0.05;
    const why = ok ? null : x < 0 ? 'too much ethanol in the tank: pump fuel only gets ' + Math.round(result) + ' %'
        : 'not enough room: E85 only gets ' + Math.round(result) + ' %';
    return { e85L: r1(e85L), pumpL: r1(pumpL), result: r1(result), fill: r1(fill), ok, why };
}

module.exports = { blend };
