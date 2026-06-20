/**
 * Keyboard shortcut registry — §7.1
 *
 * Shortcuts are auto-populated from menu JSON via `registerShortcutsFromMenu`.
 * A single global `handleGlobalKeyDown` handler dispatches matched shortcuts
 * through the action registry, replacing the ad-hoc hardcoded listeners in App.tsx.
 */

import type { MenuItem, MenuRootItem } from '../types';

// ── Internal types ───────────────────────────────────────────────────────

interface ShortcutDef {
  action: string;
  actionArgs?: Record<string, unknown>;
}

// ── Registry store ───────────────────────────────────────────────────────

// Key format: "ctrl+s", "ctrl+shift+t", "alt+f4", etc.
const registry = new Map<string, ShortcutDef>();

// ── Key string builder ───────────────────────────────────────────────────

function buildKeyString(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(e.key.toLowerCase());
  return parts.join('+');
}

function shortcutKeyToString(sk: NonNullable<MenuItem['shortcutKey']>): string {
  const parts: string[] = [];
  if (sk.ctrl) parts.push('ctrl');
  if (sk.shift) parts.push('shift');
  if (sk.alt) parts.push('alt');
  parts.push(sk.key.toLowerCase());
  return parts.join('+');
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Recursively walk `items` and register every item that has both
 * a `shortcutKey` and an `action` into the shortcut registry.
 *
 * Call once per menu root after loading the menu JSON:
 *   ```ts
 *   for (const root of menuDef) registerShortcutsFromMenu(root.children);
 *   ```
 */
export function registerShortcutsFromMenu(items: MenuItem[]): void {
  for (const item of items) {
    if (item.shortcutKey && item.action) {
      const key = shortcutKeyToString(item.shortcutKey);
      registry.set(key, { action: item.action, actionArgs: item.actionArgs });
    }
    if (item.children?.length) {
      registerShortcutsFromMenu(item.children);
    }
  }
}

/**
 * Convenience helper to register shortcuts from the top-level menu definition
 * (array of root items, each with a `children` array).
 */
export function registerShortcutsFromMenuDef(menuDef: MenuRootItem[]): void {
  for (const root of menuDef) {
    registerShortcutsFromMenu(root.children);
  }
}

/**
 * Wipe every entry from the shortcut registry.
 *
 * Single-app hosts never need this — the registry is populated once at startup
 * and lives for the page's lifetime.
 *
 * Multi-app hosts (e.g. a router that mounts a different MDI shell per route)
 * call this on shell teardown, *before* re-registering shortcuts for the next
 * app, so stale entries from the previous app's menu cannot fire after
 * navigation.
 */
export function clearShortcuts(): void {
  registry.clear();
}

/**
 * Global keydown handler.  Attach once in App.tsx:
 *   ```ts
 *   window.addEventListener('keydown', e =>
 *     handleGlobalKeyDown(e, actionRegistry.invoke.bind(actionRegistry))
 *   );
 *   ```
 */
export function handleGlobalKeyDown(
  e: KeyboardEvent,
  invoke: (action: string, args?: Record<string, unknown>) => void,
): void {
  const key = buildKeyString(e);
  const def = registry.get(key);
  if (def) {
    e.preventDefault();
    invoke(def.action, def.actionArgs);
  }
}
