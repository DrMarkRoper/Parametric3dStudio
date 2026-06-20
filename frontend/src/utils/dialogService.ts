// ── Dialog Service ────────────────────────────────────────────────────────
// Imperative API for opening alert, confirm, and input dialogs via the
// existing modal stack (state.modals / OPEN_MODAL action).
//
// Usage:
//   import * as dialogService from './utils/dialogService';
//
//   dialogService.showAlert({ title: 'Oops', message: 'Something went wrong', mode: 'error' });
//
//   dialogService.showConfirm({
//     message: 'Delete this file?',
//     mode: 'warning',
//     buttons: 'yes-no',
//     onResult: r => { if (r.button === 'Yes') doDelete(); },
//   });
//
//   dialogService.showInput({
//     title: 'Rename',
//     message: 'Enter a new name:',
//     inputType: 'text',
//     required: true,
//     onResult: r => { if (r.button === 'OK') rename(r.value as string); },
//   });
//
// Wire-up: call setDialogDispatch(dispatch) once on app mount (App.tsx).
// Register the '_dialogResult' action in actionRegistry (also App.tsx).
// ─────────────────────────────────────────────────────────────────────────

import type { AppAction, ModalButton } from '../types';

// ── Public types ──────────────────────────────────────────────────────────

/** Icon variant shown next to the dialog message. */
export type DialogMode = 'info' | 'question' | 'warning' | 'error';

/**
 * Imperative handle returned (via the onResult callback) when keepOpen is true.
 * Lets the caller programmatically close the dialog, display an error, or
 * update the field value without reopening the dialog.
 */
export interface DialogController {
  /** Close the dialog from the callback. */
  close(): void;
  /** Show an error message inside the dialog. Pass '' to clear. */
  setError(msg: string): void;
  /** Replace the current input value (string for text/select; string[] for multi-listbox). */
  setValue(val: string | string[]): void;
}

/**
 * Preset button arrangements.
 * Buttons are always rendered right-aligned, in the order listed here.
 * The rightmost button carries variant 'primary'.
 */
export type ButtonPreset =
  | 'ok'
  | 'ok-cancel'
  | 'yes-no'
  | 'yes-no-cancel'
  | 'retry-cancel'
  | 'abort-retry-ignore';

/** Type of data the InputDialog collects.  Default: 'text' */
export type InputFieldType = 'text' | 'number' | 'integer' | 'float' | 'email' | 'url';

/** Widget used to collect input. */
export type InputWidgetType = 'text' | 'select' | 'listbox';

/** Key/value pair for select and listbox options. */
export interface SelectOption {
  key: string;
  value: string;
}

/** Delivered to every dialog callback on close. */
export interface DialogResult {
  /** Label of the button that was pressed (or 'Close' when × is clicked). */
  button: string;
  /**
   * Only set for InputDialog with a confirmed result.
   * string for text/number/select/single-listbox.
   * string[] for multi-select listbox.
   * undefined for cancel / dismiss.
   */
  value?: string | string[];
}

// ── AlertOptions ──────────────────────────────────────────────────────────

export interface AlertOptions {
  /** Dialog title.  Default: 'Alert' */
  title?: string;
  /** Body message. */
  message: string;
  /** Optional icon variant. */
  mode?: DialogMode;
  /** Called when the OK button is pressed. */
  onClose?: (result: DialogResult) => void;
}

// ── ConfirmOptions ────────────────────────────────────────────────────────

export interface ConfirmOptions {
  /** Dialog title.  Default: 'Confirm' */
  title?: string;
  /** Body message. */
  message: string;
  /** Optional icon variant. */
  mode?: DialogMode;
  /** Button set to show.  Default: 'ok-cancel' */
  buttons?: ButtonPreset;
  /** Called when any button is pressed (or the × button). */
  onResult?: (result: DialogResult) => void;
}

// ── InputOptions ──────────────────────────────────────────────────────────

