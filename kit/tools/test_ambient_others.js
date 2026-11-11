'use strict';
// Ambient config (apps/ambient_config/others.js): IterioDev's Comfort tool seen while its control socket is there
// (a socket, not any file), said once each way in the log, with a change event each time.
//   node kit/tools/test_ambient_others.js
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'others-'));
const sock = path.join(dir, 'ctl.sock');
process.env.MGU_AMBIENT_COMFORT = sock;
const { Others } = require(path.join(__dirname, '..', '..', 'apps', 'ambient_config', 'others'));

let fails = 0, checks = 0;
const ok = (c, msg) => { checks++; if (!c) { fails++; console.log('FAIL ' + msg); } };
const said = [];
const log = { info: (m) => said.push('info ' + m), warn: (m) => said.push('warn ' + m) };

const o = new Others({ log });
let changes = 0;
o.on('change', () => { changes++; });
o.check();
ok(o.comfort === false && changes === 0 && said.length === 0, 'not running: nothing said');
fs.writeFileSync(sock, '');
o.check();
ok(o.comfort === false && changes === 0, 'a plain file is not its socket');
fs.unlinkSync(sock);
const server = net.createServer().listen(sock, () => {
    o.check(); o.check();
    ok(o.comfort === true && changes === 1 && said.length === 1 && /^warn .*Comfort tool is running/.test(said[0]), 'running: seen, said once');
    server.close(() => {
        o.check();
        ok(o.comfort === false && changes === 2 && /^info .*no longer running/.test(said[1]), 'stopped: said once more');
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`test_ambient_others: ${checks - fails}/${checks} checks pass`);
        process.exit(fails ? 1 : 0);
    });
});
