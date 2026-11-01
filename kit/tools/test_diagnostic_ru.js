'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const stage = path.resolve(process.argv[2] || 'dist/dtc_scanner/source/javascript');
const { diagnosticText } = require(path.join(stage, 'diagnostic-text'));
const i18n = require(path.join(stage, 'kit/i18n'));
const locale = require(path.join(stage, 'kit/locale.json'));
assert((locale.languages || [locale.language]).includes('ru'), 'Russian is not in this build');
i18n.setLanguage('ru');
const source = 'Brake light switch (BLS): wire break or short circuit to battery voltage';
const expected = i18n.dict[source];
assert(expected && expected.includes('Датчик'));
assert.strictEqual(diagnosticText(source), expected);
assert.strictEqual(diagnosticText('Uncatalogued ACC circuit 0xABCDEF'), 'Uncatalogued ACC circuit 0xABCDEF');
assert.strictEqual(diagnosticText('2 possible texts (depends on unit type)'), '2 возможных описания (зависит от типа блока)');
assert.strictEqual(diagnosticText('5 possible texts (depends on unit type)'), '5 возможных описаний (зависит от типа блока)');
assert.strictEqual(diagnosticText('11 possible texts (depends on unit type)'), '11 возможных описаний (зависит от типа блока)');
assert.strictEqual(diagnosticText('21 possible texts (depends on unit type)'), '21 возможное описание (зависит от типа блока)');
const db = require(path.join(stage, 'kit/pack')).open(path.join(stage, 'diagnostic_i18n'));
const translations = db.json('ru.json');
assert(Object.keys(translations).length >= 86);
const hexValues = (text) => {
    const ascii = text.replace(/х/g, 'x').replace(/[Аа]/g, 'A').replace(/[Вв]/g, 'B')
        .replace(/[Сс]/g, 'C').replace(/[Ее]/g, 'E');
    return (ascii.match(/0x[0-9A-Fa-f]+/g) || []).map((hex) => parseInt(hex.slice(2), 16));
};
for (const [src, dst] of Object.entries(translations)) {
    const translated = hexValues(dst);
    for (const hex of hexValues(src)) assert(translated.includes(hex), 'Hex ID lost: ' + src);
}
const atlas = JSON.parse(fs.readFileSync(path.join(stage, 'kit/fonts/cyrillic.json'), 'utf8')).sizes[0];
assert(atlas.atlasH <= 2048);
for (const text of Object.values(translations)) for (const ch of text) {
    if (ch.codePointAt(0) > 127) assert(atlas.glyphs[ch.codePointAt(0)], 'Missing glyph ' + ch);
}
i18n.setLanguage('en');
assert.strictEqual(diagnosticText(source), source);
assert.strictEqual(diagnosticText('5 possible texts (depends on unit type)'), '5 possible texts (depends on unit type)');
console.log('PASS ru: catalog lookup, plural forms, unknown fallback, English restoration, hex IDs and Cyrillic glyphs; ' +
    Object.keys(translations).length + ' catalog entries');