export interface InputOptions {
  /** Dialog title.  Default: 'Input' */
  title?: string;
  /** Prompt message displayed above the input widget. */
  message?: string;
  /** Optional icon variant. */
  mode?: DialogMode;
  /**
   * Data type for the input field.  Default: 'text'
   * Affects keyboard filtering, validation, and the HTML input type used.
   */
  inputType?: InputFieldType;
  /**
   * Widget style.  Default: 'text' (or 'select' when options are provided).
   * 'text'    — <input> field (plain, number, integer, float, email, url)
   * 'select'  — <select> dropdown
   * 'listbox' — <select size=N> scrollable list
   */
  widgetType?: InputWidgetType;
  /** Require a non-empty value before the OK button is accepted. */
  required?: boolean;
  /** Minimum value for integer / float / number fields. */
  min?: number;
  /** Maximum value for integer / float / number fields. */
  max?: number;
  /** Pre-filled value.  Use string[] only for multi-select listbox. */
  defaultValue?: string | string[];
  /** Placeholder text shown when the field is empty. */
  placeholder?: string;
  /** Options for 'select' and 'listbox' widget types. */
  options?: SelectOption[];
  /** Allow multi-selection in a listbox. Default: false */
  multiple?: boolean;
  /** Label for the confirm button.  Default: 'OK' */
  okLabel?: string;
  /** Label for the dismiss button.  Default: 'Cancel' */
  cancelLabel?: string;
  /**
   * When true, neither the OK nor the Cancel button closes the dialog automatically.
   * Instead, both deliver their result to onResult along with a DialogController,
   * allowing async validation, error display, and programmatic close/value updates.
   * Default: false
   */
  keepOpen?: boolean;
  /**
   * Called when any button is pressed (or × is clicked).
   *
   * When keepOpen is false (default):
   *   result.value is set only when OK is pressed and validation passes;
   *   controller is undefined.
   *
   * When keepOpen is true:
   *   Both OK and Cancel deliver results here.  The second argument is a
   *   DialogController you can use to close(), setError(), or setValue()
   *   from async code.
   */
  onResult?: (result: DialogResult, controller?: DialogController) => void;
}

// ── Internal state ────────────────────────────────────────────────────────

type DispatchFn = (action: AppAction) => void;

/** Pending result callbacks for one-shot dialogs (consumed on delivery). */
const _callbacks = new Map<string, (result: DialogResult) => void>();

/**
 * Persistent callbacks for keepOpen dialogs (NOT consumed on delivery —
 * the dialog may call these multiple times).
 */
const _keepOpenCallbacks = new Map<string, (result: DialogResult, controller: DialogController) => void>();

/** Controller implementations registered by InputDialog on mount. */
const _controllers = new Map<string, DialogController>();

let _dispatch: DispatchFn | null = null;
let _seq = 0;

// ── Internal helpers ──────────────────────────────────────────────────────

function genKey(): string {
  return `dlg-${Date.now()}-${++_seq}`;
}

