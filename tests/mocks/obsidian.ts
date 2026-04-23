/**
 * Mock for Obsidian module - provides stubs for testing
 * Supports modal testing, config service testing, and UI interactions
 */

// Track notices for testing
export const mockNotices: string[] = [];

export class TFile {
    path: string = '';
    basename: string = '';
    extension: string = '';
    stat: { mtime: number; ctime: number; size: number } = { mtime: Date.now(), ctime: Date.now(), size: 100 };
    name: string = '';
    parent: TFolder | null = null;
    vault: any = null;
}

/** Factory to create a TFile mock with path-derived properties (use instead of constructor args) */
export function createTFile(path: string): TFile {
    const file = new TFile();
    file.path = path;
    const fileName = path.split('/').pop() || '';
    file.name = fileName;
    file.basename = fileName.replace(/\.[^.]+$/, '');
    file.extension = fileName.includes('.') ? fileName.split('.').pop() || '' : '';
    return file;
}

export class TFolder {
    path: string = '';
    name: string = '';
    children: (TFile | TFolder)[] = [];
    parent: TFolder | null = null;
    vault: any = null;

    isRoot(): boolean {
        return this.path === '/' || !this.parent;
    }
}

/** Factory to create a TFolder mock with path-derived properties (use instead of constructor args) */
export function createTFolder(path: string): TFolder {
    const folder = new TFolder();
    folder.path = path;
    folder.name = path.split('/').pop() || '';
    return folder;
}

export type TAbstractFile = TFile | TFolder;

export class Notice {
    message: string;
    messageEl: MockHTMLElement;
    noticeEl: MockHTMLElement;
    hidden = false;

    constructor(message: string, timeout?: number) {
        this.message = message;
        mockNotices.push(message);
        this.messageEl = new MockHTMLElement();
        this.noticeEl = new MockHTMLElement();
        // Parent the noticeEl so MutationObservers in the code under test
        // have a parentElement to attach to. We don't simulate real DOM.
        const parent = new MockHTMLElement();
        (this.noticeEl as any).parentElement = parent;
        (this.messageEl as any).parentElement = this.noticeEl;
    }

    setMessage(msg: string) {
        this.message = msg;
    }

    hide() {
        this.hidden = true;
        this.noticeEl.isConnected = false;
    }
}

// Clear notices between tests
export function clearMockNotices() {
    mockNotices.length = 0;
}

export class App {
    keymap = {} as any;
    scope = {} as any;
    fileManager = {} as any;
    lastEvent = null as any;
    renderContext = {} as any;
    secretStorage = {} as any;
    isDarkMode(): boolean { return false; }
    loadLocalStorage(_key: string): any | null { return null; }
    saveLocalStorage(_key: string, _data: unknown | null): void {}

    vault: any = {
        read: async (file: TFile) => '',
        readBinary: async (file: TFile) => new ArrayBuffer(0),
        modify: async (file: TFile, content: string) => {},
        create: async (path: string, content: string) => createTFile(path),
        createFolder: async (path: string) => {},
        delete: async (file: TFile) => {},
        getAbstractFileByPath: (path: string) => null as TFile | TFolder | null,
        getMarkdownFiles: () => [] as TFile[],
        getFiles: () => [] as TFile[],
        getAllLoadedFiles: () => [] as (TFile | TFolder)[],
        getRoot: () => createTFolder('/'),
    };

    metadataCache: any = {
        getFileCache: (file: TFile) => null as any,
        getFirstLinkpathDest: (link: string, sourcePath: string) => null as TFile | null,
        on: (event: string, callback: Function) => ({ unload: () => {} }),
        off: (event: string, callback: Function) => {},
        trigger: (event: string, ...args: any[]) => {},
    };

    workspace: any = {
        openLinkText: async (link: string, source: string, newLeaf: boolean) => {},
        getActiveFile: () => null as TFile | null,
        on: (event: string, callback: Function) => ({ unload: () => {} }),
    };
}

