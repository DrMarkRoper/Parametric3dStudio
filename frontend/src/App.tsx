import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppState, MenuItem, MenuRootItem } from './types';
import { AppStateProvider, useAppState } from './contexts/AppStateContext';
import { useStore } from './studio/state/store';
import { refreshVfsStatus, useVfsAppReady } from './vfs/vfsStatus';
import { actionRegistry } from './utils/actionRegistry';
import {
  saveLayoutToFile,
  loadLayoutFromFile,
  clearStoredState,
  loadInitialState,
} from './utils/layoutSerializer';
import {
  registerShortcutsFromMenuDef,
  handleGlobalKeyDown,
} from './utils/shortcutRegistry';
import * as dialogService from './utils/dialogService';
import { TitleBar }              from './components/TitleBar';
import { MenuBar }               from './components/MenuBar';
import { MainToolbar }           from './components/MainToolbar';
import { MDIWorkspace }          from './components/MDIWorkspace';
import { StudioStatusBar }       from './components/StudioStatusBar';
import { ModalManager }          from './components/ModalDialog';
import { useStudioActions }      from './studio/useStudioActions';

// ── Global action wiring (runs inside the context) ───────────────────────

function useGlobalActions() {
  const { state, dispatch } = useAppState();

  // Wire dispatch into dialogService once on mount so showAlert/showConfirm/showInput work.
  // dispatch is stable (React guarantees), so this runs effectively once.
  useEffect(() => {
    dialogService.setDialogDispatch(dispatch);
  }, [dispatch]);

  // Register the shared '_dialogResult' action used by AlertDialog / ConfirmDialog button bars.
  // This is intentionally registered once outside the state-dependent useEffect below,
  // since it has no closure over state.
  useEffect(() => {
    actionRegistry.register('_dialogResult', (args) => {
      const key    = args?.callbackKey as string | undefined;
      const button = String(args?.button ?? '');
      if (key) dialogService.invokeDialogCallback(key, { button });
    });
    return () => actionRegistry.unregister('_dialogResult');
  }, []);

  useEffect(() => {
    actionRegistry.register('onToggleTheme', () =>
      dispatch({ type: 'SET_THEME', theme: state.theme === 'dark' ? 'light' : 'dark' })
    );
    actionRegistry.register('onToggleStatusBar', () =>
      dispatch({ type: 'TOGGLE_STATUS_BAR' })
    );
    actionRegistry.register('setStatusInterrupt', (args) => {
      const text     = String(args?.text ?? '');
      const duration = Number(args?.duration ?? 5000);
      dispatch({ type: 'SET_STATUS_INTERRUPT', text, duration });
    });
    actionRegistry.register('onSaveLayout', () => {
      saveLayoutToFile(state);
      dispatch({ type: 'SET_STATUS_INTERRUPT', text: 'Layout saved to file.', duration: 5000 });
    });
    actionRegistry.register('onLoadLayout', async () => {
      try {
        const loaded = await loadLayoutFromFile();
        dispatch({ type: 'LOAD_STATE', state: loaded });
        dispatch({ type: 'SET_STATUS_INTERRUPT', text: 'Layout loaded from file.', duration: 5000 });
      } catch (e) {
        console.error('Load layout failed:', e);
      }
    });
    actionRegistry.register('onResetLayout', async () => {
      clearStoredState();
      const fresh = await loadInitialState();
      dispatch({ type: 'LOAD_STATE', state: fresh });
      dispatch({ type: 'SET_STATUS_INTERRUPT', text: 'Layout reset to default.', duration: 5000 });
    });
    actionRegistry.register('onFileNew', () => {
      dispatch({
        type: 'OPEN_MODAL',
        modal: {
          title: 'New Layout',
          componentType: 'NewLayoutModal',
          width: 420,
          allowClose: true,
          onCloseAction: undefined,
          buttons: [
            { label: 'Cancel', alignment: 'right', closesModal: true },
            { label: 'Create', action: 'newLayout:create', alignment: 'right', variant: 'primary', closesModal: true },
          ],
        },
      });
    });
    // Modal action: invoke via actionRegistry.invoke('openModal', { title, componentType, message })
    actionRegistry.register('openModal', (args) => {
      dispatch({
        type: 'OPEN_MODAL',
        modal: {
          title: String(args?.title ?? 'Dialog'),
          componentType: String(args?.componentType ?? 'GenericModal'),
          width: args?.width ? Number(args.width) : undefined,
          height: args?.height ? Number(args.height) : undefined,
          props: args?.props as Record<string, unknown> | undefined ?? (args?.message ? { message: args.message } : undefined),
        },
      });
    });

    // About
    actionRegistry.register('onAbout', () => {
      dialogService.showAlert({
        title: 'About Parametric3dStudio',
        message: 'Parametric3dStudio v.0.1\n\nA parametric 3D modeller on the MDI framework.\nReact 19 · TypeScript · Three.js / react-three-fiber.',
        mode: 'info',
      });
    });

    // ── Toolbar Dialog demos ─────────────────────────────────────────────

    // ── Alert variants ────────────────────────────────────────────────────
    actionRegistry.register('demo:alert:info', () => {
      dialogService.showAlert({
        title: 'Information',
        message: 'Document auto-saved successfully at 14:32.\n\nAll changes are stored in your local session.',
        mode: 'info',
        onClose: () => dispatch({ type: 'SET_STATUS_INTERRUPT', text: 'Alert: Information dismissed', duration: 3000 }),
      });
    });

    actionRegistry.register('demo:alert:question', () => {
      dialogService.showAlert({
        title: 'Did You Know?',
        message: 'You can drag any document tab outside the workspace to make it float as a moveable panel.\n\nClick the ⊟ button to dock it back.',
        mode: 'question',
        onClose: () => dispatch({ type: 'SET_STATUS_INTERRUPT', text: 'Alert: Tip dismissed', duration: 3000 }),
      });
    });

    actionRegistry.register('demo:alert:warning', () => {
      dialogService.showAlert({
        title: 'Warning',
        message: 'This layout has unsaved changes.\n\nIf you reset the workspace now, all panel positions and open documents will be lost.',
        mode: 'warning',
        onClose: () => dispatch({ type: 'SET_STATUS_INTERRUPT', text: 'Alert: Warning acknowledged', duration: 3000 }),
      });
    });

    actionRegistry.register('demo:alert:error', () => {
      dialogService.showAlert({
        title: 'Error',
        message: 'Failed to load file: permission denied.\n\nPlease check that the file is not open in another application and try again.',
        mode: 'error',
        onClose: () => dispatch({ type: 'SET_STATUS_INTERRUPT', text: 'Alert: Error acknowledged', duration: 3000 }),
      });
    });

    // ── Confirm variants ──────────────────────────────────────────────────
    actionRegistry.register('demo:confirm:ok-cancel', () => {
      dialogService.showConfirm({
        title: 'Reload Layout',
        message: 'Reloading will discard any unsaved changes to the current workspace.\n\nContinue?',
        mode: 'warning',
        buttons: 'ok-cancel',
        onResult: r => dispatch({
          type: 'SET_STATUS_INTERRUPT',
          text: `Confirm (OK/Cancel) → "${r.button}"`,
          duration: 4000,
        }),
      });
    });

    actionRegistry.register('demo:confirm:yes-no', () => {
      dialogService.showConfirm({
        title: 'Save Changes',
        message: 'You have unsaved changes in "Project Notes".\n\nWould you like to save before continuing?',
        mode: 'question',
        buttons: 'yes-no',
        onResult: r => dispatch({
          type: 'SET_STATUS_INTERRUPT',
          text: `Confirm (Yes/No) → "${r.button}"`,
          duration: 4000,
        }),
      });
    });

    actionRegistry.register('demo:confirm:yes-no-cancel', () => {
      dialogService.showConfirm({
        title: 'Close Document',
        message: '"Report Draft.docx" has been modified.\n\nSave changes before closing?',
        mode: 'question',
        buttons: 'yes-no-cancel',
        onResult: r => dispatch({
          type: 'SET_STATUS_INTERRUPT',
          text: `Confirm (Yes/No/Cancel) → "${r.button}"`,
          duration: 4000,
        }),
      });
    });

    actionRegistry.register('demo:confirm:retry-cancel', () => {
      dialogService.showConfirm({
        title: 'Connection Failed',
        message: 'Unable to reach the document server.\n\ncheck your network connection and try again.',
        mode: 'error',
        buttons: 'retry-cancel',
        onResult: r => dispatch({
          type: 'SET_STATUS_INTERRUPT',
          text: `Confirm (Retry/Cancel) → "${r.button}"`,
          duration: 4000,
        }),
      });
    });

    actionRegistry.register('demo:confirm:abort-retry-ignore', () => {
      dialogService.showConfirm({
        title: 'Import Error',
        message: 'An error occurred importing row 42 of 318:\n"Invalid date format in column C"\n\nWhat would you like to do?',
        mode: 'warning',
        buttons: 'abort-retry-ignore',
        onResult: r => dispatch({
          type: 'SET_STATUS_INTERRUPT',
          text: `Confirm (Abort/Retry/Ignore) → "${r.button}"`,
          duration: 4000,
        }),
      });
    });

    // ── Input variants ────────────────────────────────────────────────────
    actionRegistry.register('demo:input:text', () => {
      dialogService.showInput({
        title: 'Rename Document',
        message: 'Enter a new name for this document:',
        mode: 'question',
        inputType: 'text',
        required: true,
        defaultValue: 'Untitled Document',
        placeholder: 'Document name…',
        onResult: r => dispatch({
          type: 'SET_STATUS_INTERRUPT',
          text: r.button === 'OK' ? `Renamed to: "${r.value}"` : `Input (Text) → ${r.button}`,
          duration: 4000,
        }),
      });
    });

    actionRegistry.register('demo:input:integer', () => {
      dialogService.showInput({
        title: 'Font Size',
        message: 'Enter a font size in points:',
        inputType: 'integer',
        required: true,
        min: 8,
        max: 72,
        defaultValue: '12',
        placeholder: '8 – 72',
        onResult: r => dispatch({
          type: 'SET_STATUS_INTERRUPT',
          text: r.button === 'OK' ? `Font size set to ${r.value} pt` : `Input (Integer) → ${r.button}`,
          duration: 4000,
        }),
      });
    });

    actionRegistry.register('demo:input:float', () => {
      dialogService.showInput({
        title: 'Line Spacing',
        message: 'Enter a line spacing multiplier:',
        inputType: 'float',
        required: true,
        min: 0.5,
        max: 3.0,
        defaultValue: '1.5',
        placeholder: '0.5 – 3.0',
        onResult: r => dispatch({
          type: 'SET_STATUS_INTERRUPT',
          text: r.button === 'OK' ? `Line spacing set to ${r.value}×` : `Input (Float) → ${r.button}`,
          duration: 4000,
        }),
      });
    });

    actionRegistry.register('demo:input:email', () => {
      dialogService.showInput({
        title: 'Share Document',
        message: 'Enter the email address to share this document with:',
        mode: 'question',
        inputType: 'email',
        required: true,
        placeholder: 'user@example.com',
        onResult: r => dispatch({
          type: 'SET_STATUS_INTERRUPT',
          text: r.button === 'OK' ? `Shared with: ${r.value}` : `Input (Email) → ${r.button}`,
          duration: 4000,
        }),
      });
    });

    actionRegistry.register('demo:input:url', () => {
      dialogService.showInput({
        title: 'Insert Hyperlink',
        message: 'Enter the destination URL:',
        inputType: 'url',
        required: true,
        defaultValue: 'https://',
        placeholder: 'https://example.com',
        onResult: r => dispatch({
          type: 'SET_STATUS_INTERRUPT',
          text: r.button === 'OK' ? `Link URL: ${r.value}` : `Input (URL) → ${r.button}`,
          duration: 4000,
        }),
      });
    });

    actionRegistry.register('demo:input:select', () => {
      dialogService.showInput({
        title: 'Document Type',
        message: 'Choose the type for this document:',
        mode: 'question',
        widgetType: 'select',
        defaultValue: 'report',
        options: [
          { key: 'report',      value: 'Report' },
          { key: 'memo',        value: 'Memo' },
          { key: 'letter',      value: 'Letter' },
          { key: 'proposal',    value: 'Proposal' },
          { key: 'minutes',     value: 'Meeting Minutes' },
          { key: 'invoice',     value: 'Invoice' },
          { key: 'spreadsheet', value: 'Spreadsheet' },
        ],
        onResult: r => dispatch({
          type: 'SET_STATUS_INTERRUPT',
          text: r.button === 'OK' ? `Document type: ${r.value}` : `Input (Select) → ${r.button}`,
          duration: 4000,
        }),
      });
    });

    actionRegistry.register('demo:input:listbox', () => {
      dialogService.showInput({
        title: 'Page Orientation',
        message: 'Select the page orientation for printing:',
        widgetType: 'listbox',
        multiple: false,
        defaultValue: 'portrait',
        options: [
          { key: 'portrait',  value: 'Portrait  (A4 / Letter)' },
          { key: 'landscape', value: 'Landscape (A4 / Letter)' },
          { key: 'a3port',    value: 'Portrait  (A3)' },
          { key: 'a3land',    value: 'Landscape (A3)' },
          { key: 'a5port',    value: 'Portrait  (A5)' },
        ],
        onResult: r => dispatch({
          type: 'SET_STATUS_INTERRUPT',
          text: r.button === 'OK' ? `Orientation: ${r.value}` : `Input (Listbox) → ${r.button}`,
          duration: 4000,
        }),
      });
    });

    actionRegistry.register('demo:input:multilist', () => {
      dialogService.showInput({
        title: 'Export Formats',
        message: 'Select one or more formats to export to:',
        mode: 'question',
        widgetType: 'listbox',
        multiple: true,
        options: [
          { key: 'pdf',   value: 'PDF  (.pdf)' },
          { key: 'docx',  value: 'Word Document  (.docx)' },
          { key: 'xlsx',  value: 'Excel Spreadsheet  (.xlsx)' },
          { key: 'html',  value: 'Web Page  (.html)' },
          { key: 'md',    value: 'Markdown  (.md)' },
          { key: 'txt',   value: 'Plain Text  (.txt)' },
          { key: 'csv',   value: 'CSV  (.csv)' },
          { key: 'json',  value: 'JSON  (.json)' },
        ],
        required: true,
        okLabel: 'Export',
        cancelLabel: 'Cancel',
        onResult: r => {
          if (r.button === 'Export' && Array.isArray(r.value)) {
            dispatch({
              type: 'SET_STATUS_INTERRUPT',
              text: `Exporting as: ${(r.value as string[]).join(', ') || '(none)'}`,
              duration: 4000,
            });
          } else {
            dispatch({ type: 'SET_STATUS_INTERRUPT', text: `Input (Multi-list) → ${r.button}`, duration: 4000 });
          }
        },
      });
    });

    // ── keepOpen demo: simulates async server-side validation ────────────────
    actionRegistry.register('demo:input:keepopen', () => {
      // Rejected usernames for this demo
      const TAKEN = new Set(['admin', 'root', 'mark', 'test']);

      dialogService.showInput({
        title: 'Choose a Username',
        message: 'Enter a username (try "admin", "root", or "test" to see async rejection):',
        mode: 'question',
        inputType: 'text',
        placeholder: 'e.g. johndoe',
        required: true,
        okLabel: 'Check & Save',
        cancelLabel: 'Cancel',
        keepOpen: true,
        onResult: (r, controller) => {
          if (r.button === 'Cancel') {
            // User cancelled — just close
            controller?.close();
            dispatch({ type: 'SET_STATUS_INTERRUPT', text: 'Username selection cancelled.', duration: 3000 });
            return;
          }
          const name = String(r.value ?? '').trim().toLowerCase();
          // Simulate async server check with a short delay
          controller?.setError('Checking availability…');
          setTimeout(() => {
            if (TAKEN.has(name)) {
              controller?.setError(`"${name}" is already taken — please choose another.`);
              controller?.setValue('');
            } else {
              controller?.close();
              dispatch({ type: 'SET_STATUS_INTERRUPT', text: `Username saved: ${name}`, duration: 4000 });
            }
          }, 800);
        },
      });
    });

    // Stub actions for unimplemented editing commands
    [
      'onUndo', 'onRedo', 'onCut', 'onCopy', 'onPaste',
      'onBold', 'onItalic', 'onUnderline',
      'onAlignLeft', 'onAlignCenter', 'onAlignRight',
      'onZoomIn', 'onZoomOut',
      'onInsertTable', 'onInsertImage', 'onInsertLink',
    ].forEach(name =>
      actionRegistry.register(name, () =>
        dispatch({ type: 'SET_STATUS_INTERRUPT', text: `Action fired: ${name}`, duration: 3000 })
      )
    );

    // Expose dialog service on window.mdi for development-time testing in the browser console.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).mdi = {
      showAlert:   dialogService.showAlert.bind(dialogService),
      showConfirm: dialogService.showConfirm.bind(dialogService),
      showInput:   dialogService.showInput.bind(dialogService),
    };
  }, [state, dispatch]);

  // Global keyboard shortcuts
  useEffect(() => {
    const handle = (e: KeyboardEvent) =>
      handleGlobalKeyDown(e, (action, args) => actionRegistry.invoke(action, args));
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, []);
}

