import type { AppState, ToolbarBlockDef, ToolbarBlockState } from '../types';

const CURRENT_VERSION = '1.1';

// ── Configurable storage (§8) ─────────────────────────────────────────────
//
// Every "where do we read/write" value the serialiser used to hardcode lives
// in this single config object. Single-app hosts can ignore it entirely; the
// defaults reproduce the framework's historical behaviour byte-for-byte.
//
// Multi-app hosts (e.g. a router mounting several MDI shells under one page)
// call `configureLayoutStorage()` before mounting a shell to isolate each
// app's persistence under its own keys and data paths.

export interface LayoutStorageConfig {
  /** localStorage key for the full AppState JSON. Default: 'mdi:layout' */
  storageKey: string;
  /** localStorage key for the active theme. Default: 'mdi:theme' */
  themeKey: string;
  /** Public URL of the initial layout JSON. Default: '/data/layout/default_layout.json' */
  defaultLayoutPath: string;
  /** Public URL of the toolbar manifest JSON. Default: '/data/toolbars/toolbar_manifest.json' */
  toolbarManifestPath: string;
  /** Identifier baked into user-saved layout files. Default: 'mdi-framework' */
  appId: string;
  /** Filename prefix for user-saved layout files (`<prefix>-<timestamp>.json`). Default: 'mdi-layout' */
  fileNamePrefix: string;
}

const DEFAULT_CONFIG: LayoutStorageConfig = {
  storageKey:          'mdi:layout',
  themeKey:            'mdi:theme',
  defaultLayoutPath:   '/data/layout/default_layout.json',
  toolbarManifestPath: '/data/toolbars/toolbar_manifest.json',
  appId:               'mdi-framework',
  fileNamePrefix:      'mdi-layout',
};

let _config: LayoutStorageConfig = { ...DEFAULT_CONFIG };

/**
 * Replace the layout-storage configuration **wholesale**.
 *
 * The defaults are applied first and the caller's `overrides` are then merged
 * on top, so previous-call settings cannot leak into the new configuration —
 * this is intentional and important for multi-app hosts that switch shells.
 *
 * Call this once per shell mount, *before* `loadInitialState()` (or any other
 * persistence-aware function) runs. Safe to call repeatedly.
 */
