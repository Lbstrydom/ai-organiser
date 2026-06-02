import { en } from './en';
import { Translations } from './types';

export type { Translations } from './types';

// Supported interface languages. English-only — the i18n system stays, but the
// Simplified-Chinese locale was dropped (the EN/ZH parity burden outweighed its
// use). Re-adding a locale = add a `Translations` impl + an entry here.
export type SupportedLanguage = 'en';

export const languageMap: Record<SupportedLanguage, string> = {
    'en': 'English'
};

export const translations: Record<SupportedLanguage, Translations> = {
    'en': en
};

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

/**
 * Resolve the language pack for a stored language code. Unknown/legacy codes
 * (e.g. a previously-stored `'zh-cn'`) fall back to English.
 */
export function getTranslations(_languageCode: string = DEFAULT_LANGUAGE): Translations {
    return translations[DEFAULT_LANGUAGE];
}

/** All selectable interface-language options (code → display name). */
export function getLanguageOptions(): Record<string, string> {
    return Object.entries(languageMap).reduce((acc, [code, name]) => {
        acc[code] = name;
        return acc;
    }, {} as Record<string, string>);
}

/** Whether a language code is a supported interface language. */
export function isSupportedLanguage(languageCode: string): languageCode is SupportedLanguage {
    return languageCode in translations;
}
