import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  View,
  WorkspaceLeaf
} from 'obsidian';

// Obsidian v0.15 marks these fields as private even though they're accessible at runtime.
interface ExtendedView extends View {
  contentEl?: HTMLElement;
}
interface ExtendedWorkspaceLeaf extends WorkspaceLeaf {
  containerEl?: HTMLElement;
  view: ExtendedView;
}

interface KanbanStatusUpdaterSettings {
  statusPropertyName: string;
  showNotifications: boolean;
  debugMode: boolean;
}

const DEFAULT_SETTINGS: KanbanStatusUpdaterSettings = {
  statusPropertyName: 'status',
  showNotifications: false,
  debugMode: false
};

const BOARD_SELECTOR = '.kanban-plugin__board';
const ITEM_SELECTOR = '.kanban-plugin__item';
const LANE_SELECTOR = '.kanban-plugin__lane';
const LANE_TITLE_SELECTOR = '.kanban-plugin__lane-header-wrapper .kanban-plugin__lane-title';
const INTERNAL_LINK_SELECTOR = '.kanban-plugin__item-title .kanban-plugin__item-markdown a.internal-link';

const DETECTION_MAX_ATTEMPTS = 10;
const DETECTION_RETRY_MS = 50;
const UPDATE_DEBOUNCE_MS = 300;

export default class KanbanStatusUpdaterPlugin extends Plugin {
  settings: KanbanStatusUpdaterSettings;

  private currentObserver: MutationObserver | null = null;
  private activeKanbanBoard: HTMLElement | null = null;
  private isProcessing = false;
  private detectionToken = 0;

