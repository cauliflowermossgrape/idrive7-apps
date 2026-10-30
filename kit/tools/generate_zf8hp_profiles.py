#!/usr/bin/env python3
"""Generate read-only EGS schemas from the documented BMW SGBD status tables.

Run from any directory. The ediabasx-docs-sgbd checkout is kept beside this
repository in mgu-root-lab/reference. Generated schemas ship with the app, so
the vehicle never needs the documentation checkout.
"""
import json
import argparse
import re
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / 'apps/zf8hp/profile_data.js'
VARIANTS = {
    '0F21E0': ('GSZFBHY1', 'GSZFBHY1'),
    '0F21D0': ('GSZFB1', 'GSZFB1'),
    '0F1F20': ('GKEG3HY', 'gkeg3hy'),
    '0F1890': ('GKEHY23', 'gkehy23'),
    '0F14B8': ('GKEB23TU', 'gkeb23tu'),
    '0F14B0': ('GSB231', 'gsb231'),
}
TYPE = {
    'char': (1, True), 'int': (2, True), 'long': (4, True),
    'signed char': (1, True), 'unsigned char': (1, False),
    'signed int': (2, True), 'unsigned int': (2, False),
    'signed long': (4, True), 'unsigned long': (4, False),
}


def cells(line):
    return [x.strip() for x in line.strip().strip('|').split('|')]


def number(v, default):
    try:
        return float(v)
    except ValueError:
        return default


def field(row, table):
    # RES rows: result, unit, endian, type, mask, name, mul, div, add, info.
    # SG_FUNKTIONEN rows: result=2, unit=4, endian=6, type=7, mul=9.
    name, unit, endian, dtype, mul, div, add, info = (
        (row[0], row[1], row[2], row[3], row[6], row[7], row[8], row[9]) if table else
        (row[2], row[4], row[6], row[7], row[9], row[10], row[11], row[3]))
    spec = TYPE.get(dtype.lower())
    if not spec or name == '-' or div == '0':
        return None
    return {'name': name, 'unit': unit, 'bytes': spec[0], 'signed': spec[1],
            'little': endian.lower() == 'low', 'factor': number(mul, 1) / number(div, 1),
            'offset': number(add, 0), 'info': info}


def parse(doc, allowed):
    s = doc.read_text()
    sections = {}
    for m in re.finditer(r'^### RES_0X([0-9A-Fa-f]{4})(?:_D)?\s*$', s, re.M):
        did = m.group(1).upper()
        end = s.find('\n<a id=', m.end())
        sections[did] = s[m.end(): end if end >= 0 else None]
    sg = s.split('### SG_FUNKTIONEN', 1)[1]
    records = {}
    for line in sg.splitlines():
        row = cells(line)
        if len(row) != 16 or not re.fullmatch(r'0x[0-9A-Fa-f]{4}', row[1]) or '22' not in row[13].split(';'):
            continue
        did = row[1][2:].upper()
        if did not in allowed:
            continue
        fields = []
        if row[15].upper() in ('RES_0X' + did, 'RES_0X' + did + '_D') and did in sections:
            for ln in sections[did].splitlines():
                r = cells(ln)
                if len(r) == 10 and r[0] not in ('RESULTNAME', '---') and not r[0].startswith('-'):
                    f = field(r, True)
                    if f is None:
                        fields = []
                        break
                    fields.append(f)
        elif row[2] != '-':
            f = field(row, False)
            if f:
                fields.append(f)
        at = 0
        for f in fields:
            f['at'] = at
            at += f['bytes']
        records[did] = {'name': row[0], 'description': row[3],
                        'length': at if fields else None, 'fields': fields}
    records['F150'] = {'name': 'SGBD_IDENTIFICATION', 'length': None, 'fields': []}
    ranges = []
    for f in records.get('4441', {}).get('fields', []):
        info = f['info']
        match = re.search(r'von\s*(-?\d+)\s*°?\s*bis\s*(-?\d+)\s*°', info)
        above = re.search(r'über\s*(-?\d+)\s*°', info)
        ranges.append(match.group(1) + '..' + match.group(2) if match else
                      '>' + above.group(1) if above else 'unknown')
    return {'records': records, 'ranges': ranges}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--docs', type=Path,
                    default=REPO.parents[1] / 'reference/open-source/ediabasx-docs-sgbd/docs/sgbd',
                    help='path to the ediabasx-docs-sgbd/docs/sgbd directory')
    docs = ap.parse_args().docs
    base = json.loads(subprocess.check_output([
        'node', '-e', 'process.stdout.write(JSON.stringify(require("./apps/zf8hp/catalog").records))'], cwd=REPO))
    allowed = set(base) | {'DA12', '4879', '4880', '4881', '4882', '4883', '4884', '4885'}
    data = {}
    for index, (name, file) in VARIANTS.items():
        doc = docs / (file + '.md')
        if not doc.exists():
            raise FileNotFoundError(doc)
        profile = parse(doc, allowed)
        profile['name'] = name
        profile['source'] = file + '.prg'
        profile['oilDid'] = next((d for d in ('6000', 'DA12') if profile['records'].get(d, {}).get('fields')), None)
        # Ship only the values needed by the runtime decoder. Field offsets
        # follow from widths, and names/prose remain in the source document.
        profile['records'] = {did: {
            'name': meta['name'], 'length': meta['length'],
            'unit': meta['fields'][0]['unit'] if meta['fields'] else '',
            'fields': [[f['bytes'], int(f['signed']), int(f['little']), f['factor'], f['offset']]
                       for f in meta['fields']]}
            for did, meta in profile['records'].items()}
        data[index] = profile
        print(index, name, len(profile['records']), 'DIDs', 'oil', profile['oilDid'])
    lines = ["'use strict';", '// Generated by kit/tools/generate_zf8hp_profiles.py from BMW SGBD documentation.',
             'module.exports = {']
    compact = lambda x: json.dumps(x, ensure_ascii=False, separators=(',', ':'))
    for index, profile in data.items():
        lines.append('  ' + compact(index) + ': {')
        for key in ('name', 'source', 'oilDid', 'ranges'):
            lines.append('    ' + key + ': ' + compact(profile[key]) + ',')
        lines.append('    records: {')
        for did, meta in profile['records'].items():
            lines.append('      ' + compact(did) + ': ' + compact(meta) + ',')
        lines.extend(['    },', '  },'])
    lines.append('};')
    OUT.write_text('\n'.join(lines) + '\n')


if __name__ == '__main__':
    main()
