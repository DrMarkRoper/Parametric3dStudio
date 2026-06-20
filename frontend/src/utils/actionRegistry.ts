/**
 * Action handlers may be synchronous (returning anything, including `void`)
 * or asynchronous (returning a `Promise`). The return value is forwarded
 * by `invoke()` so callers can opt into async-aware behaviour — currently
 * used by `ModalDialog` to support `closesModal: 'on-success'`.
 *
 * Existing handlers that return nothing are unaffected: `void` is assignable
 * to `unknown`, and callers that ignore the return value continue to work.
 */
type ActionHandler = (args?: Record<string, unknown>) => unknown;

const registry = new Map<string, ActionHandler>();

export const actionRegistry = {
  register(name: string, handler: ActionHandler) {
    registry.set(name, handler);
  },
  unregister(name: string) {
    registry.delete(name);
  },
  /**
   * Invoke a registered action and return its result.
   *
   * Returns whatever the handler returns (often `undefined`, but may be a
   * `Promise` for async handlers). Returns `undefined` when no handler is
   * registered under `name`.
   *
   * Most callers can safely ignore the return value — it is exposed so
   * close-on-success-style callers can await async completion.
   */
  invoke(name: string, args?: Record<string, unknown>): unknown {
    const handler = registry.get(name);
    if (handler) {
      return handler(args);
    }
    console.log(`[ActionRegistry] No handler for: "${name}"`, args ?? '');
    return undefined;
  },
  has(name: string) {
    return registry.has(name);
  },
};
