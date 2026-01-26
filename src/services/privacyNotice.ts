/**
 * Privacy Notice Manager
 * Shows a one-time warning per session when using cloud LLM providers
 */

import { PrivacyNoticeModal } from '../ui/modals/PrivacyNoticeModal';
import type { App } from 'obsidian';
import type { Translations } from '../i18n/types';

let privacyNoticeShownThisSession = false;

/**
 * Reset the privacy notice state (called on plugin load)
 */
export function resetPrivacyNotice(): void {
    privacyNoticeShownThisSession = false;
}

/**
 * Check if we should show the privacy notice
 */
export function shouldShowPrivacyNotice(isCloudProvider: boolean): boolean {
    if (!isCloudProvider) return false;
    if (privacyNoticeShownThisSession) return false;
    return true;
}

/**
 * Mark the privacy notice as shown for this session
 */
export function markPrivacyNoticeShown(): void {
    privacyNoticeShownThisSession = true;
}

/**
 * Check if provider is a cloud provider (sends data externally)
 */
export function isCloudProvider(serviceType: string): boolean {
    const cloudProviders = [
        'cloud',
        'openai',
        'openai-compatible',
        'claude',
        'gemini',
        'groq',
        'deepseek',
        'openrouter',
        'aliyun',
    ];
    return cloudProviders.includes(serviceType.toLowerCase());
}

/**
 * Ensure privacy consent is obtained if needed for cloud providers.
 * Returns true if it's safe to proceed, false if user declined.
 */
export async function ensurePrivacyConsent(
    plugin: { app: App; t: Translations },
    provider: string
): Promise<boolean> {
    if (!isCloudProvider(provider)) return true;
    if (!shouldShowPrivacyNotice(true)) return true;

    return new Promise((resolve) => {
        const modal = new PrivacyNoticeModal(plugin.app, plugin.t, provider, (proceed) => {
            if (proceed) {
                markPrivacyNoticeShown();
            }
            resolve(proceed);
        });
        modal.open();
    });
}
