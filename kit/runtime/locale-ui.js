'use strict';
const { setLanguage, getLanguage } = require('./i18n');
class LocaleUi {
    constructor(settings, tables, bundle, dynamicText, onLanguage) {
        this.settings = settings; this.tables = tables; this.bundle = bundle; this.dynamicText = dynamicText;
        this.onLanguage = onLanguage;
        this.pending = Promise.resolve();
    }
    refresh() {
        this.pending = this.pending.catch(() => {}).then(() => {
            setLanguage(this.settings.get('language'));
            return this.onLanguage ? this.onLanguage(getLanguage()) : null;
        }).then(() => this.bundle.setStrings(this.tables[getLanguage()])).then(() => this.dynamicText.refresh());
        return this.pending;
    }
}
module.exports = { LocaleUi };
