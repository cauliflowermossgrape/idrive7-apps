// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 mlurker@gmail.com
// Client for aa-on-cluster's control socket, with a demo fallback.
'use strict';
/**
 * aa-on-cluster's control socket (aa-on-cluster-ctl.service, root:tm_oap_app 0660, one JSON
 * request per connection; docs/ARCHITECTURE.md "Protocol"). Without the socket (aa-on-cluster
 * 0.5 or newer not installed, a PC preview) or with demo on: a demo state kept in memory, so the
 * screen and its buttons work the same; `installed` then says why.
 */
const net = require('net');
const fs = require('fs');

const SOCKET = process.env.AOC_CTL_SOCKET || '/dev/shm/aa-on-cluster/ctl.sock';
const TIMEOUT_MS = 2000;
const DENSITIES = [];
for (let d = 150; d <= 400; d += 10) DENSITIES.push(d);      // what aa-on-cluster 0.6 takes (demo state)

function ask(req) {
    return new Promise((resolve) => {
        let buf = '', done = false;
        const s = net.connect(SOCKET);
        const end = (r) => { if (done) return; done = true; s.destroy(); clearTimeout(timer); resolve(r); };
        const timer = setTimeout(() => end({ ok: false, error: 'no answer' }), TIMEOUT_MS);
        s.on('connect', () => s.write(JSON.stringify(req) + '\n'));
        s.on('data', (d) => {
            buf += d;
            const i = buf.indexOf('\n');
            if (i >= 0) { try { end(JSON.parse(buf.slice(0, i))); } catch (e) { end({ ok: false, error: 'bad answer' }); } }
        });
        s.on('error', (e) => end({ ok: false, error: e.code || e.message }));
    });
}

class Ctl {
    constructor(useDemo) {
        this.useDemo = useDemo;
        this.demoState = { ok: true, state: 'active', density: 180, card: 'shown', running: { density: 180, card: 'shown' },
                           choices: DENSITIES, range: { min: 150, max: 400, step: 10 }, cards: ['shown', 'hidden'] };
    }
    /** the tool's socket exists (aa-on-cluster 0.5 or newer, its daemon running) */
    get installed() { return fs.existsSync(SOCKET); }
    get demo() { return this.useDemo() || !this.installed; }
    async status() {
        if (!this.demo) return ask({ cmd: 'status' });
        const s = this.demoState, run = s.running;
        return Object.assign({}, s, { pending: run.density !== s.density || run.card !== s.card });
    }
    async density(v) {
        if (this.demo) { this.demoState.density = v; return this.status(); }
        const r = await ask({ cmd: 'density', value: v });
        return r.ok ? this.status() : r;
    }
    async card(v) {
        if (this.demo) { this.demoState.card = v; return this.status(); }
        const r = await ask({ cmd: 'card', value: v });
        return r.ok ? this.status() : r;
    }
    async restart() { return this.demo ? { ok: true, demo: true } : ask({ cmd: 'restart' }); }
}

module.exports = { Ctl, DENSITIES, SOCKET, ask };
