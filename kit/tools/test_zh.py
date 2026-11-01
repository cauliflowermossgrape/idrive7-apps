#!/usr/bin/env python3
"""Check multilingual layouts and language subsets without loading the BMW SDK."""
import copy
import json
from pathlib import Path
import build
from localize import (unicode_resources, resource_tables, hmi_resources, with_languages, localize_spec,
                      languages, default_languages, parse_languages, load_locale)

root = Path(__file__).resolve().parent.parent.parent
# Only builds containing Chinese carry the translation credit; the app sources and common runtime do not.
for shipped in sorted(list((root / 'apps').rglob('*')) + list((root / 'kit/runtime').rglob('*'))):
    if shipped.is_file() and shipped.suffix in ('.js', '.json', '.py', '.md', '.txt', '.xml'):
        shipped_text = shipped.read_text(encoding='utf-8', errors='ignore')
        assert not any(n in shipped_text for n in ('JackieZ123430', '小白', '抖音')), shipped
count = 0
cases = (['en'], ['zh-CN'], ['ru'], default_languages())
for manifest in sorted((root / 'apps').glob('*/app.json')):
    original = json.loads(manifest.read_text(encoding='utf-8'))
    assert not any(s['key'] == 'language' for s in original['settings'])
    for selected in cases:
        spec = with_languages(original, selected)
        for key in ('id', 'signals', 'config', 'assets'):
            assert original.get(key) == spec.get(key), (manifest, key)
        own_settings = [s for s in spec['settings'] if s['key'] != 'language']
        assert own_settings == original['settings']
        language_settings = [s for s in spec['settings'] if s['key'] == 'language']
        assert len(language_settings) == (len(selected) > 1)
        if language_settings:
            assert language_settings[0]['default'] == ('en' if 'en' in selected else selected[0])
            assert [o[0] for o in language_settings[0]['options']] == selected
        _, ui, strings, _ = build.build_ui(copy.deepcopy(spec), selected)
        unicode_resources(ui, strings)
        tables = resource_tables(strings, selected)
        assert list(tables) == selected
        assert len([k for k in strings if k.startswith('SID_CN_DYNAMIC_')]) == 256
        assert len(strings) <= 1024
        assert all(set(table) == set(strings) - {'SID_CN_DYNAMIC_%04d' % n for n in range(256)} for table in tables.values())
        assert spec['title'] in strings.values()
        cn = [k for k in strings if k.endswith('_CN_CREDITS_TITLE') or k.endswith('_CN_CREDITS_LINK')]
        assert len(cn) == (2 if 'zh-CN' in selected else 0)
        if 'zh-CN' in selected:
            assert 'Translation by: 抖音 小白科技杂物社 / BiliBili 小白151' in tables['zh-CN'].values()
        for language, table in tables.items():
            if language != 'zh-CN':
                assert all('JackieZ123430' not in value and '小白' not in value and '抖音' not in value
                           for value in table.values()), language
        assert all(any('github.com/cauliflowermossgrape/idrive7-apps' in v for v in table.values()) for table in tables.values())
        shipped_hmi = hmi_resources(tables)
        assert 'de_DE' not in shipped_hmi and 'en_GB' in shipped_hmi
        assert ('ru_RU' in shipped_hmi) == ('ru' in selected)
        assert ('zh_CN' in shipped_hmi) == ('zh-CN' in selected)
        def visit(obj):
            if isinstance(obj, dict):
                if obj.get('type') == 'StringId': assert obj['value'] in strings, (manifest, obj)
                if obj.get('type') == 'Text' and isinstance(obj.get('value'), str): assert obj['value'] == ''
                for value in obj.values(): visit(value)
            elif isinstance(obj, list):
                for value in obj: visit(value)
        visit(ui)
        count += 1
    for language in ('en', 'zh-CN', 'ru'):
        localized = localize_spec(original, language)
        assert localized['version'] == original['version'] or localized['version'].startswith(original['version'] + '-')
        assert localized.get('signals') == original.get('signals')
try:
    unicode_resources({}, {'SID_TEST_%d' % n: '' for n in range(769)})
except ValueError:
    pass
else:
    raise AssertionError('build must reject bundles exceeding 1024 strings')
assert parse_languages('en, ru,en') == ['en', 'ru']
chinese = load_locale('zh-CN')
for key in ('page', 'values read', 'with a value', 'month', 'months', 'overdue'):
    assert chinese.get(key), 'Missing Chinese UI translation: ' + key
try:
    parse_languages('en,not-a-locale')
except ValueError:
    pass
else:
    raise AssertionError('unknown locales must be rejected')
extra = root / 'kit/runtime/locales/xx-test.json'
assert not extra.exists()
try:
    extra.write_text('{"Settings":"Test settings"}', encoding='utf-8')
    assert 'xx-test' in languages() and load_locale('xx-test')['Settings'] == 'Test settings'
finally:
    extra.unlink()
print('PASS: %d multilingual/subset layouts, selector rules, invariant IDs/settings, HMI resources and budgets' % count)
