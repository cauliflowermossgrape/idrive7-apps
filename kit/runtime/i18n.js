'use strict';
// Local display translation only. Never use this on signal names, IDs or stored settings.
const locale = require('./locale.json');
const available = locale.languages || [locale.language || 'en'];
const dict = {};
const cache = new Map();
let language = 'en', localizedValues = new Set(), folded = Object.create(null), pattern = /$^/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function getLanguage() { return language; }
function setLanguage(value) {
    language = available.indexOf(value) >= 0 ? value : available[0];
    const strings = language === 'en' ? {} : require('./locales/' + language + '.json');
    Object.keys(dict).forEach((key) => { delete dict[key]; });
    Object.assign(dict, strings);
    localizedValues = new Set(Object.values(dict));
    folded = Object.create(null);
    Object.keys(dict).forEach((key) => { folded[key.toLowerCase()] = dict[key]; });
    const phrases = Object.keys(dict).filter((s) => s.length >= 4).sort((a, b) => b.length - a.length);
    pattern = phrases.length ? new RegExp('(^|[^A-Za-z0-9_./])(' + phrases.map(escape).join('|') + ')(?=$|[^A-Za-z0-9_./])', 'gi') : /$^/;
    cache.clear();
    return language;
}
function t(value) {
    const s = String(value == null ? '' : value);
    if (language === 'en') return s;
    if (!/[A-Za-z]/.test(s)) return s; // numeric telemetry / already translated labels: hot path
    if (s.trim() === 'rpm') return s; // preserve the physical unit; uppercase RPM headings may translate
    if (cache.has(s)) return cache.get(s);
    const key = s.trim();
    if (localizedValues.has(key)) return s;
    let out;
    if (Object.prototype.hasOwnProperty.call(dict, key)) {
        out = s.slice(0, s.indexOf(key)) + dict[key] + s.slice(s.indexOf(key) + key.length);
    } else if (Object.prototype.hasOwnProperty.call(folded, key.toLowerCase())) {
        out = s.slice(0, s.indexOf(key)) + folded[key.toLowerCase()] + s.slice(s.indexOf(key) + key.length);
    } else {
        // Short words need context: "min 70" is a minimum, "12 min" is minutes.
        out = language === 'zh-CN' ? s.replace(/\bmin(?=\s+-?\d)/g, '最小').replace(/\bmax(?=\s+-?\d)/g, '最大')
            .replace(/\bAVG(?=\s+[+-]?\d)/g, '平均').replace(/\bACC\b/g, '加速') :
            language === 'ru' ? s.replace(/\bmin(?=\s+-?\d)/g, 'мин.').replace(/\bmax(?=\s+-?\d)/g, 'макс.')
                .replace(/\bAVG(?=\s+[+-]?\d)/g, 'СРЕД.').replace(/\bACC\b/g, 'РАЗГОН') : s;
        out = out.replace(pattern, (_, before, word) => before + (dict[word] || folded[word.toLowerCase()]));
    }
    if (cache.size >= 2048) cache.clear();
    cache.set(s, out);
    return out;
}
setLanguage(locale.language || available[0]);
module.exports = { t, dict, getLanguage, setLanguage };
