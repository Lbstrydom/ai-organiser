/**
 * Privacy Notice Manager
 * Shows a one-time warning per session when using cloud LLM providers
 */

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
        'claude',
        'gemini',
        'groq',
        'deepseek',
        'openrouter',
        'aliyun',
    ];
    return cloudProviders.includes(serviceType.toLowerCase());
}