// Mock HTML elements for modal testing
class MockHTMLElement {
    className: string = '';
    classList = {
        add: (cls: string) => { this.className += ` ${cls}`; },
        remove: (cls: string) => { this.className = this.className.replace(cls, ''); },
        toggle: (cls: string, force?: boolean) => {},
        contains: (cls: string) => this.className.includes(cls),
    };
    children: MockHTMLElement[] = [];
    textContent: string = '';
    innerHTML: string = '';
    style: Record<string, string> = {};
    _attributes: Record<string, string> = {};

    addClass(cls: string) { this.classList.add(cls); return this; }
    removeClass(cls: string) { this.classList.remove(cls); return this; }
    toggleClass(cls: string, force?: boolean) { this.classList.toggle(cls, force); return this; }
    hasClass(cls: string) { return this.classList.contains(cls); }

    createEl(tag: string, options?: { text?: string; cls?: string; attr?: Record<string, string> }) {
        const el = new MockHTMLElement();
        if (options?.cls) el.addClass(options.cls);
        if (options?.text) el.textContent = options.text;
        if (options?.attr) Object.assign(el._attributes, options.attr);
        this.children.push(el);
        return el;
    }

    createDiv(options?: { text?: string; cls?: string }) {
        return this.createEl('div', options);
    }

    createSpan(options?: { text?: string; cls?: string }) {
        return this.createEl('span', options);
    }

    setText(text: string) {
        this.textContent = text;
        return this;
    }

    empty() {
        this.children = [];
        this.innerHTML = '';
    }

    addEventListener(event: string, handler: Function) {
        const list = this._listeners.get(event) ?? [];
        list.push(handler);
        this._listeners.set(event, list);
    }
    removeEventListener(event: string, handler: Function) {
        const list = this._listeners.get(event);
        if (!list) return;
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
    }
    _listeners: Map<string, Function[]> = new Map();
    /** Test helper: fire a synthetic event of the given type. */
    _dispatch(event: string, payload?: any) {
        const list = this._listeners.get(event) ?? [];
        for (const h of list) h(payload);
    }
    querySelector(selector: string): MockHTMLElement | null {
        const cls = selector.replace(/^\./, '');
        for (const child of this.children) {
            if (child.classList.contains(cls)) return child;
            const nested = child.querySelector(selector);
            if (nested) return nested;
        }
        return null;
    }
    querySelectorAll(selector: string) { return []; }
    setAttribute(name: string, value: string) { this._attributes[name] = value; }
    setAttr(name: string, value: string) { this._attributes[name] = value; }
    getAttribute(name: string) { return this._attributes[name]; }
    removeAttribute(name: string) { delete this._attributes[name]; }
    setCssProps(props: Record<string, string>) {
        this._cssProps = Object.assign(this._cssProps ?? {}, props);
    }
    _cssProps: Record<string, string> = {};
    parentElement: MockHTMLElement | null = null;
    isConnected: boolean = true;
    remove() { this.isConnected = false; }
}

export class Modal {
    app: App;
    contentEl: MockHTMLElement;
    modalEl: MockHTMLElement;
    private _isOpen: boolean = false;
    private _isClosed: boolean = false;

    constructor(app: App) {
        this.app = app;
        this.contentEl = new MockHTMLElement();
        this.modalEl = new MockHTMLElement();
    }

    open() {
        this._isOpen = true;
        this._isClosed = false;
    }

    close() {
        this._isOpen = false;
        this._isClosed = true;
    }

    get isOpen() { return this._isOpen; }
    get isClosed() { return this._isClosed; }
}

export class WorkspaceLeaf {
    app: App;
    view: any;

    constructor(app?: App) {
        this.app = app || new App();
        this.view = null;
    }

    setViewState(_state: any): Promise<void> {
        return Promise.resolve();
    }
}

export class ItemView {
    leaf: WorkspaceLeaf;
    contentEl: any;

    constructor(leaf: WorkspaceLeaf) {
        this.leaf = leaf;
        this.contentEl = { empty: () => {} };
    }

