/**
 * Mock for Obsidian module - provides minimal stubs for testing
 * Only implements what's needed for pure utility function tests
 */

export class TFile {
  path: string;
  basename: string;
  extension: string;

  constructor(path: string) {
    this.path = path;
    this.basename = path.split('/').pop()?.replace(/\.[^.]+$/, '') || '';
    this.extension = path.split('.').pop() || '';
  }
}

export class TFolder {
  path: string;
  children: (TFile | TFolder)[];

  constructor(path: string) {
    this.path = path;
    this.children = [];
  }
}

export type TAbstractFile = TFile | TFolder;

export class Notice {
  constructor(message: string, timeout?: number) {
    // No-op for tests
  }
}

export class App {
  vault = {
    read: async (file: TFile) => '',
    modify: async (file: TFile, content: string) => {},
    create: async (path: string, content: string) => new TFile(path),
    createFolder: async (path: string) => {},
    getAbstractFileByPath: (path: string) => null as TFile | TFolder | null,
    getMarkdownFiles: () => [] as TFile[],
  };

  metadataCache = {
    getFileCache: (file: TFile) => null as any,
    on: (event: string, callback: Function) => {},
    off: (event: string, callback: Function) => {},
    trigger: (event: string, ...args: any[]) => {},
  };

  workspace = {
    openLinkText: async (link: string, source: string, newLeaf: boolean) => {},
  };
}

export class Modal {
  app: App;

  constructor(app: App) {
    this.app = app;
  }

  open() {}
  close() {}
}

export class Setting {
  constructor(containerEl: HTMLElement) {}
  setName(name: string) { return this; }
  setDesc(desc: string) { return this; }
  addToggle(cb: Function) { return this; }
  addText(cb: Function) { return this; }
  addDropdown(cb: Function) { return this; }
  addButton(cb: Function) { return this; }
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}
