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

export class SecretComponent {
  constructor(_app: unknown, _containerEl: unknown) {}
  setValue(_value: string) { return this; }
  onChange(_callback: (value: string) => unknown) { return this; }
}

export const requestUrl = vi.fn();
