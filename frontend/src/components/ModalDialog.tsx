import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModalButton, ModalState } from '../types';
import { useAppState } from '../contexts/AppStateContext';
import { actionRegistry } from '../utils/actionRegistry';
import {
  cleanupKeepOpenCallback,
  invokeDialogCallback,
  invokeKeepOpenCallback,
  registerDialogController,
  unregisterDialogController,
} from '../utils/dialogService';
import type { DialogController, DialogMode, InputFieldType, InputWidgetType, SelectOption } from '../utils/dialogService';
import {
  DEFAULT_APPLICATION_ID,
  checkConnection,
  loadVfsConfig,
  saveVfsConfig,
  type ConnectionResult,
} from '../vfs/vfsClient';
import { ProjectDetailsModal } from './panels/ProjectDetailsModal';
import { AddRootModal } from './panels/AddRootModal';

// ── Button bar ─────────────────────────────────────────────────────────────

/**
 * Run a modal button: invoke its action (if any), then apply its `closesModal`
 * policy.
 *
 *   `true`         — close synchronously after the invoke call returns,
 *                    regardless of any thrown error or rejected promise.
 *   `'on-success'` — wrap the invoke result in `Promise.resolve(...)` and
 *                    close only when the promise resolves. A rejection or
 *                    thrown error leaves the modal open so the handler can
 *                    surface a validation error inline.
 *   `false` / omitted — never close (action handles close itself).
 *
 * Shared by mouse-click and keyboard-shortcut button handling so both paths
 * have identical semantics.
 */
function runModalButton(btn: ModalButton, closeModal: () => void): void {
  const result = btn.action ? actionRegistry.invoke(btn.action, btn.args) : undefined;

  if (btn.closesModal === true) {
    closeModal();
  } else if (btn.closesModal === 'on-success') {
    Promise.resolve(result).then(
      () => closeModal(),
      () => { /* rejected — keep modal open so the action can show an error */ },
    );
  }
}

function ModalButtonBar({ buttons, closeModal }: { buttons: ModalButton[]; closeModal: () => void }) {
  const left   = buttons.filter(b => b.alignment === 'left');
  const center = buttons.filter(b => b.alignment === 'center');
  const right  = buttons.filter(b => !b.alignment || b.alignment === 'right');

  const handleClick = (btn: ModalButton) => runModalButton(btn, closeModal);

  const renderBtn = (btn: ModalButton, i: number) => (
    <button
      key={i}
      className={`modal-btn${btn.variant === 'primary' ? ' primary' : btn.variant === 'danger' ? ' danger' : ''}`}
      onClick={() => handleClick(btn)}
    >
      {btn.label}
    </button>
  );

  return (
    <div className="modal-button-bar">
      <div className="modal-btn-zone left">{left.map(renderBtn)}</div>
      <div className="modal-btn-zone center">{center.map(renderBtn)}</div>
      <div className="modal-btn-zone right">{right.map(renderBtn)}</div>
    </div>
  );
}

// ── Modal component registry ───────────────────────────────────────────────

type ModalComponent = React.ComponentType<{ modal: ModalState; onClose: () => void }>;

// ── Shared: dialog mode icon ───────────────────────────────────────────────

const ICON_SYMBOLS: Record<DialogMode, string> = {
  info:     'i',
  question: '?',
  warning:  '!',
  error:    '✕',
};

function DialogModeIcon({ mode }: { mode: DialogMode }) {
  return (
    <div className={`dialog-mode-icon ${mode}`} aria-hidden="true">
      {ICON_SYMBOLS[mode]}
    </div>
  );
}

// ── Shared: dialog content row (icon + message) ────────────────────────────

function DialogContentRow({ mode, message }: { mode?: DialogMode; message?: string }) {
  if (!mode && !message) return null;
  return (
    <div className={mode ? 'dialog-content-row' : undefined}>
      {mode && <DialogModeIcon mode={mode} />}
      {message && <p className="dialog-message">{message}</p>}
    </div>
  );
}

