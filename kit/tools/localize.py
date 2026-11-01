"""Language catalogs, selectable package languages and HMI resource tables."""
import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
LOCALES = ROOT / 'kit/runtime/locales'
LANGUAGE_NAMES = {'en': 'English', 'zh-CN': '简体中文', 'ru': 'Русский'}
HMI_LOCALES = {'en': ['en_GB', 'en_US'], 'zh-CN': ['zh_CN'], 'ru': ['ru_RU']}


def zh_credit():
    return json.loads((ROOT / 'kit/localization/credit.zh-CN.json').read_text(encoding='utf-8'))


def languages():
    return ['en'] + sorted(p.stem for p in LOCALES.glob('*.json') if p.stem != 'en')


def default_languages():
    return languages()


def parse_languages(value):
    selected = []
    for language in str(value).split(','):
        language = language.strip()
        if language and language not in selected:
            selected.append(language)
    if not selected:
        raise ValueError('Select at least one language')
    unknown = [language for language in selected if language not in languages()]
    if unknown:
        raise ValueError('Unknown language(s): %s (available: %s)' % (', '.join(unknown), ', '.join(languages())))
    return selected


def load_locale(language):
    if language not in languages():
        raise ValueError('Unknown language: ' + language)
    return {} if language == 'en' else json.loads((LOCALES / (language + '.json')).read_text(encoding='utf-8'))


def text(value, words):
    s = str(value)
    return words.get(s, s).replace(' (default)', ' ' + words.get('(default)', '(default)'))


def package_version(version, language):
    revisions = json.loads((Path(__file__).parent / 'locale-revisions.json').read_text(encoding='utf-8'))
    return version if language == 'en' else version + '-' + language.lower().replace('-', '.') + '.' + str(revisions.get(language, 1))


def with_languages(spec, selected):
    """Add the app language setting only when a package contains a choice."""
    s = copy.deepcopy(spec)
    if len(selected) > 1 and not any(item['key'] == 'language' for item in s.get('settings', [])):
        default = 'en' if 'en' in selected else selected[0]
        s['settings'] = [{'key': 'language', 'label': 'Language', 'type': 'choice', 'default': default,
                          'options': [[language, LANGUAGE_NAMES.get(language, language)] for language in selected]}] + s.get('settings', [])
    return s


def localize_spec(spec, language, versioned=True):
    words = load_locale(language)
    s = copy.deepcopy(spec)
    if versioned:
        s['version'] = package_version(s['version'], language)
    s['title'] = text(s['title'], words)
    for screen in s.get('screens', []):
        if 'title' in screen:
            screen['title'] = text(screen['title'], words)
        for button in screen.get('buttons', []):
            button[1] = text(button[1], words)
        for item in screen.get('items', []):
            if len(item) > 2 and isinstance(item[2], str):
                item[2] = text(item[2], words)
    for setting in s.get('settings', []):
        setting['label'] = text(setting['label'], words)
        for option in setting.get('options', []):
            option[1] = text(option[1], words)
    return s


def unicode_resources(ui, strings):
    """Give initial Text cells stable StringIds and reserve dynamic Unicode slots."""
    counter = [0]

    def visit(obj):
        if isinstance(obj, dict):
            value = obj.get('value')
            if obj.get('type') == 'Text' and isinstance(value, str) and value:
                sid = 'SID_CN_STATIC_%04d' % counter[0]
                counter[0] += 1
                strings[sid] = value
                obj.update(value=sid, type='StringId')
            else:
                for item in obj.values():
                    visit(item)
        elif isinstance(obj, list):
            for item in obj:
                visit(item)

    visit(ui)
    for n in range(256):
        strings['SID_CN_DYNAMIC_%04d' % n] = ''
    if len(strings) > 1024:
        raise ValueError('HMI string bundle exceeds the verified 1024-resource budget')


def resource_tables(strings, selected):
    english = {key: value for key, value in strings.items() if not key.startswith('SID_CN_DYNAMIC_')}
    tables = {}
    for language in selected:
        words = load_locale(language)
        table = {key: text(value, words) for key, value in english.items()}
        for key in table:
            if language == 'zh-CN' and key.endswith('_CN_CREDITS_TITLE'):
                table[key] = zh_credit()['settingsTitle']
        tables[language] = table
    return tables


def hmi_resources(tables):
    """Only ship locales the HMI can select, plus its English fallback slots."""
    fallback = tables.get('en') or next(iter(tables.values()))
    result = {'en_GB': fallback, 'en_US': tables.get('en', fallback)}
    for language, table in tables.items():
        for hmi_locale in HMI_LOCALES.get(language, []):
            result[hmi_locale] = table
    return result
