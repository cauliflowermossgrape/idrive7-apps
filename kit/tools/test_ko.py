#!/usr/bin/env python3
"""Korean layout/telemetry invariants, atlas coverage and display-path checks; no BMW SDK."""
import copy
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import build
from localize import localize_spec, unicode_resources, normalize_language

ROOT = Path(__file__).resolve().parent.parent.parent
for tag in ('ko', 'ko-kr', 'ko-KR', 'ko_KR', 'KO-KR'):
    assert normalize_language(tag) == 'ko'
for tag in ('en', 'ru', 'zh-CN'):
    assert normalize_language(tag) == tag
# Exercise argparse and the generated runtime, so a rejected regional tag cannot
# silently leave an older English stage being previewed.
for tag in ('ko-kr', 'ko-KR'):
    result = subprocess.run([sys.executable, str(ROOT / 'kit/tools/build.py'),
                             '--language', tag, '--preview-only', 'redline', 'aa_cluster_companion'],
                            cwd=ROOT, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    staged = ROOT / 'dist/redline/source/javascript/kit'
    locale = json.loads((staged / 'locale.json').read_text(encoding='utf-8'))
    spec = json.loads((staged / 'app-spec.json').read_text(encoding='utf-8'))
    assert locale['language'] == 'ko' and locale['strings']['SPEED'] == '속도'
    assert spec['version'].endswith('-ko.1') and (staged / 'fonts/korean.json').is_file()
    aa = ROOT / 'dist/aa_cluster_companion/source/javascript/kit'
    aa_locale = json.loads((aa / 'locale.json').read_text(encoding='utf-8'))
    assert aa_locale['language'] == 'ko' and aa_locale['strings']['Map zoom'] == '지도 배율'
    assert (aa / 'fonts/korean.json').is_file()
    aa_spec = json.loads((aa / 'app-spec.json').read_text(encoding='utf-8'))
    aa_original = json.loads((ROOT / 'apps/aa_cluster_companion/app.json').read_text(encoding='utf-8'))
    assert aa_spec['title'] == 'AA 계기판 도우미' and aa_spec['version'] == aa_original['version'] + '-ko.1'
    assert aa_spec['screens'][0]['buttons'][0][1] == '지도 배율'
print('PASS: ko-kr / ko-KR CLI aliases produce Korean stages, fonts and canonical package versions')
words = json.loads((ROOT / 'kit/runtime/locales/ko.json').read_text(encoding='utf-8'))
atlas = json.loads((ROOT / 'kit/localization/fonts/korean.json').read_text(encoding='utf-8'))['sizes'][0]
assert atlas['atlasW'] == 1024 and atlas['atlasH'] <= 3072
assert all(str(ord(ch)) in atlas['glyphs'] for text in words.values() for ch in text if ch not in '\n\r\t')
assert all(str(ord(ch)) in atlas['glyphs'] for ch in '엔진오일 브레이크액 차량 점검 2027년 9월 15일 교환 필요')

count = 0
for path in sorted((ROOT / 'apps').glob('*/app.json')):
    original = json.loads(path.read_text(encoding='utf-8'))
    spec = localize_spec(original, 'ko')
    for key in ('id', 'signals', 'config', 'assets', 'startWidget', 'loggingId'):
        assert spec.get(key) == original.get(key), (path, key)
    assert spec['version'] == original['version'] + '-ko.1'
    for a, b in zip(original['settings'], spec['settings']):
        assert a['key'] == b['key'] and a['default'] == b['default']
        assert [o[0] for o in a.get('options', [])] == [o[0] for o in b.get('options', [])]
    labels = [original['title']]
    for screen in original['screens']:
        labels += [screen.get('title', '')] + [b[1] for b in screen.get('buttons', [])]
    for setting in original['settings']:
        labels += [setting['label']] + [o[1] for o in setting.get('options', [])]
    # Units, currencies, acronyms and numeric presets deliberately stay unchanged.
    for label in labels:
        if ' ' in label and re.search('[A-Za-z]{2,}', label) and not re.match(r'^\d', label):
            assert label in words, (path, 'untranslated menu label', label)
    _, ui, strings, _ = build.build_ui(copy.deepcopy(spec), 'ko')
    unicode_resources(ui, strings, 'ko')
    assert len(strings) <= 1024
    assert len([s for s in strings if s.startswith('SID_CN_DYNAMIC_')]) == 256
    assert 'ko_KR' in build.LANGS
    count += 1

subprocess.run(['node', str(ROOT / 'kit/tools/test_ko.js')], cwd=ROOT, check=True,
               env=dict(os.environ, MGU_TEST_PYTHON=sys.executable))
subprocess.run(['node', str(ROOT / 'kit/tools/test_aa_ko.js')], cwd=ROOT, check=True)
print('PASS: %d Korean app layouts including AA Cluster Companion; %d translations; complete translation glyph coverage; unchanged telemetry and settings' % (count, len(words)))
