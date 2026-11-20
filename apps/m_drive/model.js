'use strict';
const { MIN_COOLING_RPM } = require('./tune');
const { Mg1ElAgk, MHD } = require('./real_adapters');

const RPM_FRESH_MS = 3000;
const CLOSE_LIMIT = 4000;
const REDLINE = 7000;

const DEMO = Object.freeze({ rpm: 840, oil: 102, coolant: 90, gearbox: 75, iat: 28, boost: 0, demo: true });

const GROUPS = [
    { id: 'map', title: 'MHD map' },
    { id: 'flap', title: 'Exhaust flap' },
    { id: 'cooling', title: 'Max Cooling' },
];

const ACTIONS = [
    { id: 'map1', group: 'map', value: 1, label: 'Map 1', button: 'BTN_MAP1' },
    { id: 'map2', group: 'map', value: 2, label: 'Map 2', button: 'BTN_MAP2' },
    { id: 'map3', group: 'map', value: 3, label: 'Map 3', button: 'BTN_MAP3' },
    { id: 'map4', group: 'map', value: 4, label: 'Map 4', button: 'BTN_MAP4' },
    { id: 'flapOem', group: 'flap', value: 'OEM', label: 'OEM', button: 'BTN_FLAP_OEM' },
    { id: 'flapOpen', group: 'flap', value: 'OPEN', label: 'Open', button: 'BTN_FLAP_OPEN' },
    { id: 'flapClosed', group: 'flap', value: 'CLOSED', label: 'Closed', button: 'BTN_FLAP_CLOSED' },
    { id: 'coolingOn', group: 'cooling', value: 'ON', label: 'On', button: 'BTN_COOL_ON' },
    { id: 'coolingOff', group: 'cooling', value: 'OFF', label: 'Off', button: 'BTN_COOL_OFF' },
];
const ACTION = {};
ACTIONS.forEach((a) => { ACTION[a.id] = a; });

const NOTE = {
    demo: 'Simulated · nothing is sent to the car (demo)',
    off: 'Car controls are off · turn them on in Settings',
    link: 'Waiting for the diagnostic link',
};

function transportMode(demo, controls) {
    return demo ? 'demo' : controls === 'on' ? 'live' : 'disarmed';
}

const READS = [0x22, 0x01, 0x06, 0x19];
const RPM_RULES = [
    {
        bytes: [0x2F, MHD.COOLING, 0x01],
        ok: (rpm) => rpm !== null && rpm > MIN_COOLING_RPM,
        why: 'Start the engine first · Max Cooling needs over ' + MIN_COOLING_RPM + ' rpm',
    },
    {
        bytes: [Mg1ElAgk.CLOSE_REQUEST.sid].concat(Mg1ElAgk.CLOSE_REQUEST.data),
        ok: (rpm) => rpm !== null && rpm <= CLOSE_LIMIT,
        why: 'Close needs a live engine speed under 4,000 rpm',
    },
];

function blockReason(sid, data, gen, s) {
    if (s.mode === 'demo') return 'Demo · nothing is sent to the car';
    if (gen !== s.gen) return 'Not sent · M Drive changed state before it could go';
    if (!s.visible) return 'Not sent · M Drive is not on screen';
    if (!s.link) return NOTE.link;
    if (READS.indexOf(sid) >= 0) return null;
    if (s.mode !== 'live') return 'Car controls are off';
    const bytes = [sid].concat(data);
    const rule = RPM_RULES.filter((r) => r.bytes.every((b, i) => bytes[i] === b))[0];
    return rule && !rule.ok(s.rpm) ? rule.why : null;
}

const TONE = { go: 'go', warn: 'warn' };
const IDLE = { selected: null, lit: null, busy: false, chip: null };

function engineChip(rpm) {
    if (rpm === null) return { text: 'rpm unknown', tone: 'warn' };
    return rpm > MIN_COOLING_RPM ? { text: 'engine running', tone: 'dim' } : { text: 'engine off', tone: 'dim' };
}

function liveGroups(s) {
    const tune = s.tune, flap = s.flap, note = s.flapNote;
    return {
        map: { selected: tune.map || null, lit: 'live', busy: !!tune.busy, chip: tune.map ? { text: 'accepted · no read-back', tone: 'dim' } : null },
        flap: {
            selected: flap.accepted || null,
            lit: 'live',
            busy: !!flap.sending,
            chip: flap.sending ? { text: 'sending…', tone: 'dim' } : note && note.warn ? { text: 'rpm guard', tone: 'warn' }
                : note ? { text: note.text, tone: 'dim' } : flap.accepted ? { text: 'accepted', tone: 'dim' } : null,
        },
        cooling: { selected: tune.cooling || null, lit: 'live', busy: !!tune.busy, chip: engineChip(s.rpm) },
    };
}

function liveStatus(s) {
    const last = s.last, flap = s.flap;
    if (s.flapNote && s.flapNote.warn) return { group: 'flap', text: s.flapNote.text, tone: 'warn' };
    if (!last) return null;
    if (last.note) return { group: last.group, text: last.note, tone: 'warn' };
    if (last.group !== 'flap') return s.tune.note ? { group: last.group, text: s.tune.note, tone: TONE[s.tune.noteType] || 'dim' } : null;
    const label = (v) => ACTIONS.filter((a) => a.group === 'flap' && a.value === v)[0].label;
    if (flap.sending) return { group: 'flap', text: 'Sending ' + label(flap.sending) + '…', tone: 'dim' };
    if (flap.error) return { group: 'flap', text: 'Not accepted · ' + flap.error, tone: 'warn' };
    return flap.accepted ? { group: 'flap', text: label(flap.accepted) + ' · accepted by the DME', tone: 'go' } : null;
}

function commandView(s) {
    if (s.mode === 'live') return Object.assign(liveGroups(s), { status: liveStatus(s) });
    const v = {};
    GROUPS.forEach((g) => {
        const p = s.mode === 'demo' && s.preview[g.id] != null ? s.preview[g.id] : null;
        v[g.id] = p === null ? IDLE : { selected: p, lit: 'demo', busy: false, chip: { text: 'simulated', tone: 'warn' } };
    });
    v.status = s.last ? { group: s.last.group, text: s.mode === 'demo' ? NOTE.demo : NOTE.off, tone: 'warn' } : null;
    return v;
}

module.exports = {
    RPM_FRESH_MS, CLOSE_LIMIT, REDLINE, DEMO, GROUPS, ACTIONS, ACTION, NOTE, transportMode, blockReason, commandView,
};
