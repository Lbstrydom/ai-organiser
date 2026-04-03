# Modal Lifecycle Convention

## Standard Pattern

All modals that add event listeners MUST follow this cleanup pattern:

```typescript
export class FeatureModal extends Modal {
    private cleanups: (() => void)[] = [];
    private component?: Component;
    private abortController?: AbortController;

    onOpen(): void {
        // Use listen() for all event listeners
        this.cleanups.push(listen(element, 'click', handler));

        // Init Component only if using MarkdownRenderer
        this.component = new Component();
        this.component.load();

        // Init AbortController for async operations
        this.abortController = new AbortController();
    }

    onClose(): void {
        // 1. Cancel async operations
        this.abortController?.abort();

        // 2. Run cleanup functions
        for (const cleanup of this.cleanups) cleanup();
        this.cleanups = [];

        // 3. Unload component (if used)
        this.component?.unload();

        // 4. Clear DOM (always last)
        this.contentEl.empty();
    }
}
```

## When to Use Each Tool

| Need                  | Tool                                    |
|-----------------------|-----------------------------------------|
| Event listeners       | `cleanups[]` + `listen()` from domUtils |
| Markdown rendering    | `Component` + `load()/unload()`         |
| Async cancellation    | `AbortController`                       |
| Timer cleanup         | `cleanups.push(() => clearInterval(id))`|

## Import

```typescript
import { listen } from '../utils/domUtils';
```
