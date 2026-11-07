'use strict';
/**
 * l10n.js - Exhaust Remote's on-screen words in the fixed-language builds (build.py --language ko | zh-CN | ru).
 *
 * The menus (title, settings, buttons of the HMI list) are in the shared catalogues, kit/runtime/locales/*.tsv. The
 * line under the state word (driving mode names, the rpm guard's messages, "holding") and the four buttons are
 * translated here instead: those words (Sport, Comfort, holding, Open...) are also other apps' text, with other
 * meanings, and the buttons upper-case their label, which would turn Open into the state word OPEN. English builds use
 * the English unchanged. Every character here is in that language's glyph atlas (test_exhaust_remote.js checks).
 *
 *   button(lang, key, english): a button's label ('OPEN' | 'CLOSED' | 'OEM' | 'DRIVE');
 *   note(lang, text): the status line, translated piece by piece ('a · b'), the rpm figure kept.
 */
const WORDS = {
    'ko': {
        buttons: {"OPEN": "열기", "CLOSED": "닫기", "OEM": "순정 제어", "DRIVE": "주행 모드"},
        text: {
            "RPM signal lost · OEM requested · select CLOSE again": "RPM 신호 없음 · 순정 제어로 전환 · 닫기를 다시 선택하세요",
            "RPM signal lost · Close paused · the car has the flap": "RPM 신호 없음 · 닫힘 일시 중지 · 차량이 밸브 제어 중",
            "Close paused above {rpm} rpm · the car has the flap": "{rpm} rpm 초과 · 닫힘 일시 중지 · 차량이 밸브 제어 중",
            "Waiting for the driving mode": "주행 모드 확인 중",
            "holding": "유지 중",
            "Sport": "스포츠",
            "Sport+": "스포츠 플러스",
            "Sport Individual": "스포츠 개별 설정",
            "Comfort": "컴포트",
            "Comfort+": "컴포트 플러스",
            "Comfort Individual": "컴포트 개별 설정",
            "Eco Pro": "에코 프로",
            "Eco Pro+": "에코 프로 플러스",
            "Eco Pro Individual": "에코 프로 개별 설정",
            "Adaptive": "어댑티브",
        },
    },
    'zh-CN': {
        buttons: {"OPEN": "打开", "CLOSED": "关闭", "OEM": "原厂控制", "DRIVE": "驾驶模式"},
        text: {
            "RPM signal lost · OEM requested · select CLOSE again": "无转速信号：已切换为原厂控制，请重新选择关闭",
            "RPM signal lost · Close paused · the car has the flap": "无转速信号：关闭已暂停，由车辆控制阀门",
            "Close paused above {rpm} rpm · the car has the flap": "高于 {rpm} rpm：关闭已暂停，由车辆控制阀门",
            "Waiting for the driving mode": "等待驾驶模式",
            "holding": "保持中",
            "Sport": "运动",
            "Sport+": "运动+",
            "Sport Individual": "运动个性化",
            "Comfort": "舒适",
            "Comfort+": "舒适+",
            "Comfort Individual": "舒适个性化",
            "Eco Pro": "节能",
            "Eco Pro+": "节能+",
            "Eco Pro Individual": "节能个性化",
            "Adaptive": "自适应",
        },
    },
    'ru': {
        buttons: {"OPEN": "Открыть", "CLOSED": "Закрыть", "OEM": "Штатно", "DRIVE": "Режим движения"},
        text: {
            "RPM signal lost · OEM requested · select CLOSE again": "Нет сигнала оборотов · включён штатный режим · выберите Закрыть снова",
            "RPM signal lost · Close paused · the car has the flap": "Нет сигнала оборотов · закрытие на паузе · заслонкой управляет автомобиль",
            "Close paused above {rpm} rpm · the car has the flap": "Закрытие на паузе выше {rpm} об/мин · заслонкой управляет автомобиль",
            "Waiting for the driving mode": "Ожидание режима движения",
            "holding": "удержание",
            "Sport": "Спорт",
            "Sport+": "Спорт+",
            "Sport Individual": "Спорт индивидуальный",
            "Comfort": "Комфорт",
            "Comfort+": "Комфорт+",
            "Comfort Individual": "Комфорт индивидуальный",
            "Eco Pro": "Эко Про",
            "Eco Pro+": "Эко Про+",
            "Eco Pro Individual": "Эко Про индивидуальный",
            "Adaptive": "Адаптивный",
        },
    },
};

function button(lang, key, english) {
    const w = WORDS[lang];
    return (w && w.buttons[key]) || english;
}

const PAUSED = /^Close paused above (.+) rpm · the car has the flap$/;

function note(lang, text) {
    const w = WORDS[lang];
    if (!w || !text) return text;
    if (Object.prototype.hasOwnProperty.call(w.text, text)) return w.text[text];
    const m = PAUSED.exec(text);
    if (m) return w.text['Close paused above {rpm} rpm · the car has the flap'].replace('{rpm}', m[1]);
    return text.split(' · ').map((p) => (Object.prototype.hasOwnProperty.call(w.text, p) ? w.text[p] : p)).join(' · ');
}

module.exports = { WORDS, button, note };