function resolveButtons(preset: ButtonPreset): Array<{ label: string; variant?: 'default' | 'primary' | 'danger' }> {
  switch (preset) {
    case 'ok':
      return [{ label: 'OK', variant: 'primary' }];
    case 'ok-cancel':
      return [{ label: 'Cancel' }, { label: 'OK', variant: 'primary' }];
    case 'yes-no':
      return [{ label: 'No' }, { label: 'Yes', variant: 'primary' }];
    case 'yes-no-cancel':
      return [{ label: 'Cancel' }, { label: 'No' }, { label: 'Yes', variant: 'primary' }];
    case 'retry-cancel':
      return [{ label: 'Cancel' }, { label: 'Retry', variant: 'primary' }];
    case 'abort-retry-ignore':
      return [
        { label: 'Abort', variant: 'danger' },
        { label: 'Retry', variant: 'primary' },
        { label: 'Ignore' },
      ];
  }
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Wire the Redux-like dispatch function into the service.
 * Call once in App.tsx after the AppStateContext is available.
 */
export function setDialogDispatch(dispatch: DispatchFn): void {
  _dispatch = dispatch;
}

/**
 * Deliver a dialog result.  Called by the '_dialogResult' actionRegistry handler
 * (button presses) or directly by InputDialog on validated submit.
 * Cleans up the stored callback on delivery.
 */
export function invokeDialogCallback(callbackKey: string, result: DialogResult): void {
  const cb = _callbacks.get(callbackKey);
  _callbacks.delete(callbackKey);
  cb?.(result);
}

/**
 * Register the controller implementation created by InputDialog on mount.
 * Called internally by InputDialog — not part of the public consumer API.
 */
export function registerDialogController(key: string, controller: DialogController): void {
  _controllers.set(key, controller);
}

/**
 * Remove a keepOpen dialog's controller.
 * Called internally by InputDialog on unmount via effect cleanup.
 * NOTE: _keepOpenCallbacks is intentionally NOT cleared here — React StrictMode
 * runs effect cleanups between its double-invoke cycles, so clearing the callback
 * at cleanup time would erase it before the re-mount can use it.  The callback
 * is removed when the dialog closes via controller.close() instead.
 */
export function unregisterDialogController(key: string): void {
  _controllers.delete(key);
}

/**
 * Remove a keepOpen dialog's callback.
 * Called by the controller's close() method immediately before closing the modal,
 * so the entry is cleaned up exactly once on actual dismissal.
 */
export function cleanupKeepOpenCallback(key: string): void {
  _keepOpenCallbacks.delete(key);
}

/**
 * Deliver a result to a keepOpen dialog's callback, passing the controller.
 * The callback is NOT consumed — the dialog may call this multiple times.
 * Called by InputDialog's submit / cancel action handlers.
 */
export function invokeKeepOpenCallback(callbackKey: string, result: DialogResult): void {
  const cb   = _keepOpenCallbacks.get(callbackKey);
  const ctrl = _controllers.get(callbackKey);
  if (cb && ctrl) cb(result, ctrl);
}

// ── showAlert ─────────────────────────────────────────────────────────────

/**
 * Open a simple alert box.
 * Shows an optional mode icon, a message, and a single OK button.
 * No × close button — only the OK button (or Enter key) dismisses it.
 */
export function showAlert(opts: AlertOptions): void {
  if (!_dispatch) { console.warn('dialogService: dispatch not set — did you call setDialogDispatch?'); return; }

  const key = genKey();
  if (opts.onClose) _callbacks.set(key, opts.onClose);

  _dispatch({
    type: 'OPEN_MODAL',
    modal: {
      title: opts.title ?? 'Alert',
      componentType: 'AlertDialog',
      allowClose: false,
      allowResize: false,
      width: 360,
      props: { message: opts.message, mode: opts.mode, callbackKey: key },
      buttons: [
        {
          label: 'OK',
          variant: 'primary',
          alignment: 'right',
          action: '_dialogResult',
          args: { callbackKey: key, button: 'OK' },
          closesModal: true,
          keys: ['Enter'],
        } satisfies ModalButton,
      ],
    },
  });
}

// ── showConfirm ───────────────────────────────────────────────────────────

/**
 * Open a confirmation dialog.
 * Shows an optional mode icon, a message, and a preset button arrangement.
 * No × close button. Enter triggers the primary button; Escape triggers the
 * first non-danger, non-primary button (the natural "cancel" position).
 * If no such button exists for a key, that key has no effect.
 */
export function showConfirm(opts: ConfirmOptions): void {
  if (!_dispatch) { console.warn('dialogService: dispatch not set'); return; }

  const key    = genKey();
  const preset = resolveButtons(opts.buttons ?? 'ok-cancel');

  if (opts.onResult) _callbacks.set(key, opts.onResult);

  // Identify which position in the preset gets Enter vs Escape.
  // Primary (rightmost) → Enter.
  // First non-danger, non-primary (natural cancel position) → Escape.
  // findLastIndex isn't in ES2020 — scan from the right manually.
  const primaryIdx = preset.reduce((found, b, i) => b.variant === 'primary' ? i : found, -1);
  const cancelIdx  = preset.findIndex(b => b.variant !== 'primary' && b.variant !== 'danger');

  _dispatch({
    type: 'OPEN_MODAL',
    modal: {
      title: opts.title ?? 'Confirm',
      componentType: 'ConfirmDialog',
      allowClose: false,
      allowResize: false,
      width: 380,
      props: { message: opts.message, mode: opts.mode, callbackKey: key },
      buttons: preset.map((btn, i) => ({
        label:       btn.label,
        variant:     btn.variant,
        alignment:   'right' as const,
        action:      '_dialogResult',
        args:        { callbackKey: key, button: btn.label },
        closesModal: true,
        keys:        [
          ...(i === primaryIdx ? ['Enter']  : []),
          ...(i === cancelIdx  ? ['Escape'] : []),
        ],
      } satisfies ModalButton)),
    },
  });
}

// ── showInput ─────────────────────────────────────────────────────────────

/**
 * Open an input dialog.
 *
 * The OK button (label configurable via okLabel) validates the current value
 * before closing; if validation fails, an error message is shown and the dialog
 * stays open.  All other buttons dismiss immediately and deliver
 * { button: label, value: undefined } to the callback.
 *
 * result.value is:
 *   string       — text / number / email / url / select / single listbox
 *   string[]     — multi-select listbox
 *   undefined    — cancel / × close
 */
export function showInput(opts: InputOptions): void {
  if (!_dispatch) { console.warn('dialogService: dispatch not set'); return; }

  const key         = genKey();
  const okLabel     = opts.okLabel     ?? 'OK';
  const cancelLabel = opts.cancelLabel ?? 'Cancel';
  const keepOpen    = opts.keepOpen    ?? false;

  // Derive widget type: explicit or infer from options presence
  const widgetType: InputWidgetType =
    opts.widgetType ?? (opts.options ? 'select' : 'text');

  // Store callback in the appropriate map
  if (opts.onResult) {
    if (keepOpen) {
      _keepOpenCallbacks.set(key, opts.onResult as (r: DialogResult, c: DialogController) => void);
    } else {
      _callbacks.set(key, opts.onResult as (r: DialogResult) => void);
    }
  }

  // The OK button triggers a per-dialog submit action registered by InputDialog.
  // This lets InputDialog validate before deciding whether to close.
  const submitActionKey  = `_inputDialog:${key}`;
  // Cancel action key — only used when keepOpen so InputDialog can deliver the callback.
  const cancelActionKey  = keepOpen ? `_inputDialogCancel:${key}` : undefined;

  // Enter binding on the OK button is only safe for non-listbox widgets
  // (listbox uses Enter natively for selection within the list).
  const okEnterKey = widgetType !== 'listbox' ? ['Enter'] : [];

  // Build button bar.
  //   Normal mode  — Cancel closes immediately; OK validates then closes.
  //   keepOpen     — Neither button auto-closes.  InputDialog handles both actions
  //                  and delivers results to the callback with the controller.
  const buttons: ModalButton[] = [
    {
      label:       cancelLabel,
      variant:     undefined,
      alignment:   'right' as const,
      action:      keepOpen ? cancelActionKey : '_dialogResult',
      args:        keepOpen ? undefined : { callbackKey: key, button: cancelLabel },
      closesModal: !keepOpen,
      keys:        ['Escape'],
    } satisfies ModalButton,
    {
      label:       okLabel,
      variant:     'primary',
      alignment:   'right' as const,
      action:      submitActionKey,
      args:        undefined,
      closesModal: false,   // InputDialog controls close after validation
      keys:        okEnterKey,
    } satisfies ModalButton,
  ];

  _dispatch({
    type: 'OPEN_MODAL',
    modal: {
      title:         opts.title ?? 'Input',
      componentType: 'InputDialog',
      allowClose:    false,
      allowResize:   false,
      width:         420,
      buttons,
      props: {
        message:      opts.message,
        mode:         opts.mode,
        inputType:    opts.inputType ?? 'text',
        widgetType,
        required:     opts.required  ?? false,
        min:          opts.min,
        max:          opts.max,
        defaultValue: opts.defaultValue,
        placeholder:  opts.placeholder,
        options:      opts.options,
        multiple:     opts.multiple  ?? false,
        callbackKey:  key,
        keepOpen,
        submitAction: submitActionKey,
        cancelAction: cancelActionKey,
        okLabel,
        cancelLabel,
      },
    },
  });
}
