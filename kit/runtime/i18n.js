'use strict';
// Local display translation only. Never use this on signal names, IDs or stored settings.
const locale = require('./locale.json');
const dict = locale.strings || {};
const language = locale.language || 'en';
const localizedValues = new Set(Object.values(dict));
const cache = new Map();
function getLanguage() { return language; }
// Plural forms live in the locale catalogs: "fault|faults<TAB>ошибка|ошибки|ошибок".
// The key is the English text for 1 and for many, exactly as English shows it (both the same
// when English does not change, e.g. "items|items"). Without a row the English form is returned
// and the drawn line goes through t() as before, so catalogs without plural rows (zh-CN) render unchanged.
// The rule picks the form index; Node 8 on the car has no Intl.PluralRules.
const PLURAL_RULES = {
    en: (n) => (n === 1 ? 0 : 1),
    ru: (n) => { // one | few | many
        const mod100 = Math.abs(n) % 100, mod10 = mod100 % 10;
        if (mod100 >= 11 && mod100 <= 14) return 2;
        if (mod10 === 1) return 0;
        return mod10 >= 2 && mod10 <= 4 ? 1 : 2;
    },
    'zh-CN': () => 0,
};
function plural(n, one, other, lang) {
    const key = one + '|' + other, lng = lang || language;
    const translated = lng !== 'en' && Object.prototype.hasOwnProperty.call(dict, key) && (!lang || lang === language);
    if (!translated) return n === 1 ? one : other;
    const forms = dict[key].split('|'), rule = PLURAL_RULES[lng] || PLURAL_RULES.en;
    return forms[Math.min(rule(n), forms.length - 1)];
}
const folded = Object.create(null);
Object.keys(dict).forEach((key) => { folded[key.toLowerCase()] = dict[key]; });
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrases = Object.keys(dict).filter((s) => s.length >= 4 && s.indexOf('|') < 0).sort((a, b) => b.length - a.length);
const pattern = new RegExp('(^|[^A-Za-z0-9_./])(' + phrases.map(escape).join('|') + ')(?=$|[^A-Za-z0-9_./])', 'gi');
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
module.exports = { t, plural, PLURAL_RULES, dict, getLanguage };
