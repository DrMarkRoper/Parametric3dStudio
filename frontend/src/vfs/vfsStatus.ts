/**
 * vfsStatus — tracks whether the VFS application is "ready": the server is
 * reachable AND the application's default config ('config') has at least one
 * root. This gates the Open / Save / Save As menu items.
 *
 * It's an external store (React `useSyncExternalStore`) so menus re-render when
 * the status changes. Refresh it on app load and whenever the Application
 * Settings (connection) change.
 */
import { useSyncExternalStore } from 'react';
import { isVfsConfigured, listProjectRoots } from './vfsAdmin';

/** The application-level config key whose roots back Open + the default save. */
export const APP_CONFIG_KEY = 'config';

let appReady = false;
const listeners = new Set<() => void>();

function emit() { listeners.forEach((l) => l()); }

/** Current readiness (server up + application 'config' has ≥1 root). */
export function getVfsAppReady(): boolean {
  return appReady;
}

/**
 * Re-probe readiness. Resolves to the new value. Never throws — a server that's
 * down / unconfigured / has no 'config' roots simply yields `false`.
 */
export async function refreshVfsStatus(): Promise<boolean> {
  let next = false;
  if (isVfsConfigured()) {
    try {
      const roots = await listProjectRoots(APP_CONFIG_KEY);
      next = roots.length > 0;
    } catch {
      next = false;
    }
  }
  if (next !== appReady) {
    appReady = next;
    emit();
  }
  return next;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** React hook: subscribe to VFS application readiness. */
export function useVfsAppReady(): boolean {
  return useSyncExternalStore(subscribe, getVfsAppReady, getVfsAppReady);
}
