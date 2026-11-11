#!/usr/bin/env python3
"""build.py fit_to_unit: what a unit's interface catalog lacks is taken out of an app's SOME/IP manifest, so BMW's
installer accepts the app (issue #145). A missing field, method or broadcast of any interface goes; a missing interface
only when app.json marks it "_optional"; an interface left with nothing goes; the platform's own proxies stay; no
catalog, nothing changes.
    python3 kit/tools/test_fit_to_unit.py
"""
import json, os, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build  # noqa: E402

checks = fails = 0


def ok(cond, msg):
    global checks, fails
    checks += 1
    if not cond:
        fails += 1
        print('FAIL ' + msg)


spec = {'id': 't', 'signals': {
    'de.bmw.infotainment.vehicle.CDS': {'statusEngineSpeed2': 'rs', 'statusBattery2': 'rs'},
    'de.bmw.infotainment.drivingexcitement.Efficiencytainment2': {'_optional': 'the power meter', 'displayPowerDrive2': 'rs'},
    'de.bmw.infotainment.navigation.guiding.GuidanceEventList': {'_optional': 'the phone\'s turns', '_instances': 'Main_Instance',
                                                                 '_methods': ['queryContent', 'gone'], '_broadcasts': ['changed']},
    'de.bmw.infrastructure.analytics.BasicDataSet': {'_optional': 'gearbox oil temperature', 'x': 'rs'},
    'de.bmw.infotainment.checkcontrol.CheckControlMaster': {'messages': 'rs'},
}}
catalog = {'interfaces': {
    # fields as BMW's catalog has them (a map by name); methods and events too
    'de.bmw.infotainment.vehicle.CDS': {'fields': {'statusEngineSpeed2': {}}, 'methods': {}, 'events': {}},
    'de.bmw.infotainment.drivingexcitement.Efficiencytainment2': {'fields': {'other': {}}},
    'de.bmw.infotainment.navigation.guiding.GuidanceEventList': {'fields': {}, 'methods': {'queryContent': {}}, 'events': {'changed': {}}},
}}

with tempfile.TemporaryDirectory() as d:
    cat = os.path.join(d, 'someip-interfaces.json')
    with open(cat, 'w') as f:
        json.dump(catalog, f)
    m = build.manifest_for(json.loads(json.dumps(spec)))
    platform = json.dumps({k: m['proxies'][k] for k in build.PLATFORM_PROXIES})
    missing = build.fit_to_unit(m, spec, cat)
    p = m['proxies']
    ok(p['de.bmw.infotainment.vehicle.CDS']['attributes'] == {'statusEngineSpeed2': 'rs'}, 'a missing field goes, the rest stay')
    ok(missing.get('de.bmw.infotainment.vehicle.CDS: statusBattery2') == 'these signals', 'a required interface\'s missing field is said')
    ok('de.bmw.infotainment.drivingexcitement.Efficiencytainment2' not in p and
       missing.get('de.bmw.infotainment.drivingexcitement.Efficiencytainment2: displayPowerDrive2') == 'the power meter',
       'an interface left with nothing goes, with what the app loses')
    g = p['de.bmw.infotainment.navigation.guiding.GuidanceEventList']
    ok(g['methods'] == ['queryContent'] and g['broadcasts'] == ['changed'] and g['instances'] == 'Main_Instance',
       'a missing method goes; known methods, broadcasts and instances stay')
    ok('de.bmw.infrastructure.analytics.BasicDataSet' not in p and missing.get('de.bmw.infrastructure.analytics.BasicDataSet') == 'gearbox oil temperature',
       'a missing optional interface goes')
    ok('de.bmw.infotainment.checkcontrol.CheckControlMaster' in p and not any(k.startswith('de.bmw.infotainment.checkcontrol') for k in missing),
       'a missing required interface is left for the Store / installer')
    ok(json.dumps({k: p[k] for k in build.PLATFORM_PROXIES}) == platform, 'the platform\'s own proxies stay as they are')

    m2 = build.manifest_for(json.loads(json.dumps(spec)))
    before = json.dumps(m2)
    ok(build.fit_to_unit(m2, spec, os.path.join(d, 'none.json')) == {} and json.dumps(m2) == before, 'no catalog: nothing changes')
    with open(cat, 'w') as f:
        f.write('not json')
    ok(build.fit_to_unit(m2, spec, cat) == {} and json.dumps(m2) == before, 'an unreadable catalog: nothing changes')

print('fit_to_unit: %d checks, %d failed' % (checks, fails))
sys.exit(1 if fails else 0)