export function configureLayoutStorage(overrides: Partial<LayoutStorageConfig> = {}): void {
  _config = { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Read the active layout-storage configuration. Useful for cross-tab listeners
 * (e.g. the popout window's `storage` event handler) that need to know which
 * key is currently in use.
 */
export function getLayoutStorageConfig(): Readonly<LayoutStorageConfig> {
  return _config;
}

// ── Fetch helpers ────────────────────────────────────────────────────────

async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Load toolbar blocks (manifest + individual files) ────────────────────

async function loadToolbarBlocks(
  manifestPath: string,
  blockOrder: string[],
  blockDefs: Record<string, ToolbarBlockDef>
): Promise<{ blockOrder: string[]; blocks: Record<string, ToolbarBlockState> }> {
  const blocks: Record<string, ToolbarBlockState> = {};

  // Load items for each block
  for (const id of blockOrder) {
    const def = blockDefs[id];
    if (!def) continue;
    try {
      const items = await fetchJSON<ToolbarBlockState['items']>(
        `/data/toolbars/${def.menuFile}`
      );
      blocks[id] = {
        ...def,
        alignment: def.alignment ?? 'left',
        labelMode: def.labelMode ?? 'icon-title',
        items,
      };
    } catch (e) {
      console.warn(`Failed to load toolbar block ${id}:`, e);
      blocks[id] = {
        ...def,
        alignment: def.alignment ?? 'left',
        labelMode: def.labelMode ?? 'icon-title',
        items: [],
      };
    }
  }

  return { blockOrder, blocks };
}

// ── Build AppState from layout JSON ─────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildStateFromLayout(layout: any): Promise<AppState> {
  // Build document map — ensure new fields have defaults
  const documents: AppState['documents'] = {};
  for (const doc of layout.documents ?? []) {
    documents[doc.instanceId] = {
      floating: null,
      poppedOut: false,
      ...doc,
    };
  }

  // Load toolbar blocks
  const tb = layout.mainToolbar;
  const toolbar = await loadToolbarBlocks(
    _config.toolbarManifestPath,
    tb.blockOrder,
    tb.blocks
  );

  return {
    theme: 'dark',
    mdi: layout.workspace,
    toolbar,
    statusBar: {
      ...layout.statusBar,
      // Always start with no active interrupt regardless of what was persisted.
      interruptText: null,
      interruptDuration: null,
    },
    documents,
    modals: [],
    floatZCounter: 0,
  };
}

// ── Version migration (§8.3) ─────────────────────────────────────────────

/**
 * Apply incremental migrations to a stored `{ version, state }` object so
 * layouts persisted by older app versions survive upgrades.
 *
 * HOW TO ADD A MIGRATION (e.g. 1.0 → 1.1):
 *   1. Write a pure `migrate_1_0_to_1_1(state: any): any` function.
 *   2. Add the block below: `if (version === '1.0') { state = migrate_1_0_to_1_1(state); version = '1.1'; }`
 *   3. Bump CURRENT_VERSION to '1.1'.
 *
 * Returns the (possibly transformed) state object ready for hydration.
 * Throws if the version string is unrecognised; caller falls back to the default layout.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrate_1_0_to_1_1(state: any): any {
  // Add floating panel and modal fields introduced in v1.1
  const documents: Record<string, unknown> = {};
  for (const [id, doc] of Object.entries(state.documents ?? {})) {
    documents[id] = { floating: null, poppedOut: false, ...(doc as object) };
  }
  return {
    ...state,
    documents,
    modals: state.modals ?? [],
    floatZCounter: state.floatZCounter ?? 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function migrateIfNeeded(parsed: { version: string; state: unknown }): any {
  let { version, state } = parsed;

  if (version === '1.0') { state = migrate_1_0_to_1_1(state); version = '1.1'; }

  if (version !== CURRENT_VERSION) {
    throw new Error(
      `Unsupported layout version: "${version}" (current: "${CURRENT_VERSION}"). ` +
      'Stored layout will be discarded and the default will be loaded.',
    );
  }

  return state;
}

// ── Orphaned document recovery ────────────────────────────────────────────
//
// When floating or popped-out documents are serialised, they are removed from
// their container's documentIds array.  On reload we clear floating/poppedOut,
// but the docs are still missing from all containers — unreachable.
// This function detects those orphans and either:
//   a) re-inserts them into their original container (via closedState), or
//   b) marks them visible=false so the Window menu can surface them.

function restoreOrphanedDocuments(state: AppState): AppState {
  // Build a set of every docId currently referenced by a container
  const docIdsInContainers = new Set<string>();
  for (const row of [state.mdi.topRow, state.mdi.bottomRow]) {
    for (const container of row.containers) {
      for (const id of container.documentIds) {
        docIdsInContainers.add(id);
      }
    }
  }

  // Find orphaned docs: visible, not floating, not poppedOut, not in any container
  const orphans = Object.values(state.documents).filter(
    doc => doc.visible && !doc.floating && !doc.poppedOut && !docIdsInContainers.has(doc.instanceId)
  );

  if (orphans.length === 0) return state;

  // Clone state pieces we may mutate
  const newDocs = { ...state.documents };
  const topContainers    = state.mdi.topRow.containers.map(c => ({ ...c, documentIds: [...c.documentIds] }));
  const bottomContainers = state.mdi.bottomRow.containers.map(c => ({ ...c, documentIds: [...c.documentIds] }));

  for (const orphan of orphans) {
    const cs = orphan.closedState;
    let restored = false;

    if (cs) {
      // Try to find the original container by id in the correct row
      const containers = cs.rowId === 'row-top' ? topContainers : bottomContainers;
      const container = containers.find(c => c.id === cs.containerId);
      if (container) {
        // Re-insert at the original index (clamped to current length)
        const insertAt = Math.min(cs.containerIndex, container.documentIds.length);
        container.documentIds.splice(insertAt, 0, orphan.instanceId);
        // If the container has no active document, make this one active
        if (!container.activeDocumentId) container.activeDocumentId = orphan.instanceId;
        newDocs[orphan.instanceId] = { ...orphan, closedState: null };
        restored = true;
      }
    }

    if (!restored) {
      // Container gone — hide the doc so Window > Closed Windows can restore it later
      newDocs[orphan.instanceId] = { ...orphan, visible: false };
    }
  }

  return {
    ...state,
    documents: newDocs,
    mdi: {
      ...state.mdi,
      topRow:    { ...state.mdi.topRow,    containers: topContainers },
      bottomRow: { ...state.mdi.bottomRow, containers: bottomContainers },
    },
  };
}

// ── Public API ───────────────────────────────────────────────────────────

export async function loadInitialState(): Promise<AppState> {
  // 1. Try localStorage
  const stored = localStorage.getItem(_config.storageKey);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (parsed.version && parsed.state) {
        // Apply incremental migrations, then reload toolbar items (not serialised).
        const state = migrateIfNeeded(parsed) as AppState;
        const tbOrder = state.toolbar.blockOrder;
        const tbDefs: Record<string, ToolbarBlockDef> = {};
        for (const id of tbOrder) {
          const b = state.toolbar.blocks[id];
          if (b) tbDefs[id] = {
            id: b.id,
            title: b.title,
            menuFile: b.menuFile,
            visible: b.visible,
            disabled: b.disabled,
            alignment: b.alignment,
            labelMode: b.labelMode,
          };
        }
        const toolbar = await loadToolbarBlocks(_config.toolbarManifestPath, tbOrder, tbDefs);
        const theme = (localStorage.getItem(_config.themeKey) as 'dark' | 'light') ?? 'dark';
        const typedState = state as AppState;

        // Restore floating panels at their saved geometry.
        // Popped-out panels can't reopen browser windows automatically — demote
        // them to floating so they're immediately accessible.
        let poppedOutIdx = 0;
        const restoredDocs = Object.fromEntries(
          Object.entries(typedState.documents).map(([id, doc]) => {
            if (doc.floating) {
              // Was floating — keep position, just make sure poppedOut is clear
              return [id, { ...doc, poppedOut: false }];
            }
            if (doc.poppedOut) {
              // Was popped-out — restore as floating with sensible geometry
              const offset = (poppedOutIdx++) * 30;
              return [id, {
                ...doc,
                poppedOut: false,
                floating: {
                  x: 120 + offset,
                  y: 100 + offset,
                  width: 720,
                  height: 520,
                  zIndex: 1 + poppedOutIdx,
                  minimized: false,
                },
              }];
            }
            return [id, doc];
          })
        );

        const rawState: AppState = {
          ...typedState,
          toolbar,
          theme,
          documents: restoredDocs,
          modals: [],
          floatZCounter: typedState.floatZCounter ?? 0,
        };
        return restoreOrphanedDocuments(rawState);
      }
    } catch (e) {
      console.warn('Failed to parse stored layout, using default:', e);
    }
  }

  // 2. Load default layout
  const layout = await fetchJSON(_config.defaultLayoutPath);
  const state = await buildStateFromLayout(layout);
  const theme = (localStorage.getItem(_config.themeKey) as 'dark' | 'light') ?? 'dark';
  return { ...state, theme };
}

export function persistState(state: AppState): void {
  try {
    // Strip toolbar items (they'll be re-fetched on load) but retain all other block fields
    const blocksStripped: Record<string, ToolbarBlockDef> = {};
    for (const [id, b] of Object.entries(state.toolbar.blocks)) {
      blocksStripped[id] = {
        id: b.id,
        title: b.title,
        menuFile: b.menuFile,
        visible: b.visible,
        disabled: b.disabled,
        alignment: b.alignment,
        labelMode: b.labelMode,
      };
    }
    const toStore = {
      version: CURRENT_VERSION,
      state: {
        ...state,
        toolbar: { blockOrder: state.toolbar.blockOrder, blocks: blocksStripped },
      },
    };
    localStorage.setItem(_config.storageKey, JSON.stringify(toStore));
    localStorage.setItem(_config.themeKey, state.theme);
  } catch (e) {
    console.warn('Failed to persist state:', e);
  }
}

export function clearStoredState(): void {
  localStorage.removeItem(_config.storageKey);
}

export function saveLayoutToFile(state: AppState): void {
  const blocksStripped: Record<string, ToolbarBlockDef> = {};
  for (const [id, b] of Object.entries(state.toolbar.blocks)) {
    blocksStripped[id] = {
      id: b.id,
      title: b.title,
      menuFile: b.menuFile,
      visible: b.visible,
      disabled: b.disabled,
      alignment: b.alignment,
      labelMode: b.labelMode,
    };
  }

  const snapshot = {
    version: CURRENT_VERSION,
    appId: _config.appId,
    savedAt: new Date().toISOString(),
    description: 'User layout snapshot',
    workspace: state.mdi,
    mainToolbar: {
      blockOrder: state.toolbar.blockOrder,
      blocks: blocksStripped,
    },
    statusBar: state.statusBar,
    documents: Object.values(state.documents),
  };

  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${_config.fileNamePrefix}-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function loadLayoutFromFile(): Promise<AppState> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { reject(new Error('No file selected')); return; }
      try {
        const text = await file.text();
        const layout = JSON.parse(text);
        // TODO: validate that `layout` conforms to the expected schema (version,
        // workspace, documents, mainToolbar, statusBar) before building state.
        // On validation failure, reject with a descriptive error and surface it
        // via an error popup (to be implemented as a separate task).
        const state = await buildStateFromLayout(layout);
        resolve(state);
      } catch (e) {
        reject(e);
      }
    };
    input.click();
  });
}
