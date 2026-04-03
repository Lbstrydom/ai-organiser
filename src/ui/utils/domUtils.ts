/**
 * Adds an event listener and returns a cleanup function.
 * Usage: this.cleanups.push(listen(el, 'click', handler));
 */
export function listen<K extends keyof HTMLElementEventMap>(
    el: HTMLElement | Document,
    event: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions
): () => void {
    el.addEventListener(event, handler as EventListener, options);
    return () => el.removeEventListener(event, handler as EventListener, options);
}
