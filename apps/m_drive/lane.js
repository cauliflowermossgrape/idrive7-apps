'use strict';

function blocked(why) {
    const e = new Error(why);
    e.blocked = true;
    return e;
}

class Lane {
    constructor(check) {
        this.check = check;
        this.gen = 0;
        this.job = null;
        this.tail = Promise.resolve();
    }

    // The reply filter of a 2F request takes any 7F 2F refusal, so two requests in flight could take each
    // other's answer: every request of the app waits for the one before it to be answered or to time out.
    wrap(diag) {
        const physical = diag.physical.bind(diag);
        diag.physical = (target, sid, data, timeoutMs, accept, opts) => {
            const job = { gen: this.gen };
            const run = this.tail.then(() => {
                this.job = job;
                return physical(target, sid, data, timeoutMs, accept, opts);
            });
            const done = () => { if (this.job === job) this.job = null; };
            this.tail = run.then(done, done);
            return run;
        };
        return diag;
    }

    // Diag sends a request the transport turned away as busy again 1-4 s later: every attempt is checked here.
    signals(base) {
        const call = (p, method, params, timeoutMs) => {
            if (method === 'sendTasuRequest') {
                const job = this.job;
                const check = () => {
                    const why = job !== this.job ? 'Not sent · diagnostic request expired'
                        : this.check(job, params.serviceID, Array.from(params.udsData || []));
                    if (why) throw blocked(why);
                };
                try { check(); } catch (e) { return Promise.reject(e); }
                const proxy = { callMethod() { check(); return p.callMethod.apply(p, arguments); } };
                return base.call(proxy, method, params, timeoutMs);
            }
            return base.call(p, method, params, timeoutMs);
        };
        return Object.assign({}, base, { call });
    }
}

module.exports = { Lane };
