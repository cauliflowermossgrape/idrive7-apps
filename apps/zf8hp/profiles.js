'use strict';

const base = require('./catalog');
const other = require('./profile_data');

const profiles = {
    '0F25D0': { name: 'GSZFBCE', source: 'GSZFBCE.prg', records: base.records,
        ranges: base.ranges, oilDid: '6000' },
};
Object.keys(other).forEach((index) => {
    const source = other[index], records = {};
    Object.keys(source.records).forEach((did) => {
        const compact = source.records[did];
        let at = 0;
        const fields = compact.fields.map((row) => {
            const f = { at, bytes: row[0], signed: !!row[1], little: !!row[2],
                factor: row[3], offset: row[4], unit: compact.unit };
            at += f.bytes;
            return f;
        });
        records[did] = { name: compact.name, length: compact.length, fields };
    });
    profiles[index] = { name: source.name, source: source.source, records,
        ranges: source.ranges, oilDid: source.oilDid };
});

function select(index) { return profiles[String(index || '').toUpperCase()] || null; }

module.exports = { select, profiles };