// ── Popout watcher: opens a browser window for any poppedOut doc ─────────

function usePopoutWatcher() {
  const { state, dispatch } = useAppState();
  // Track which instanceIds we've already opened popout windows for
  const openedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // On startup, scan for storage keys left by previously closed popout windows
    for (const key of Object.keys(localStorage)) {
      const m = key.match(/^mdi:popout-closed:(.+)$/);
      if (m) {
        const id = m[1];
        localStorage.removeItem(key);
        openedRef.current.delete(id);
        const doc = state.documents[id];
        if (doc?.poppedOut) {
          // Clear poppedOut, then restore
          dispatch({ type: 'POP_IN_DOCUMENT', docInstanceId: id });
          dispatch({ type: 'RESTORE_DOCUMENT', docInstanceId: id });
        }
      }
    }
  // Run once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Open windows for newly popped-out docs
    for (const doc of Object.values(state.documents)) {
      if (doc.poppedOut && !openedRef.current.has(doc.instanceId)) {
        openedRef.current.add(doc.instanceId);
        const url = `${window.location.pathname}${window.location.search}#popout=${encodeURIComponent(doc.instanceId)}`;
        const w = window.open(url, `mdi-popout-${doc.instanceId}`, 'width=720,height=520');
        if (!w) {
          // Popup blocked — restore immediately
          dispatch({ type: 'POP_IN_DOCUMENT', docInstanceId: doc.instanceId });
          dispatch({ type: 'RESTORE_DOCUMENT', docInstanceId: doc.instanceId });
          dispatch({ type: 'OPEN_MODAL', modal: { title: 'Popup blocked', componentType: 'GenericModal', props: { message: 'Your browser blocked the popup window. Please allow popups for this site.' } } });
        }
      }
    }

    // Listen for storage events signalling a popout window closed
    const handleStorage = (e: StorageEvent) => {
      const m = e.key?.match(/^mdi:popout-closed:(.+)$/);
      if (!m || !e.key || e.newValue === null) return;
      const id = m[1];
      localStorage.removeItem(e.key);
      openedRef.current.delete(id);
      const doc = state.documents[id];
      if (doc?.poppedOut) {
        dispatch({ type: 'POP_IN_DOCUMENT', docInstanceId: id });
        dispatch({ type: 'RESTORE_DOCUMENT', docInstanceId: id });
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [state.documents, dispatch]);
}

// ── Sketch-aware menu derivation ─────────────────────────────────────────
//
// The base menu loaded from JSON is mode-agnostic. This hook derives a "live"
// version that reflects the current studio state:
//
//   • Create menu: in sketch mode, its children are swapped for the sketch
//     tools the user actually needs at that moment (line, rect, circle, …).
//   • Sketch menu: the "New sketch on axis / on face" entries are disabled
//     while a sketch is already open (you can't nest sketches), and the
//     Finish Sketch row is disabled while in model mode (no sketch to finish).
//
// Implementation is a useMemo over the base menu + studio mode — no extra
// state, and React re-renders just when mode flips.

// Sketch-mode toolbar SVG glyphs reused as menu icons so the swapped Create
// menu reads identically to the toolbar above it.
const ICON_ARC = "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.3' stroke-linecap='round' width='14' height='14'><path d='M2.5 13 A10.5 10.5 0 0 1 13 2.5'/><circle cx='2.5' cy='13' r='1' fill='currentColor' stroke='none'/><circle cx='13' cy='2.5' r='1' fill='currentColor' stroke='none'/></svg>";
// Custom-submenu marker glyph (a small folder-like shape) + a 12-tooth cog icon
// for the Cog leaf item.
const ICON_CUSTOM = "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round' width='14' height='14'><path d='M2.5 5.5 V12 a1 1 0 0 0 1 1 H12.5 a1 1 0 0 0 1 -1 V6 a1 1 0 0 0 -1 -1 H8 L6.5 3.5 H3.5 a1 1 0 0 0 -1 1 Z'/></svg>";
const ICON_COG = "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.2' stroke-linejoin='round' stroke-linecap='round' width='14' height='14'><path d='M8 2.4 L9 2.4 L9.4 4 L10.7 4.5 L12 3.6 L12.7 4.3 L11.8 5.6 L12.3 6.9 L13.9 7.3 L13.9 8.3 L12.3 8.7 L11.8 10 L12.7 11.3 L12 12 L10.7 11.1 L9.4 11.6 L9 13.2 L8 13.2 L7 13.2 L6.6 11.6 L5.3 11.1 L4 12 L3.3 11.3 L4.2 10 L3.7 8.7 L2.1 8.3 L2.1 7.3 L3.7 6.9 L4.2 5.6 L3.3 4.3 L4 3.6 L5.3 4.5 L6.6 4 L7 2.4 Z'/><circle cx='8' cy='8' r='2.2'/></svg>";
const ICON_OFFSET = "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round' width='14' height='14'><rect x='2' y='2' width='8' height='8'/><rect x='6' y='6' width='8' height='8' stroke-dasharray='1.5 1.5'/></svg>";
const ICON_MEASURE = "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round' width='14' height='14'><path d='M2 11 L11 2 L14 5 L5 14 Z'/><path d='M4 9 L5.5 10.5'/><path d='M6.5 7 L8 8.5'/><path d='M9 4.5 L10.5 6'/></svg>";
const ICON_DIM = "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round' width='14' height='14'><path d='M3 4 L3 12'/><path d='M13 4 L13 12'/><path d='M3 8 L13 8'/><path d='M3 8 L5 6.5 M3 8 L5 9.5'/><path d='M13 8 L11 6.5 M13 8 L11 9.5'/></svg>";
const ICON_CONSTR = "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-dasharray='2 2.4' width='14' height='14'><path d='M2 8 L14 8'/></svg>";
const ICON_IMAGE = "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.2' stroke-linejoin='round' stroke-linecap='round' width='14' height='14'><rect x='2' y='3.5' width='12' height='9' rx='0.5'/><circle cx='5.5' cy='6.5' r='1.1'/><path d='M2.5 12 L6 8 L9 10.5 L11 8.5 L13.5 12'/></svg>";
const ICON_EXTRUDE = "<svg viewBox='0 0 16 16' fill='none' stroke='currentColor' stroke-width='1.2' stroke-linejoin='round' stroke-linecap='round' width='14' height='14'><rect x='3' y='10' width='10' height='3.5'/><path d='M8 9 L8 2.5 M5.5 5 L8 2.5 L10.5 5'/></svg>";

const SKETCH_MENU_CHILDREN: MenuItem[] = [
  { id: 'cr-sk-select',    type: 'action', label: 'Select',          icon: '➤',          action: 'studio:tool:select',    visible: true, disabled: false, children: [] },
  { id: 'cr-sk-line',      type: 'action', label: 'Line',            icon: '／',         action: 'studio:tool:line',      visible: true, disabled: false, children: [] },
  { id: 'cr-sk-rect',      type: 'action', label: 'Rectangle',       icon: '▭',          action: 'studio:tool:rect',      visible: true, disabled: false, children: [] },
  { id: 'cr-sk-circle',    type: 'action', label: 'Circle / Oval',   icon: '◯',          action: 'studio:tool:circle',    visible: true, disabled: false, children: [] },
  { id: 'cr-sk-arc',       type: 'action', label: 'Arc',             icon: ICON_ARC,     action: 'studio:tool:arc',       visible: true, disabled: false, children: [] },
  {
    id: 'cr-sk-custom', type: 'submenu', label: 'Custom', icon: ICON_CUSTOM, visible: true, disabled: false,
    children: [
      { id: 'cr-sk-custom-cog', type: 'action', label: 'Cog', icon: ICON_COG, action: 'studio:tool:cog', visible: true, disabled: false, children: [] },
    ],
  },
  { id: 'cr-sk-sep-1',     type: 'separator' },
  { id: 'cr-sk-fillet',    type: 'action', label: 'Fillet',          icon: '◜',          action: 'studio:tool:fillet',    visible: true, disabled: false, children: [] },
  { id: 'cr-sk-chamfer',   type: 'action', label: 'Chamfer',         icon: '◹',          action: 'studio:tool:chamfer',   visible: true, disabled: false, children: [] },
  { id: 'cr-sk-offset',    type: 'action', label: 'Offset',          icon: ICON_OFFSET,  action: 'studio:tool:offset',    visible: true, disabled: false, children: [] },
  { id: 'cr-sk-construct', type: 'action', label: 'Construction',    icon: ICON_CONSTR,  action: 'studio:construction',   visible: true, disabled: false, children: [] },
  { id: 'cr-sk-sep-2',     type: 'separator' },
  { id: 'cr-sk-measure',   type: 'action', label: 'Measure',         icon: ICON_MEASURE, action: 'studio:tool:measure',   visible: true, disabled: false, children: [] },
  { id: 'cr-sk-dimension', type: 'action', label: 'Dimension',       icon: ICON_DIM,     action: 'studio:tool:dimension', visible: true, disabled: false, children: [] },
  { id: 'cr-sk-sep-3',     type: 'separator' },
  { id: 'cr-sk-image',     type: 'action', label: 'Insert Image',    icon: ICON_IMAGE,   action: 'studio:image',          visible: true, disabled: false, children: [] },
  { id: 'cr-sk-sep-4',     type: 'separator' },
  { id: 'cr-sk-extrude',   type: 'action', label: 'Extrude',         icon: ICON_EXTRUDE, action: 'studio:extrude',        visible: true, disabled: false, children: [] },
  { id: 'cr-sk-finish',    type: 'action', label: 'Finish Sketch',   icon: '✓',          action: 'studio:finish',         visible: true, disabled: false, children: [] },
];

function useSketchAwareMenu(baseMenu: MenuRootItem[]): MenuRootItem[] {
  const mode = useStore((s) => s.mode);
  const selectedFeatureId = useStore((s) => s.selectedFeatureId);
  const features = useStore((s) => s.doc.features);
  const projectHasDefault = useStore((s) => Boolean(s.projectMeta.defaultRootId));
  const vfsAppReady = useVfsAppReady();
  return useMemo<MenuRootItem[]>(() => {
    const inSketch = mode === 'sketch';
    const inAssembly = mode === 'assembly';
    // Open browses the application 'config' roots → needs the app to be ready.
    const canOpen = vfsAppReady;
    // Save / Save As need either the application default root, or a default root
    // already chosen on this project (its own VFS topic / settings).
    const canSave = vfsAppReady || projectHasDefault;
    // Advanced ▸ extrude-profile items enable only for a selected extrude.
    const sel = features.find((f) => f.id === selectedFeatureId);
    const isExtrude = sel?.type === 'extrude';
    const hasRegions = isExtrude && Array.isArray((sel as { regionPts?: unknown[] }).regionPts)
      && ((sel as { regionPts?: unknown[] }).regionPts?.length ?? 0) > 0;
    return baseMenu.map((root): MenuRootItem => {
      if (root.id === 'menu-create') {
        // Swap the Create menu's contents wholesale while sketching; disable it
        // entirely while assembling (the model tree is frozen).
        if (inSketch) return { ...root, children: SKETCH_MENU_CHILDREN };
        return {
          ...root,
          disabled: inAssembly,
          children: root.children.map((c): MenuItem => {
            if (c.id !== 'cr-advanced') return c;
            return {
              ...c,
              children: (c.children ?? []).map((ch): MenuItem => {
                if (ch.id === 'cr-adv-reselect') return { ...ch, disabled: !isExtrude };
                if (ch.id === 'cr-adv-reset') return { ...ch, disabled: !hasRegions };
                return ch;
              }),
            };
          }),
        };
      }
      if (root.id === 'menu-file') {
        // Gate Open (needs the application VFS) and Save / Save As (app VFS or a
        // project-level default root).
        return {
          ...root,
          children: root.children.map((c): MenuItem => {
            if (c.id === 'file-open') return { ...c, disabled: !canOpen };
            if (c.id === 'file-save' || c.id === 'file-save-as') return { ...c, disabled: !canSave };
            return c;
          }),
        };
      }
      if (root.id === 'menu-sketch') {
        return {
          ...root,
          disabled: inAssembly,
          children: root.children.map((c): MenuItem => {
            // Block creating another sketch while one is already open.
            if (['sk-top', 'sk-front', 'sk-right', 'sk-face'].includes(c.id)) {
              return { ...c, disabled: inSketch };
            }
            // Finish Sketch only makes sense while in sketch mode.
            if (c.id === 'sk-finish') return { ...c, disabled: !inSketch };
            return c;
          }),
        };
      }
      if (root.id === 'menu-assembly') {
        return {
          ...root,
          children: root.children.map((c): MenuItem => {
            // Enter only outside assembly; everything else only inside it.
            if (c.id === 'as-enter') return { ...c, disabled: inAssembly };
            if (['as-exit', 'as-revolute', 'as-prismatic', 'as-link', 'as-pinslot'].includes(c.id)) {
              return { ...c, disabled: !inAssembly };
            }
            return c;
          }),
        };
      }
      return root;
    });
  }, [baseMenu, mode, selectedFeatureId, features, projectHasDefault, vfsAppReady]);
}

// ── Inner app (rendered inside AppStateProvider) ─────────────────────────

function AppInner({ menuDef }: { menuDef: MenuRootItem[] }) {
  useGlobalActions();
  usePopoutWatcher();
  useStudioActions();
  // Probe VFS readiness once on load (gates Open / Save / Save As).
  useEffect(() => { void refreshVfsStatus(); }, []);
  const liveMenu = useSketchAwareMenu(menuDef);

  return (
    <div className="app">
      <TitleBar />
      <MenuBar menuDef={liveMenu} />
      <MainToolbar />
      <MDIWorkspace />
      <StudioStatusBar />
      {/* Modal dialogs — portalled into document.body, above everything */}
      {/* FloatingPanelManager is rendered inside MDIWorkspace's DragProvider so
          FloatingPanel components can call useDrag(). It portals to document.body. */}
      <ModalManager />
    </div>
  );
}

// ── Root App — async bootstrap, then mount context ───────────────────────

export function App() {
  const [appState, setAppState] = useState<AppState | null>(null);
  const [menuDef,  setMenuDef]  = useState<MenuRootItem[]>([]);
  const [error,    setError]    = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      loadInitialState(),
      fetch('/data/menus/main_menu.json').then(r => r.json() as Promise<MenuRootItem[]>),
    ])
      .then(([state, menu]) => {
        registerShortcutsFromMenuDef(menu);
        setAppState(state);
        setMenuDef(menu);
      })
      .catch(e => setError(String(e)));
  }, []);

  if (error) {
    return (
      <div style={{ padding: 24, color: '#ef5350', fontFamily: 'monospace' }}>
        <h2>Failed to load MDI Framework</h2>
        <pre>{error}</pre>
        <p style={{ marginTop: 8 }}>Ensure you ran <code>npm install</code> and the dev server is running.</p>
      </div>
    );
  }

  if (!appState) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: '#f5a623', fontFamily: 'Segoe UI, sans-serif',
        background: '#1c1c1e', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ fontSize: 32 }}>🗂</div>
        <div style={{ fontSize: 14 }}>Loading MDI Framework…</div>
      </div>
    );
  }

  return (
    <AppStateProvider initialState={appState}>
      <AppInner menuDef={menuDef} />
    </AppStateProvider>
  );
}