    getViewType(): string { return ''; }
    getDisplayText(): string { return ''; }
    onOpen(): Promise<void> | void {}
    onClose(): Promise<void> | void {}
}

export class FuzzySuggestModal<T> extends Modal {
    constructor(app: App) {
        super(app);
    }

    setPlaceholder(placeholder: string) {}
    setInstructions(instructions: any[]) {}
    getItems(): T[] { return []; }
    getItemText(item: T): string { return ''; }
    onChooseItem(item: T, evt: any): void {}
    renderSuggestion(match: any, el: any): void {}
}

export class Setting {
    private containerEl: any;
    private _name: string = '';
    private _desc: string = '';

    constructor(containerEl: any) {
        this.containerEl = containerEl;
    }

    setName(name: string) {
        this._name = name;
        return this;
    }

    setDesc(desc: string) {
        this._desc = desc;
        return this;
    }

    addToggle(cb: (toggle: MockToggle) => void) {
        cb(new MockToggle());
        return this;
    }

    addText(cb: (text: MockTextComponent) => void) {
        cb(new MockTextComponent());
        return this;
    }

    addTextArea(cb: (textarea: MockTextAreaComponent) => void) {
        cb(new MockTextAreaComponent());
        return this;
    }

    addDropdown(cb: (dropdown: MockDropdown) => void) {
        cb(new MockDropdown());
        return this;
    }

    addButton(cb: (button: MockButton) => void) {
        cb(new MockButton());
        return this;
    }
}

class MockToggle {
    private _value: boolean = false;
    private _onChange?: (value: boolean) => void;

    setValue(value: boolean) {
        this._value = value;
        return this;
    }

    getValue() { return this._value; }

    onChange(cb: (value: boolean) => void) {
        this._onChange = cb;
        return this;
    }

    // For testing - simulate user toggle
    toggle() {
        this._value = !this._value;
        this._onChange?.(this._value);
    }
}

class MockTextComponent {
    private _value: string = '';
    private _onChange?: (value: string) => void;
    inputEl: MockHTMLElement = new MockHTMLElement();

    setValue(value: string) {
        this._value = value;
        return this;
    }

    getValue() { return this._value; }
    setPlaceholder(placeholder: string) { return this; }

    onChange(cb: (value: string) => void) {
        this._onChange = cb;
        return this;
    }
}

class MockTextAreaComponent extends MockTextComponent {
    inputEl: any = { rows: 0, addClass: () => {}, value: '' };
}

class MockDropdown {
    private _value: string = '';
    private _options: Map<string, string> = new Map();
    private _onChange?: (value: string) => void;

    addOption(value: string, display: string) {
        this._options.set(value, display);
        return this;
    }

    setValue(value: string) {
        this._value = value;
        return this;
    }

    getValue() { return this._value; }

    onChange(cb: (value: string) => void) {
        this._onChange = cb;
        return this;
    }

    getOptions() { return this._options; }
}

class MockButton {
    private _text: string = '';
    private _onClick?: () => void;

    setButtonText(text: string) {
        this._text = text;
        return this;
    }

    onClick(cb: () => void) {
        this._onClick = cb;
        return this;
    }

    setCta() { return this; }
    setWarning() { return this; }
}

export function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

export function setIcon(el: any, iconName: string) {
    // No-op for tests
}

export const Platform = {
    isMobile: false,
    isDesktop: true,
    isDesktopApp: true,
    isMobileApp: false,
};

export class Plugin {
    app: App;
    manifest: any;

    constructor() {
        this.app = new App();
        this.manifest = { id: 'test-plugin', version: '1.0.0' };
    }

    addCommand(cmd: any) {}
    addSettingTab(tab: any) {}
    loadData() { return Promise.resolve({}); }
    saveData(data: any) { return Promise.resolve(); }
    registerEvent(event: any) {}
}

export class PluginSettingTab {
    app: App;
    plugin: any;

    constructor(app: App, plugin: any) {
        this.app = app;
        this.plugin = plugin;
    }

    display(): void {}
}
