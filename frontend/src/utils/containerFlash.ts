/**
 * Lightweight flash signal — no React state, no context.
 *
 * Two mechanisms:
 *  1. emitFlash(instanceId)   – direct container flash (used for SET_ACTIVE_DOCUMENT)
 *  2. setPendingFlashDoc / peekPendingFlashDoc / clearPendingFlashDoc
 *     – "pending by doc id" flash (used for RESTORE_DOCUMENT, where the target
 *       container id is only known after the reducer runs and the component
 *       re-renders with its updated documentIds)
 */

type Listener = (instanceId: string) => void;
const listeners = new Set<Listener>();

let pendingDocId: string | null = null;

/** Fire a flash on a specific container. */
export function emitFlash(instanceId: string): void {
  listeners.forEach(l => l(instanceId));
}

/** Register a listener; returns an unsubscribe function. */
export function subscribeFlash(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Set a pending flash keyed by doc instanceId (call BEFORE dispatching restore). */
export function setPendingFlashDoc(docId: string): void {
  pendingDocId = docId;
}

/** Read without clearing — safe to call from multiple components. */
export function peekPendingFlashDoc(): string | null {
  return pendingDocId;
}

/** Clear the pending id; call only when matched. */
export function clearPendingFlashDoc(): void {
  pendingDocId = null;
}