// ── GenericModal ───────────────────────────────────────────────────────────
// Shows a message string. Renders its own OK button only when no button bar is
// configured, so existing callsites (popup-blocked etc.) continue to work.

function GenericModal({ modal, onClose }: { modal: ModalState; onClose: () => void }) {
  const hasButtonBar = (modal.buttons?.length ?? 0) > 0;
  return (
    <div className="modal-content-pad">
      {modal.props?.message
        ? <p style={{ color: 'var(--text)', fontSize: 13, margin: 0 }}>{String(modal.props.message)}</p>
        : <p style={{ color: 'var(--text-dim)', fontSize: 12, margin: 0, fontStyle: 'italic' }}>No content.</p>
      }
      {!hasButtonBar && (
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <button className="modal-btn primary" onClick={onClose}>OK</button>
        </div>
      )}
    </div>
  );
}

// ── NewLayoutModal ─────────────────────────────────────────────────────────

function NewLayoutModal({ modal: _modal, onClose: _onClose }: { modal: ModalState; onClose: () => void }) {
  const { dispatch } = useAppState();
  const [name, setName]         = useState('Untitled Layout');
  const [topRow, setTopRow]     = useState(true);
  const [bottomRow, setBottomRow] = useState(true);
  const [description, setDescription] = useState('');

  const formRef = useRef({ name, topRow, bottomRow, description });
  useEffect(() => { formRef.current = { name, topRow, bottomRow, description }; });

  useEffect(() => {
    actionRegistry.register('newLayout:create', () => {
      const { name: n, description: d } = formRef.current;
      dispatch({
        type: 'SET_STATUS_INTERRUPT',
        text: `New layout "${n || 'Untitled'}" created${d ? ` — ${d}` : ''}.`,
        duration: 5000,
      });
    });
    return () => actionRegistry.unregister('newLayout:create');
  }, [dispatch]);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 4,
    color: 'var(--text)',
    fontSize: 12,
    padding: '5px 8px',
    fontFamily: 'inherit',
    outline: 'none',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: 11,
    color: 'var(--text-dim)',
    marginBottom: 4,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  };

  return (
    <div className="modal-content-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label style={labelStyle}>Layout name</label>
        <input
          style={inputStyle}
          value={name}
          onChange={e => setName(e.target.value)}
          onFocus={e => e.target.select()}
          autoFocus
        />
      </div>

      <div>
        <label style={labelStyle}>Description <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
        <textarea
          style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }}
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Brief description of this layout…"
        />
      </div>

      <div>
        <label style={{ ...labelStyle, marginBottom: 8 }}>Workspace rows</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {([
            [topRow, setTopRow, 'Top row visible'] as const,
            [bottomRow, setBottomRow, 'Bottom row visible'] as const,
          ]).map(([checked, setter, label]) => (
            <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={checked}
                onChange={e => setter(e.target.checked)}
                style={{ accentColor: 'var(--accent)', width: 13, height: 13, cursor: 'pointer' }}
              />
              {label}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  AlertDialog
//  Simple message box with an optional mode icon and a single OK button
//  (supplied via the buttons array by dialogService.showAlert).
//  allowClose is false — only the OK button dismisses the dialog.
// ═══════════════════════════════════════════════════════════════════════════

function AlertDialog({ modal, onClose }: { modal: ModalState; onClose: () => void }) {
  const props      = modal.props ?? {};
  const mode       = props.mode        as DialogMode | undefined;
  const message    = props.message     as string     | undefined;
  const callbackKey = props.callbackKey as string    | undefined;
  const hasButtons = (modal.buttons?.length ?? 0) > 0;

  // Keyboard is handled generically by the ModalDialog wrapper via button.keys.

  return (
    <div className="modal-content-pad">
      <DialogContentRow mode={mode} message={message} />
      {/* Inline OK only if no button bar was configured (direct dispatch fallback) */}
      {!hasButtons && (
        <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="modal-btn primary"
            onClick={() => {
              if (callbackKey) invokeDialogCallback(callbackKey, { button: 'OK' });
              onClose();
            }}
          >
            OK
          </button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  ConfirmDialog
//  Message box with an optional mode icon and a configurable button set
//  (preset supplied via dialogService.showConfirm buttons array).
//  Keyboard: Enter activates the primary (rightmost) button.
//            Escape activates the leftmost (cancel/no) button, if present.
// ═══════════════════════════════════════════════════════════════════════════

function ConfirmDialog({ modal, onClose: _onClose }: { modal: ModalState; onClose: () => void }) {
  const props   = modal.props ?? {};
  const mode    = props.mode    as DialogMode | undefined;
  const message = props.message as string     | undefined;

  // Keyboard is handled generically by the ModalDialog wrapper via button.keys.

  return (
    <div className="modal-content-pad">
      <DialogContentRow mode={mode} message={message} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  InputDialog
//  Message + input widget (text / select / listbox).
//  Registers a per-dialog '_inputDialog:<key>' action that the OK button
//  invokes; validation runs inside the action and controls whether the
//  dialog actually closes.
// ═══════════════════════════════════════════════════════════════════════════

function validateInputValue(
  value: string | string[],
  inputType: InputFieldType,
  widgetType: InputWidgetType,
  required: boolean,
  min?: number,
  max?: number,
): string | null {
  // Required check
  const isEmpty = Array.isArray(value) ? value.length === 0 : value.trim() === '';
  if (required && isEmpty) return 'This field is required.';

  // No further validation for empty optional fields or non-text widgets
  if (isEmpty) return null;
  if (widgetType !== 'text') return null;
  if (Array.isArray(value)) return null;

  const str = value.trim();

  switch (inputType) {
    case 'integer': {
      if (!/^-?\d+$/.test(str)) return 'Please enter a whole number (e.g. 42 or −7).';
      const n = parseInt(str, 10);
      if (min !== undefined && n < min) return `Value must be at least ${min}.`;
      if (max !== undefined && n > max) return `Value must be at most ${max}.`;
      break;
    }
    case 'float':
    case 'number': {
      const n = Number(str);
      if (isNaN(n)) return 'Please enter a valid number.';
      if (min !== undefined && n < min) return `Value must be at least ${min}.`;
      if (max !== undefined && n > max) return `Value must be at most ${max}.`;
      break;
    }
    case 'email': {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)) return 'Please enter a valid email address.';
      break;
    }
    case 'url': {
      try { new URL(str); }
      catch { return 'Please enter a valid URL (e.g. https://example.com).'; }
      break;
    }
  }
  return null;
}

function InputDialog({ modal, onClose }: { modal: ModalState; onClose: () => void }) {
  const props = modal.props ?? {};

  const mode         = props.mode         as DialogMode       | undefined;
  const message      = props.message      as string           | undefined;
  const inputType    = (props.inputType   as InputFieldType)  ?? 'text';
  const widgetType   = (props.widgetType  as InputWidgetType) ?? 'text';
  const required     = (props.required    as boolean)         ?? false;
  const min          = props.min          as number           | undefined;
  const max          = props.max          as number           | undefined;
  const defaultValue = props.defaultValue as string | string[]| undefined;
  const placeholder  = props.placeholder  as string           | undefined;
  const options      = (props.options     as SelectOption[])  ?? [];
  const multiple     = (props.multiple    as boolean)         ?? false;
  const callbackKey  = props.callbackKey  as string           | undefined;
  const keepOpen     = (props.keepOpen    as boolean)         ?? false;
  const submitAction = props.submitAction as string           | undefined;
  const cancelAction = props.cancelAction as string           | undefined;
  const okLabel      = (props.okLabel     as string)          ?? 'OK';
  const cancelLabel  = (props.cancelLabel as string)          ?? 'Cancel';

  // ── State ────────────────────────────────────────────────────────────────
  const isMulti = widgetType === 'listbox' && multiple;

  const initSingle = (): string => {
    if (typeof defaultValue === 'string') return defaultValue;
    if (Array.isArray(defaultValue) && defaultValue.length > 0) return defaultValue[0];
    // No defaultValue provided → leave unselected (empty string)
    return '';
  };

  const initMulti = (): string[] => {
    if (Array.isArray(defaultValue)) return defaultValue;
    if (typeof defaultValue === 'string') return defaultValue ? [defaultValue] : [];
    return [];
  };

  const [singleValue, setSingleValue] = useState<string>(initSingle);
  const [multiValues, setMultiValues] = useState<string[]>(initMulti);
  const [error, setError]             = useState<string>('');

  // Mounted guard — prevents state updates after unmount in async callbacks
  const mountedRef = useRef(true);

  // Keep a ref for the submit action closure
  const valueRef = useRef<string | string[]>(isMulti ? multiValues : singleValue);
  useEffect(() => {
    valueRef.current = isMulti ? multiValues : singleValue;
  });

  // ── keepOpen: register controller on mount, clean up on unmount ──────────
  useEffect(() => {
    if (!keepOpen || !callbackKey) return;

    // React StrictMode double-invokes effects: cleanup sets mountedRef to false,
    // so we must re-arm it at the start of each invocation.
    mountedRef.current = true;

    const controller: DialogController = {
      close: () => {
        if (mountedRef.current) {
          // Clean up the callback first so StrictMode re-cycles can't replay it,
          // then close the modal.
          cleanupKeepOpenCallback(callbackKey);
          onClose();
        }
      },
      setError: (msg: string) => {
        if (mountedRef.current) setError(msg);
      },
      setValue: (val: string | string[]) => {
        if (!mountedRef.current) return;
        if (isMulti) {
          const arr = Array.isArray(val) ? val : (val ? [val as string] : []);
          setMultiValues(arr);
          valueRef.current = arr;
        } else {
          const str = Array.isArray(val) ? (val[0] ?? '') : (val as string);
          setSingleValue(str);
          valueRef.current = str;
        }
      },
    };

    registerDialogController(callbackKey, controller);

    return () => {
      mountedRef.current = false;
      unregisterDialogController(callbackKey);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stable: callbackKey / keepOpen don't change during a dialog's lifetime

  // ── Submit action ─────────────────────────────────────────────────────────
  // Registered on mount and cleaned up on unmount.
  // The OK button in the button bar invokes this action key.
  useEffect(() => {
    if (!submitAction) return;

    actionRegistry.register(submitAction, () => {
      const current = valueRef.current;
      const err = validateInputValue(current, inputType, widgetType, required, min, max);
      if (err) { setError(err); return; }

      setError('');
      if (keepOpen) {
        // Deliver result but leave the dialog open — controller lets caller close it
        if (callbackKey) invokeKeepOpenCallback(callbackKey, { button: okLabel, value: current });
      } else {
        if (callbackKey) invokeDialogCallback(callbackKey, { button: okLabel, value: current });
        onClose();
      }
    });

    return () => { if (submitAction) actionRegistry.unregister(submitAction); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitAction]); // stable: submitAction / callbackKey don't change during a dialog's lifetime

  // ── keepOpen cancel action ────────────────────────────────────────────────
  // When keepOpen is true, the Cancel button triggers this action instead of
  // closing immediately.  The caller receives the result via onResult and can
  // call controller.close() to dismiss.
  useEffect(() => {
    if (!keepOpen || !cancelAction || !callbackKey) return;

    actionRegistry.register(cancelAction, () => {
      invokeKeepOpenCallback(callbackKey, { button: cancelLabel, value: undefined });
    });

    return () => { actionRegistry.unregister(cancelAction); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelAction]); // stable

  // Keyboard is handled generically by the ModalDialog wrapper via button.keys.

  // ── Key filter helpers ────────────────────────────────────────────────────
  const handleIntKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const allowed = new Set(['Backspace','Delete','Tab','Escape','Enter','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End']);
    if (allowed.has(e.key)) return;
    if (e.key === '-' && (e.currentTarget.selectionStart === 0) && !singleValue.includes('-')) return;
    if (/^\d$/.test(e.key)) return;
    e.preventDefault();
  };

  const handleFloatKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const allowed = new Set(['Backspace','Delete','Tab','Escape','Enter','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End']);
    if (allowed.has(e.key)) return;
    if (e.key === '-' && (e.currentTarget.selectionStart === 0) && !singleValue.includes('-')) return;
    if (e.key === '.' && !singleValue.includes('.')) return;
    if (/^\d$/.test(e.key)) return;
    e.preventDefault();
  };

  // ── Input HTML type ───────────────────────────────────────────────────────
  const htmlInputType = (() => {
    switch (inputType) {
      case 'email':  return 'email';
      case 'url':    return 'url';
      case 'number': return 'number';
      default:       return 'text';
    }
  })();

  // ── Range hint ────────────────────────────────────────────────────────────
  const rangeHint = (() => {
    if (!['integer','float','number'].includes(inputType)) return null;
    if (min === undefined && max === undefined) return null;
    if (min !== undefined && max !== undefined) return `Range: ${min} – ${max}`;
    if (min !== undefined) return `Minimum: ${min}`;
    return `Maximum: ${max}`;
  })();

  // ── Render widget ─────────────────────────────────────────────────────────
  const inputCls = `dialog-input${error ? ' has-error' : ''}`;
  const selectCls = `dialog-select${error ? ' has-error' : ''}`;
  const listCls = `dialog-listbox${error ? ' has-error' : ''}`;

  const renderWidget = () => {
    switch (widgetType) {
      case 'select':
        return (
          <select
            className={selectCls}
            value={singleValue}
            onChange={e => { setSingleValue(e.target.value); setError(''); }}
            autoFocus
          >
            {/* Placeholder shown when no default is provided — disabled so it can't be re-selected */}
            {singleValue === '' && (
              <option value="" disabled>— Select an option —</option>
            )}
            {options.map(opt => (
              <option key={opt.key} value={opt.key}>{opt.value}</option>
            ))}
          </select>
        );

      case 'listbox':
        if (isMulti) {
          return (
            <select
              className={listCls}
              multiple
              size={Math.max(3, Math.min(8, options.length))}
              value={multiValues}
              onChange={e => {
                const selected = Array.from(e.target.selectedOptions, o => o.value);
                setMultiValues(selected);
                setError('');
              }}
              autoFocus
            >
              {options.map(opt => (
                <option key={opt.key} value={opt.key}>{opt.value}</option>
              ))}
            </select>
          );
        }
        return (
          <select
            className={listCls}
            size={Math.max(3, Math.min(8, options.length))}
            value={singleValue}
            onChange={e => { setSingleValue(e.target.value); setError(''); }}
            autoFocus
          >
            {options.map(opt => (
              <option key={opt.key} value={opt.key}>{opt.value}</option>
            ))}
          </select>
        );

      default: // 'text'
        return (
          <input
            className={inputCls}
            type={htmlInputType}
            value={singleValue}
            placeholder={placeholder}
            inputMode={inputType === 'integer' ? 'numeric' : inputType === 'float' ? 'decimal' : undefined}
            min={inputType !== 'text' && inputType !== 'email' && inputType !== 'url' ? min : undefined}
            max={inputType !== 'text' && inputType !== 'email' && inputType !== 'url' ? max : undefined}
            onKeyDown={
              inputType === 'integer' ? handleIntKeyDown :
              inputType === 'float'   ? handleFloatKeyDown :
              undefined
            }
            onChange={e => {
              // For integer/float we enforce via onKeyDown, but also guard onChange
              if (inputType === 'integer' && e.target.value !== '' && !/^-?\d*$/.test(e.target.value)) return;
              if (inputType === 'float'   && e.target.value !== '' && !/^-?\d*\.?\d*$/.test(e.target.value)) return;
              setSingleValue(e.target.value);
              if (error) setError('');
            }}
            autoFocus
          />
        );
    }
  };

  // ── Label text ────────────────────────────────────────────────────────────
  const labelText = (() => {
    if (widgetType === 'select') return 'Select an option';
    if (widgetType === 'listbox') return multiple ? 'Select one or more' : 'Select an option';
    switch (inputType) {
      case 'integer': return 'Integer value';
      case 'float':   return 'Decimal value';
      case 'number':  return 'Number';
      case 'email':   return 'Email address';
      case 'url':     return 'URL';
      default:        return null;
    }
  })();

  return (
    <div className="modal-content-pad">
      {/* Icon + message row */}
      {(mode || message) && <DialogContentRow mode={mode} message={message} />}

      {/* Input field area */}
      <div className="dialog-field">
        {labelText && (
          <label className="dialog-field-label">{labelText}{required ? ' *' : ''}</label>
        )}
        {renderWidget()}
        {rangeHint && !error && <p className="dialog-range-hint">{rangeHint}</p>}
        <p className="dialog-error-text">{error}</p>
      </div>
    </div>
  );
}

// ── SaveProjectModal ──────────────────────────────────────────────────────
//
// App-layer modal used by the Parametric3dStudio bridge. Collects a project
// name (required) and an optional description, and forwards them to the
// caller-supplied onSave callback. Shows the created/modified timestamps when
// editing an existing project's details.

interface SaveProjectModalProps {
  name?: string;
  description?: string;
  createdAt?: string | null;
  onSave?: (next: { name: string; description: string }) => void;
}

function SaveProjectModal({ modal, onClose }: { modal: ModalState; onClose: () => void }) {
  const props = (modal.props ?? {}) as SaveProjectModalProps;
  const [name, setName] = useState(props.name ?? '');
  const [description, setDescription] = useState(props.description ?? '');
  const [error, setError] = useState<string>('');

  const formRef = useRef({ name, description });
  useEffect(() => { formRef.current = { name, description }; });

  // Register the per-dialog save action; the Save button on the button bar invokes it.
  useEffect(() => {
    actionRegistry.register('saveProjectModal:save', () => {
      const { name: n, description: d } = formRef.current;
      const trimmed = n.trim();
      if (!trimmed) {
        setError('Project name is required.');
        return;
      }
      setError('');
      props.onSave?.({ name: trimmed, description: d });
      onClose();
    });
    return () => actionRegistry.unregister('saveProjectModal:save');
  // onClose is stable for the lifetime of the modal
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fmtDate = (iso: string | null | undefined) => {
    if (!iso) return null;
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };
  const created = fmtDate(props.createdAt);

  return (
    <div className="modal-content-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="dialog-field" style={{ marginTop: 0 }}>
        <label className="dialog-field-label">Project name *</label>
        <input
          className={`dialog-input${error ? ' has-error' : ''}`}
          value={name}
          onChange={e => { setName(e.target.value); if (error) setError(''); }}
          onFocus={e => e.target.select()}
          placeholder="My Parametric Project"
          autoFocus
        />
        {error && <p className="dialog-error-text">{error}</p>}
      </div>

      <div className="dialog-field" style={{ marginTop: 0 }}>
        <label className="dialog-field-label">Description (optional)</label>
        <textarea
          className="dialog-input"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="What this project is for…"
          style={{ resize: 'vertical', minHeight: 64, fontFamily: 'inherit' }}
        />
      </div>

      {created && (
        <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
          Created: {created}
        </div>
      )}
    </div>
  );
}

// ── AppSettingsModal ───────────────────────────────────────────────────────
//
// VFS connection settings (step 1 of the VFS integration). Collects the server
// address + application id, persists them via the vfsClient, and offers a live
// "Test connection" probe that reports pass / failure inline. The button bar's
// Save action (appSettingsModal:save) writes the values to storage.

function AppSettingsModal({ onClose }: { modal: ModalState; onClose: () => void }) {
  const initial = loadVfsConfig();
  const [serverUrl, setServerUrl] = useState(initial.serverUrl);
  const [applicationId, setApplicationId] = useState(
    initial.applicationId || DEFAULT_APPLICATION_ID,
  );
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<ConnectionResult | null>(null);

  const formRef = useRef({ serverUrl, applicationId });
  useEffect(() => { formRef.current = { serverUrl, applicationId }; });

  // Persist on Save (invoked by the button bar).
  useEffect(() => {
    actionRegistry.register('appSettingsModal:save', () => {
      saveVfsConfig(formRef.current);
      onClose();
    });
    return () => actionRegistry.unregister('appSettingsModal:save');
  // onClose is stable for the lifetime of the modal
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runTest = useCallback(async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await checkConnection(formRef.current);
      setResult(r);
    } catch {
      setResult({ ok: false, message: 'Connection test failed unexpectedly.' });
    } finally {
      setTesting(false);
    }
  }, []);

  return (
    <div className="modal-content-pad" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="dialog-field" style={{ marginTop: 0 }}>
        <label className="dialog-field-label">Server address *</label>
        <input
          className="dialog-input"
          value={serverUrl}
          onChange={e => { setServerUrl(e.target.value); setResult(null); }}
          placeholder="http://localhost:5000"
          autoFocus
        />
      </div>

      <div className="dialog-field" style={{ marginTop: 0 }}>
        <label className="dialog-field-label">Application id *</label>
        <input
          className="dialog-input"
          value={applicationId}
          onChange={e => { setApplicationId(e.target.value); setResult(null); }}
          placeholder={DEFAULT_APPLICATION_ID}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          className="modal-btn"
          onClick={runTest}
          disabled={testing || !serverUrl.trim() || !applicationId.trim()}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        {result && (
          <span
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: result.ok ? 'var(--accent, #3a9d4a)' : 'var(--danger, #d3534f)',
            }}
          >
            {result.ok ? '✓ ' : '✕ '}{result.message}
          </span>
        )}
      </div>

      <p style={{ fontSize: 11, color: 'var(--text-dim)', margin: 0 }}>
        These settings are saved locally and used to connect to the Virtual File System server.
      </p>
    </div>
  );
}

// ── Registry ───────────────────────────────────────────────────────────────

const MODAL_REGISTRY: Record<string, ModalComponent> = {
  GenericModal,
  NewLayoutModal,
  AlertDialog,
  ConfirmDialog,
  InputDialog,
  SaveProjectModal,
  AppSettingsModal,
  ProjectDetailsModal,
  AddRootModal,
};

// ── Individual modal dialog ────────────────────────────────────────────────

interface DialogProps {
  modal: ModalState;
  /** 0-based index within state.modals — used for cascade offset on stacked dialogs. */
  index: number;
  /** Total number of open modals — only the topmost (index === total-1) handles keys. */
  total: number;
}

// ── Default modal sizing constants ─────────────────────────────────────────

const MODAL_DEFAULT_W    = 400;
const MODAL_DEFAULT_MIN_W = 260;
const MODAL_DEFAULT_MIN_H = 120;

// Pixels of cascade offset per stacking level (applied when > 1 modal is open)
const CASCADE_PX = 22;

function ModalDialog({ modal, index, total }: DialogProps) {
  const { dispatch } = useAppState();

  // Position — null = centred via CSS default; non-null = user has dragged it
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const [size, setSize] = useState({
    w: modal.width  ?? MODAL_DEFAULT_W,
    h: modal.height ?? null as number | null,
  });

  const resizable = modal.allowResize !== false;
  const minW      = modal.minWidth  ?? MODAL_DEFAULT_MIN_W;
  const minH      = modal.minHeight ?? MODAL_DEFAULT_MIN_H;

  const dialogRef = useRef<HTMLDivElement>(null);

  const closeModal = useCallback(() => {
    dispatch({ type: 'CLOSE_MODAL', id: modal.id });
  }, [modal.id, dispatch]);

  // ── Generic key binding handler ──────────────────────────────────────────
  // Only the topmost modal (index === total - 1) processes keyboard events so
  // stacked dialogs don't all respond at once.
  // Each ModalButton may carry a `keys` array (e.g. ['Enter'], ['Escape']).
  // Pressing a listed key triggers that button exactly as a click would.
  // Keys not listed on any button of this modal have no effect.
  useEffect(() => {
    if (index !== total - 1) return; // only topmost modal handles keys
    const buttons = modal.buttons;
    if (!buttons?.length) return;

    const onKey = (e: KeyboardEvent) => {
      const btn = buttons.find(b => b.keys?.includes(e.key));
      if (!btn) return;
      e.preventDefault();
      runModalButton(btn, closeModal);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modal.buttons, index, total, closeModal]);

  const handleCloseBtn = useCallback(() => {
    if (modal.onCloseAction) actionRegistry.invoke(modal.onCloseAction);
    closeModal();
  }, [modal.onCloseAction, closeModal]);

  // ── Title bar drag (move) ────────────────────────────────────────────────
  const handleTitleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = dialogRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startMx = e.clientX, startMy = e.clientY;
    const startPx = rect.left,  startPy = rect.top;

    const onMove = (me: MouseEvent) => {
      setPos({ x: startPx + (me.clientX - startMx), y: startPy + (me.clientY - startMy) });
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // ── Bottom-right resize handle ───────────────────────────────────────────
  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = dialogRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startMx = e.clientX, startMy = e.clientY;
    const startW  = rect.width,  startH  = rect.height;

    if (!pos) setPos({ x: rect.left, y: rect.top });
    const fixedX = rect.left, fixedY = rect.top;

    const onMove = (me: MouseEvent) => {
      const newW = Math.max(minW, startW + (me.clientX - startMx));
      const newH = Math.max(minH, startH + (me.clientY - startMy));
      setSize({ w: newW, h: newH });
      setPos({ x: fixedX, y: fixedY });
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    document.body.style.cursor = 'se-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [pos, minW, minH]);

  const Component  = MODAL_REGISTRY[modal.componentType] ?? GenericModal;
  const showClose  = modal.allowClose !== false;
  const hasButtons = (modal.buttons?.length ?? 0) > 0;

  // ── Positioning ──────────────────────────────────────────────────────────
  // .modal-dialog CSS defaults to: position: fixed; left: 50%; top: 50%;
  //   transform: translate(-50%, -50%)
  // When dragged: override with explicit pixel position.
  // When stacked (index > 0): apply cascade offset via transform.
  const cascadeOffset = index * CASCADE_PX;

  const style: React.CSSProperties = {
    width: size.w,
    ...(size.h !== null ? { height: size.h } : {}),
    minWidth: minW,
    minHeight: minH,
    zIndex: 1 + index,
    ...(pos
      ? {
          left:      pos.x,
          top:       pos.y,
          transform: 'none',
        }
      : index > 0
        ? {
            transform: `translate(calc(-50% + ${cascadeOffset}px), calc(-50% + ${cascadeOffset}px))`,
          }
        : {}
    ),
  };

  return (
    <div className="modal-dialog" style={style} ref={dialogRef}>
      {/* Title bar */}
      <div className="modal-titlebar" onMouseDown={handleTitleMouseDown}>
        <span className="modal-title">{modal.title}</span>
        {showClose && (
          <button
            className="floating-panel-btn close-btn"
            title="Close"
            onMouseDown={e => e.stopPropagation()}
            onClick={handleCloseBtn}
            style={{ marginLeft: 8 }}
          >
            ×
          </button>
        )}
      </div>

      {/* Content */}
      <div className="modal-body">
        <Component modal={modal} onClose={closeModal} />
      </div>

      {/* Bottom button bar (optional) */}
      {hasButtons && (
        <ModalButtonBar buttons={modal.buttons!} closeModal={closeModal} />
      )}

      {/* Bottom-right resize grip */}
      {resizable && (
        <div className="window-resize-grip" onMouseDown={handleResizeMouseDown} />
      )}
    </div>
  );
}

// ── Modal manager — portal into document.body ─────────────────────────────

export function ModalManager() {
  const { state } = useAppState();
  if (state.modals.length === 0) return null;

  return createPortal(
    <div className="modal-layer">
      <div className="modal-backdrop" />
      {state.modals.map((modal, idx) => (
        <ModalDialog key={modal.id} modal={modal} index={idx} total={state.modals.length} />
      ))}
    </div>,
    document.body,
  );
}
