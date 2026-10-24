/**
 * Real-DOM helpers for tests that render Obsidian modals/panels under happy-dom: Obsidian's
 * HTMLElement extensions (createEl, createDiv, ...). Typed, so a mistake in a shim is a compile error.
 */

type ElOpts = { cls?: string; text?: string; attr?: Record<string, string>; type?: string; value?: string; placeholder?: string };

interface ObsidianElementShims {
	empty(this: HTMLElement): void;
	addClass(this: HTMLElement, ...classes: string[]): void;
	removeClass(this: HTMLElement, cls: string): void;
	toggleClass(this: HTMLElement, cls: string, on: boolean): void;
	hasClass(this: HTMLElement, cls: string): boolean;
	setText(this: HTMLElement, text: string): void;
	createEl(this: HTMLElement, tag: string, opts?: ElOpts): HTMLElement;
	createDiv(this: HTMLElement, opts?: ElOpts): HTMLElement;
	createSpan(this: HTMLElement, opts?: ElOpts): HTMLElement;
	setCssProps(this: HTMLElement, props: Record<string, string>): void;
}

export function installObsidianDomShims(): void {
	const shims: ObsidianElementShims = {
		empty() { while (this.firstChild) this.firstChild.remove(); },
		addClass(...classes) { this.classList.add(...classes.flatMap((c) => c.split(/\s+/).filter(Boolean))); },
		removeClass(cls) { this.classList.remove(cls); },
		toggleClass(cls, on) { this.classList.toggle(cls, on); },
		hasClass(cls) { return this.classList.contains(cls); },
		setText(text) { this.textContent = text; },
		createEl(tag, opts = {}) {
			const el = document.createElement(tag);
			if (opts.cls) for (const c of opts.cls.split(/\s+/).filter(Boolean)) el.classList.add(c);
			if (opts.text !== undefined) el.textContent = opts.text;
			if (opts.type) el.setAttribute('type', opts.type);
			if (opts.value !== undefined && (el instanceof HTMLInputElement || el instanceof HTMLOptionElement)) el.value = opts.value;
			if (opts.placeholder) el.setAttribute('placeholder', opts.placeholder);
			if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
			this.appendChild(el);
			return el;
		},
		createDiv(opts) { return this.createEl('div', opts) as HTMLElement; },
		createSpan(opts) { return this.createEl('span', opts) as HTMLElement; },
		setCssProps(props) { for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v); },
	};
	Object.assign(HTMLElement.prototype, shims);
}
