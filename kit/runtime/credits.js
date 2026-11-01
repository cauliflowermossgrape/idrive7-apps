'use strict';
// The translation credit in the corner is drawn only while Chinese is active. Packages containing
// Chinese carry its text in locale.json (build.py, from kit/localization/credit.zh-CN.json).
const locale = require('./locale.json');
const { getLanguage } = require('./i18n');
const CREDIT = typeof locale.credit === 'string' ? locale.credit : '';
function drawCredit(canvas, x, baseline) {
    if (getLanguage() !== 'zh-CN' || !CREDIT) return;
    canvas.text(CREDIT, x, baseline, 12, '#ffffff40', { align: 'right', font: 'label' });
}
module.exports = { CREDIT, drawCredit };
