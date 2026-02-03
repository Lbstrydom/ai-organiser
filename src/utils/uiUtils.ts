/**
 * UI Utilities
 * Shared UI helper functions for modals and components.
 */

/**
 * Enable auto-expand on a textarea element.
 * The textarea will grow as the user types, up to the specified max height.
 *
 * @param textarea - The textarea element to enable auto-expand on
 * @param maxHeight - Maximum height in pixels (default: 200)
 */
export function enableAutoExpand(textarea: HTMLTextAreaElement, maxHeight = 200): void {
    textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
    });
}
