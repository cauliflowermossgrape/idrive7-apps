'use strict';
/**
 * presets.js - the six light sequences (Sequencer tab; from Exterior Lights by Paget96, PR #254): each 16 beats, each beat the light functions lit in it (the
 * functions strobe.js F names: high beam, cornering left / right, front fog, indicators, parking lights, brake,
 * reverse, rear fog), and how long a beat is. Kept in the app's data folder (presets.json); a slot never saved holds
 * its starting sequence.
 *
 *   load(file) -> [{ name, beatMs, beats: [[fn, ...] x BEATS] } x SLOTS]    save(file, list)
 *   toggle(p, beat, fn)    lit(p, beat) -> Set of fn
 */
const fs = require('fs');

const BEATS = 16, SLOTS = 6;
const LIGHTS = [
    ['high', 'High beam'], ['cornL', 'Cornering left'], ['cornR', 'Cornering right'], ['fog', 'Front fog'],
    ['indL', 'Indicator left'], ['indR', 'Indicator right'], ['parkL', 'Parking left'], ['parkR', 'Parking right'],
    ['brake', 'Brake'], ['reverse', 'Reverse'], ['rearFog', 'Rear fog'],
];
const KNOWN = LIGHTS.map((l) => l[0]);
const mk = (f) => Array.from({ length: BEATS }, (_, i) => f(i));
const DEFAULTS = [
    { name: 'Welcome', beatMs: 250, beats: mk((i) => [['parkL', 'parkR'], ['cornL', 'cornR'], ['fog'], ['high'], ['brake'], ['reverse']][Math.floor(i / 3) % 6].concat(i >= 12 ? ['high', 'brake'] : [])) },
    { name: 'Left right', beatMs: 300, beats: mk((i) => (i % 2 ? ['cornR', 'indR'] : ['cornL', 'indL'])) },
    { name: 'Pulse', beatMs: 250, beats: mk((i) => (i % 4 === 0 ? ['high', 'fog', 'brake'] : i % 4 === 2 ? ['parkL', 'parkR'] : [])) },
    { name: 'Rear only', beatMs: 300, beats: mk((i) => (i % 2 ? ['reverse'] : ['brake', 'rearFog'])) },
    { name: 'Wave', beatMs: 200, beats: mk((i) => [['indL'], ['cornL'], ['high'], ['cornR'], ['indR'], ['cornR'], ['high'], ['cornL']][i % 8]) },
    { name: 'Hazard style', beatMs: 400, beats: mk((i) => (i % 2 ? [] : ['indL', 'indR'])) },
];

function clean(p, d) {
    const beats = Array.isArray(p && p.beats) ? p.beats : d.beats;
    return {
        name: p && typeof p.name === 'string' && p.name.length < 24 ? p.name : d.name,
        beatMs: [200, 250, 300, 400, 500].indexOf(p && p.beatMs) >= 0 ? p.beatMs : d.beatMs,
        beats: mk((i) => (Array.isArray(beats[i]) ? beats[i].filter((f) => KNOWN.indexOf(f) >= 0) : [])),
    };
}

function load(file) {
    let saved = [];
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { saved = []; }
    return DEFAULTS.map((d, i) => clean(saved[i], d));
}

function save(file, list) {
    try { fs.writeFileSync(file, JSON.stringify(list)); return true; } catch (e) { return false; }
}

function toggle(p, beat, fn) {
    const b = p.beats[beat], i = b.indexOf(fn);
    if (i >= 0) b.splice(i, 1); else b.push(fn);
}

const lit = (p, beat) => new Set(p && p.beats[beat] ? p.beats[beat] : []);

module.exports = { BEATS, SLOTS, LIGHTS, DEFAULTS, load, save, toggle, lit, clean };
