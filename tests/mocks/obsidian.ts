// ============================================================
// Obsidian Module Mock (for tests)
// ============================================================

export class Plugin {
  app: any;
  loadData: any;
  saveData: any;
  addStatusBarItem: any;
  registerEvent: any;
  addCommand: any;
  addSettingTab: any;
  registerInterval: any;

  constructor(app?: any, data?: any) {
    this.app = app;
  }
}

export class PluginSettingTab {
  app: any;
  plugin: any;
  containerEl: HTMLElement;

  constructor(app: any, plugin: any) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
  }

  display(): void {
    // Override in subclass
  }
}

export class Modal {
  app: any;
  contentEl: HTMLElement;
  titleEl: HTMLElement;
  modalEl: HTMLElement;

  constructor(app: any) {
    this.app = app;
    this.contentEl = document.createElement("div");
    this.titleEl = document.createElement("div");
    this.modalEl = document.createElement("div");
  }

  open(): void {
    this.onOpen();
  }
  close(): void {
    this.onClose();
  }
  onOpen(): void {
    // Override in subclass
  }
  onClose(): void {
    // Override in subclass
  }
}

export class Setting {
  containerEl: HTMLElement;

  constructor(containerEl: HTMLElement) {
    this.containerEl = containerEl;
  }

  setName(_: string): this {
    return this;
  }
  setDesc(_: string): this {
    return this;
  }
  addText(cb: (text: any) => void): this {
    const text = {
      setPlaceholder: () => text,
      setValue: () => text,
      onChange: () => text,
      inputEl: document.createElement("input"),
    };
    cb(text);
    return this;
  }
  addDropdown(cb: (dropdown: any) => void): this {
    const dropdown = {
      addOption: () => dropdown,
      setValue: () => dropdown,
      onChange: () => dropdown,
    };
    cb(dropdown);
    return this;
  }
  addToggle(cb: (toggle: any) => void): this {
    const toggle = {
      setValue: () => toggle,
      onChange: () => toggle,
      toggleEl: document.createElement("div"),
    };
    cb(toggle);
    return this;
  }
  addButton(cb: (button: any) => void): this {
    const button = {
      setButtonText: () => button,
      setCta: () => button,
      onClick: (fn: () => void) => fn(),
      buttonEl: document.createElement("button"),
    };
    cb(button);
    return this;
  }
  addExtraButton(cb: (button: any) => void): this {
    const button = {
      setIcon: () => button,
      setTooltip: () => button,
      extraSettingsEl: document.createElement("span"),
    };
    cb(button);
    return this;
  }
}

export class Notice {
  constructor(_message: string) {}
}

export class ButtonComponent {
  buttonEl: HTMLButtonElement;
  constructor(containerEl: HTMLElement) {
    this.buttonEl = document.createElement("button");
    containerEl.appendChild(this.buttonEl);
  }
  setButtonText(text: string): this {
    this.buttonEl.textContent = text;
    return this;
  }
  setCta(): this {
    return this;
  }
  onClick(cb: () => void): this {
    this.buttonEl.addEventListener("click", cb);
    return this;
  }
}

export class App {}
export class TFile {}
