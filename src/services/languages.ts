/**
 * Common languages for summarization and translation
 */

export interface Language {
    code: string;
    name: string;
    nativeName: string;
}

// Common languages ordered by global usage/relevance
export const COMMON_LANGUAGES: Language[] = [
    { code: 'auto', name: 'Auto-detect', nativeName: 'Match source' },
    { code: 'en', name: 'English', nativeName: 'English' },
    { code: 'zh', name: 'Chinese (Simplified)', nativeName: '简体中文' },
    { code: 'zh-TW', name: 'Chinese (Traditional)', nativeName: '繁體中文' },
    { code: 'es', name: 'Spanish', nativeName: 'Español' },
    { code: 'fr', name: 'French', nativeName: 'Français' },
    { code: 'de', name: 'German', nativeName: 'Deutsch' },
    { code: 'ja', name: 'Japanese', nativeName: '日本語' },
    { code: 'ko', name: 'Korean', nativeName: '한국어' },
    { code: 'pt', name: 'Portuguese', nativeName: 'Português' },
    { code: 'ru', name: 'Russian', nativeName: 'Русский' },
    { code: 'ar', name: 'Arabic', nativeName: 'العربية' },
    { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी' },
    { code: 'it', name: 'Italian', nativeName: 'Italiano' },
    { code: 'nl', name: 'Dutch', nativeName: 'Nederlands' },
    { code: 'pl', name: 'Polish', nativeName: 'Polski' },
    { code: 'tr', name: 'Turkish', nativeName: 'Türkçe' },
    { code: 'vi', name: 'Vietnamese', nativeName: 'Tiếng Việt' },
    { code: 'th', name: 'Thai', nativeName: 'ไทย' },
    { code: 'id', name: 'Indonesian', nativeName: 'Bahasa Indonesia' },
    { code: 'sv', name: 'Swedish', nativeName: 'Svenska' },
    { code: 'da', name: 'Danish', nativeName: 'Dansk' },
    { code: 'no', name: 'Norwegian', nativeName: 'Norsk' },
    { code: 'fi', name: 'Finnish', nativeName: 'Suomi' },
    { code: 'he', name: 'Hebrew', nativeName: 'עברית' },
    { code: 'uk', name: 'Ukrainian', nativeName: 'Українська' },
    { code: 'cs', name: 'Czech', nativeName: 'Čeština' },
    { code: 'el', name: 'Greek', nativeName: 'Ελληνικά' },
    { code: 'ro', name: 'Romanian', nativeName: 'Română' },
    { code: 'hu', name: 'Hungarian', nativeName: 'Magyar' },
];

/**
 * Get language name for display (shows both English and native name)
 */
export function getLanguageDisplayName(lang: Language): string {
    if (lang.code === 'auto') {
        return lang.name;
    }
    if (lang.name === lang.nativeName) {
        return lang.name;
    }
    return `${lang.name} (${lang.nativeName})`;
}

/**
 * Get language by code
 */
export function getLanguageByCode(code: string): Language | undefined {
    return COMMON_LANGUAGES.find(l => l.code === code);
}

/**
 * Convert language code to full name for prompts
 */
export function getLanguageNameForPrompt(code: string): string | undefined {
    if (!code || code === 'auto') {
        return undefined;
    }
    const lang = getLanguageByCode(code);
    return lang ? lang.name : code;
}
