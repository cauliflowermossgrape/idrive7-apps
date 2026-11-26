'use strict';
/**
 * own_items.js - Service's own intervals ("My intervals") and their arithmetic: which items there are, the setting that holds each one's
 * interval, and how far each is from due given the odometer (km) and the date of its last service.
 *
 *   ITEMS                      [{ key, name, setting, unit: 'km' | 'months' }]
 *   status(item, every, done, odo, now) -> { off, left, frac, state: 'ok' | 'soon' | 'due' | 'unknown' }
 *       every = the interval (km or months; 0 = off), done = { km, at } of the last service or null
 *       left = km (or days) still to go (negative: overdue), frac = share of the interval used (0..1+)
 *       soon = within SOON_KM (or SOON_DAYS)
 */
const ITEMS = [
    { key: 'oil', name: 'Engine oil', setting: 'oilKm', unit: 'km' },
    { key: 'plugs', name: 'Spark plugs', setting: 'plugsKm', unit: 'km' },
    { key: 'gearbox', name: 'Gearbox oil', setting: 'gearboxKm', unit: 'km' },
    { key: 'padsFront', name: 'Brake pads front', setting: 'padsFrontKm', unit: 'km' },
    { key: 'padsRear', name: 'Brake pads rear', setting: 'padsRearKm', unit: 'km' },
    { key: 'airFilter', name: 'Air filter', setting: 'airFilterKm', unit: 'km' },
    { key: 'cabinFilter', name: 'Cabin filter', setting: 'cabinFilterKm', unit: 'km' },
    { key: 'brakeFluid', name: 'Brake fluid', setting: 'brakeFluidMonths', unit: 'months' },
];
const SOON_KM = 1000, SOON_DAYS = 30, DAY = 86400000, MONTH_DAYS = 30.44;
const isNum = (v) => typeof v === 'number' && isFinite(v);

function status(item, every, done, odo, now) {
    if (!(every > 0)) return { off: true, state: 'off' };
    if (!done) return { off: false, state: 'unknown', left: null, frac: null };
    if (item.unit === 'months') {
        const days = every * MONTH_DAYS, used = (now - done.at) / DAY, left = Math.round(days - used);
        return { off: false, left, frac: used / days, state: left <= 0 ? 'due' : left <= SOON_DAYS ? 'soon' : 'ok' };
    }
    if (!isNum(odo) || !isNum(done.km)) return { off: false, state: 'unknown', left: null, frac: null };
    const used = odo - done.km, left = Math.round(every - used);
    return { off: false, left, frac: used / every, state: left <= 0 ? 'due' : left <= SOON_KM ? 'soon' : 'ok' };
}

module.exports = { ITEMS, status, SOON_KM, SOON_DAYS };