  async onload() {
    console.log('Loading Kanban Status Updater plugin');
    await this.loadSettings();

    if (this.settings.showNotifications) {
      new Notice('Kanban Status Updater activated');
    }

    this.registerDomEvent(document, 'dragend', this.onDragEnd.bind(this));

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.checkForActiveKanbanBoard())
    );
    // file-open covers single-click tab replacements, which don't fire active-leaf-change.
    this.registerEvent(
      this.app.workspace.on('file-open', () => this.checkForActiveKanbanBoard())
    );

    this.app.workspace.onLayoutReady(() => this.checkForActiveKanbanBoard());

    this.addSettingTab(new KanbanStatusUpdaterSettingTab(this.app, this));
  }

  onunload() {
    this.disconnectObserver();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private log(message: string) {
    if (this.settings.debugMode) console.log(`[KSU] ${message}`);
  }

  private disconnectObserver() {
    if (this.currentObserver) {
      this.currentObserver.disconnect();
      this.currentObserver = null;
    }
    this.activeKanbanBoard = null;
  }

  private findActiveKanbanBoardElement(): HTMLElement | null {
    const leaf = this.app.workspace.getLeaf(false) as ExtendedWorkspaceLeaf | null;
    if (!leaf) return null;
    const contentEl =
      leaf.view?.contentEl
      ?? (leaf.containerEl?.querySelector('.view-content') as HTMLElement | null)
      ?? (document.querySelector('.workspace-leaf.mod-active .view-content') as HTMLElement | null);
    return contentEl?.querySelector(BOARD_SELECTOR) as HTMLElement | null;
  }

  checkForActiveKanbanBoard() {
    this.disconnectObserver();
    const token = ++this.detectionToken;
    this.pollForKanbanBoard(token, 0);
  }

  private pollForKanbanBoard(token: number, attempt: number) {
    if (token !== this.detectionToken) return;

    const board = this.findActiveKanbanBoardElement();
    if (board) {
      this.log(`Found Kanban board on attempt ${attempt + 1}`);
      this.activeKanbanBoard = board;
      this.setupObserverForBoard(board);
      return;
    }

    if (attempt + 1 < DETECTION_MAX_ATTEMPTS) {
      setTimeout(() => this.pollForKanbanBoard(token, attempt + 1), DETECTION_RETRY_MS);
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    const viewType = (leaf?.view as { getViewType?: () => string })?.getViewType?.() ?? 'unknown';
    this.log(`Active leaf is not a Kanban board (view type: ${viewType})`);
  }

  private setupObserverForBoard(boardElement: HTMLElement) {
    this.currentObserver = new MutationObserver((mutations) => {
      if (this.isProcessing) return;
      this.isProcessing = true;
      // Wait for Kanban's own re-render to settle before reading lane state.
      setTimeout(() => {
        try {
          this.handleMutations(mutations);
        } finally {
          this.isProcessing = false;
        }
      }, UPDATE_DEBOUNCE_MS);
    });
    this.currentObserver.observe(boardElement, {
      childList: true,
      subtree: true,
      attributes: false
    });
    this.log('Observer set up for active Kanban board');
  }

  private handleMutations(mutations: MutationRecord[]) {
    if (!this.activeKanbanBoard) return;
    const items = new Set<HTMLElement>();
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;
      for (const node of Array.from(mutation.addedNodes)) {
        if (!(node instanceof Element)) continue;
        const item = node.closest(ITEM_SELECTOR) as HTMLElement | null;
        if (item && this.activeKanbanBoard.contains(item)) items.add(item);
      }
    }
    for (const item of items) this.processKanbanItem(item);
  }

  private onDragEnd(event: DragEvent) {
    if (!this.activeKanbanBoard || this.isProcessing) return;
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const item = target.closest(ITEM_SELECTOR) as HTMLElement | null;
    if (!item || !this.activeKanbanBoard.contains(item)) return;

    this.isProcessing = true;
    try {
      this.processKanbanItem(item);
    } finally {
      setTimeout(() => { this.isProcessing = false; }, UPDATE_DEBOUNCE_MS);
    }
  }

  private processKanbanItem(itemElement: HTMLElement) {
    const internalLink = itemElement.querySelector(INTERNAL_LINK_SELECTOR);
    if (!internalLink) return;

    const linkPath = internalLink.getAttribute('data-href') ?? internalLink.getAttribute('href');
    if (!linkPath) return;

    const laneTitle = itemElement
      .closest(LANE_SELECTOR)
      ?.querySelector(LANE_TITLE_SELECTOR)
      ?.textContent
      ?.trim();
    if (!laneTitle) return;

    this.updateNoteStatus(linkPath, laneTitle);
  }

  private async updateNoteStatus(notePath: string, status: string) {
    const file = this.app.metadataCache.getFirstLinkpathDest(notePath, '');
    if (!file) {
      if (this.settings.showNotifications) {
        new Notice(`⚠️ Note "${notePath}" not found`, 3000);
      }
      return;
    }

    const prop = this.settings.statusPropertyName;
    const oldStatus = this.app.metadataCache.getFileCache(file)?.frontmatter?.[prop] ?? null;
    if (oldStatus === status) {
      this.log(`Status already "${status}" for ${file.basename}, skipping`);
      return;
    }

    try {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        fm[prop] = status;
      });
    } catch (error) {
      this.log(`Error updating status: ${error.message}`);
      if (this.settings.showNotifications) {
        new Notice(`⚠️ Error updating status: ${error.message}`, 3000);
      }
      return;
    }

    this.log(`Updated ${file.basename}: "${oldStatus ?? '(unset)'}" → "${status}"`);
    if (this.settings.showNotifications) {
      const msg = oldStatus
        ? `Updated ${prop}: "${oldStatus}" → "${status}" for ${file.basename}`
        : `Set ${prop}: "${status}" for ${file.basename}`;
      new Notice(msg, 3000);
    }
  }

  runTest() {
    const board = this.activeKanbanBoard ?? this.findActiveKanbanBoardElement();
    if (!board) {
      new Notice('⚠️ No active Kanban board found - open a Kanban board first', 5000);
      return;
    }
    const items = board.querySelectorAll<HTMLElement>(ITEM_SELECTOR);
    new Notice(`Found ${items.length} cards in active Kanban board`, 3000);
    for (const item of Array.from(items)) {
      if (item.querySelector('a.internal-link')) {
        new Notice(`Testing with card: "${item.textContent?.substring(0, 20) ?? ''}..."`, 3000);
        this.processKanbanItem(item);
        return;
      }
    }
  }
}

class KanbanStatusUpdaterSettingTab extends PluginSettingTab {
  plugin: KanbanStatusUpdaterPlugin;

  constructor(app: App, plugin: KanbanStatusUpdaterPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const {containerEl} = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Status property name')
      .setDesc('The name of the property to update when a card is moved')
      .addText(text => text
        .setPlaceholder('status')
        .setValue(this.plugin.settings.statusPropertyName)
        .onChange(async (value) => {
          this.plugin.settings.statusPropertyName = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Show notifications')
      .setDesc('Show a notification when a status is updated')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showNotifications)
        .onChange(async (value) => {
          this.plugin.settings.showNotifications = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Debug mode')
      .setDesc('Enable detailed logging (reduces performance)')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.debugMode)
        .onChange(async (value) => {
          this.plugin.settings.debugMode = value;
          await this.plugin.saveSettings();
          new Notice(value ? 'Debug mode enabled - check console for logs' : 'Debug mode disabled', 3000);
        }));

    new Setting(containerEl)
      .setName('Test plugin')
      .setDesc('Test with current Kanban board')
      .addButton(button => button
        .setButtonText('Run Test')
        .onClick(() => this.plugin.runTest()));
  }
}
