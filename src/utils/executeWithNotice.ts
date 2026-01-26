/**
 * Unified Error Handling and Notice Helper
 * Provides consistent Notice/error handling across all command flows
 */

import { Notice } from 'obsidian';
import type { Translations } from '../i18n/types';

export interface ExecuteWithNoticeOptions {
    /**
     * Task name for logging (e.g., 'Translating text')
     */
    task: string;

    /**
     * Called before the operation starts (e.g., shows "Processing..." notice)
     */
    onStart?: () => void;

    /**
     * Called on successful completion
     * @param result The successful result
     */
    onSuccess?: (result: any) => void;

    /**
     * Called on error with error details
     * @param error Error object or message
     * @param fallbackMessage i18n fallback message if error is a string
     */
    onError?: (error: Error | string, fallbackMessage?: string) => void;

    /**
     * Optional custom notice instance to use instead of showing new ones
     */
    customNotice?: Notice;

    /**
     * Whether to show a notice on success (default: true)
     */
    showSuccessNotice?: boolean;

    /**
     * Whether to log to console in debug mode (default: true)
     */
    debugLog?: boolean;
}

export interface ExecuteResult<T> {
    success: boolean;
    data?: T;
    error?: string;
}

/**
 * Execute an async operation with unified Notice handling.
 * Wraps the operation in consistent error/success messaging.
 *
 * @param operation The async function to execute
 * @param options Configuration for notice handling
 * @param translations i18n translations for default messages
 * @returns Promise resolving to ExecuteResult with data or error
 *
 * @example
 * const result = await executeWithNotice(
 *   async () => {
 *     const response = await someAsyncCall();
 *     return response.data;
 *   },
 *   {
 *     task: 'Translating text',
 *     onStart: () => new Notice('Starting translation...'),
 *     onSuccess: (result) => new Notice(`Translation complete: ${result.length} chars`),
 *     onError: (error) => new Notice(`Translation failed: ${error instanceof Error ? error.message : error}`),
 *     debugLog: plugin.settings.debugMode
 *   },
 *   plugin.t
 * );
 */
export async function executeWithNotice<T>(
    operation: () => Promise<T>,
    options: ExecuteWithNoticeOptions,
    translations?: Translations
): Promise<ExecuteResult<T>> {
    const {
        task,
        onStart,
        onSuccess,
        onError,
        showSuccessNotice = true,
        debugLog = false
    } = options;

    try {
        // Show start notice if provided
        if (onStart) {
            onStart();
        }

        if (debugLog) {
            console.log(`[AI Organiser] Starting: ${task}`);
        }

        // Execute the operation
        const result = await operation();

        // Show success notice
        if (showSuccessNotice) {
            new Notice(`${task} completed successfully`, 3000);
        }

        // Call custom success handler if provided
        if (onSuccess) {
            onSuccess(result);
        }

        if (debugLog) {
            console.log(`[AI Organiser] Completed: ${task}`, result);
        }

        return { success: true, data: result };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Show error notice
        new Notice(`${task} failed: ${errorMessage}`, 5000);

        // Call custom error handler if provided
        if (onError) {
            onError(error instanceof Error ? error : errorMessage);
        }

        if (debugLog) {
            console.error(`[AI Organiser] Error during ${task}:`, error);
        }

        return { success: false, error: errorMessage };
    }
}

/**
 * Show a notice with automatic timeout.
 * Centralizes notice creation for consistent styling/timing.
 *
 * @param message The message to display
 * @param duration Duration in milliseconds (default: 3000)
 * @param isError Whether this is an error notice (longer duration)
 */
export function showNotice(message: string, duration?: number, isError: boolean = false): void {
    new Notice(message, duration || (isError ? 5000 : 3000));
}

/**
 * Show error notice with consistent formatting.
 *
 * @param message Error message
 * @param context Optional context (e.g., "translating text")
 */
export function showErrorNotice(message: string, context?: string): void {
    const prefix = context ? `${context} failed: ` : 'Error: ';
    new Notice(prefix + message, 5000);
}

/**
 * Show success notice with consistent formatting.
 *
 * @param message Success message
 * @param context Optional context (e.g., "translating text")
 */
export function showSuccessNotice(message: string, context?: string): void {
    const prefix = context ? `${context} completed: ` : '';
    new Notice(prefix + message, 3000);
}
