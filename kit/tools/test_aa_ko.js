'use strict';
// Exercise the real AA display/actions with its in-memory demo controller only.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const stage = path.join(root, 'dist/aa_cluster_companion');
const { headUnit } = require('./hu-stub');
const { t } = require(path.join(stage, 'source/javascript/kit/i18n'));
const { Ctl } = require(path.join(stage, 'source/javascript/ctl'));

async function main() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-ko-'));
    const calls = [];
    // Show the active screen, but every action still uses Ctl's in-memory demo.
    Object.defineProperty(Ctl.prototype, 'installed', { get: () => true });
    Object.defineProperty(Ctl.prototype, 'demo', { get: () => true });
    for (const name of ['density', 'card', 'restart']) {
        const real = Ctl.prototype[name];
        Ctl.prototype[name] = function (...args) { calls.push([name, ...args]); return real.apply(this, args); };
    }
    const hu = headUnit(stage, {
        dataDir: dir, fresh: true, sets: { renderer: 'software' },
        log: { info() {}, warn() {}, error() {}, debug() {} }, image: async () => {},
    });
    let labels = [];
    // Cached panels use their own Recorder, so observe both the frame and its layers.
    const surfaces = [require(path.join(stage, 'source/javascript/kit/record')).Recorder,
        require(path.join(stage, 'source/javascript/kit/canvas')).Canvas];
    const originals = surfaces.map((Surface) => Surface.prototype.text);
    surfaces.forEach((Surface, i) => {
        Surface.prototype.text = function (value, ...args) {
            labels.push(t(value)); return originals[i].call(this, value, ...args);
        };
    });
    const interval = global.setInterval;
    try {
        global.setInterval = () => 0;
        hu.start();
        await new Promise((resolve) => setImmediate(resolve));
        const render = async () => { labels = []; await hu.loopFn(); return labels; };
        await render();
        for (const label of ['지도 배율', '회전 안내 카드', '넓은 지도', '사용자 지정', '약 31% 더 넓은 지도']) {
            assert(labels.includes(label), 'Missing Korean AA label: ' + label);
        }
        hu.handlers.BTN_ZOOM();
        await render();
        assert(labels.includes('변경 적용'));
        await hu.handlers.BTN_APPLY();
        await render();
        assert(labels.some((s) => s.startsWith('다음 시작:')));
        hu.handlers.BTN_CARD();
        await hu.handlers.BTN_APPLY();
        await render();
        assert(labels.some((s) => s.includes('카드 숨김')));
        await hu.handlers.BTN_APPLY(); // pending changes: this button now requests restart
        await render();
        assert(labels.includes('데모: 실제 환경에서는 지금 재시작합니다'));
        assert.deepStrictEqual(calls, [['density', 200], ['card', 'hidden'], ['restart']]);
        assert.strictEqual(t('about {percent}% larger text').replace('{percent}', '7'), '약 7% 더 큰 글자');
        assert(!labels.some((s) => /Map zoom|Turn card|More map|Apply changes|Restart head unit/.test(s)));
        console.log('PASS: AA Korean screen, percentage labels, apply/restart states; numeric and card control values unchanged');
    } finally {
        global.setInterval = interval;
        surfaces.forEach((Surface, i) => { Surface.prototype.text = originals[i]; });
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
