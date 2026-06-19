import { vi } from "vitest";

export class MarkdownView {}

export class Modal {
  app: unknown;
  contentEl = {};
  modalEl = {
    addClass: vi.fn(),
    removeClass: vi.fn()
  };

  constructor(app: unknown) {
    this.app = app;
  }

  open() {}
}

export class Notice {
  constructor(_message: string, _timeout?: number) {}
}

export class Plugin {}

export class PluginSettingTab {
  app: unknown;
  plugin: unknown;
  containerEl = {};

  constructor(app: unknown, plugin: unknown) {
    this.app = app;
    this.plugin = plugin;
  }
}

export class Setting {}

export const requestUrl = vi.fn();
