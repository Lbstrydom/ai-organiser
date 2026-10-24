/**
 * Real-DOM helpers for tests that render Obsidian modals/panels under happy-dom: Obsidian's
 * HTMLElement extensions (createEl, createDiv, ...) and a Modal whose contentEl is a real element.
 */

export function installObsidianDomShims(): void {
    type ElOpts = { cls?: string; text?: string; attr?: Record<string, string>; type?: string; value?: string; placeholder?: string };
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const proto = HTMLElement.prototype as any;
    proto.empty = function () { while (this.firstChild) this.firstChild.remove(); };
    proto.addClass = function (...c: string[]) { this.classList.add(...c.filter(Boolean).flatMap((x) => x.split(/\s+/).filter(Boolean))); };
    proto.removeClass = function (c: string) { this.classList.remove(c); };
    proto.toggleClass = function (c: string, on: boolean) { this.classList.toggle(c, on); };
    proto.hasClass = function (c: string) { return this.classList.contains(c); };
    proto.setText = function (t: string) { this.textContent = t; };
    proto.createEl = function (tag: string, opts: ElOpts = {}) {
        const el = document.createElement(tag) as HTMLElement & Record<string, unknown>;
        if (opts.cls) for (const c of opts.cls.split(/\s+/).filter(Boolean)) el.classList.add(c);
        if (opts.text !== undefined) el.textContent = opts.text;
        if (opts.type) el.setAttribute('type', opts.type);
        if (opts.value !== undefined) (el as unknown as HTMLInputElement).value = opts.value;
        if (opts.placeholder) el.setAttribute('placeholder', opts.placeholder);
        if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, v);
        this.appendChild(el);
        return el;
    };
    proto.createDiv = function (opts: ElOpts = {}) { return this.createEl('div', opts); };
    proto.createSpan = function (opts: ElOpts = {}) { return this.createEl('span', opts); };
    proto.setCssProps = function (props: Record<string, string>) { for (const [k, v] of Object.entries(props)) this.style.setProperty(k, v); };
    /* eslint-enable @typescript-eslint/no-explicit-any */
}
