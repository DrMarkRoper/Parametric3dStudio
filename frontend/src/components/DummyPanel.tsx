import type { DocumentPanelState, DocumentContainerState } from '../types';

interface Props {
  doc: DocumentPanelState;
  container: DocumentContainerState;
}

// Formats a value with a CSS class for colour coding
function Val({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="val-null">null</span>;
  if (typeof v === 'boolean') return <span className={v ? 'val-true' : 'val-false'}>{String(v)}</span>;
  if (typeof v === 'number') return <span className="val-num">{String(v)}</span>;
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="val-null">[]</span>;
    return <span className="val-array">["{v.join('", "')}"]</span>;
  }
  if (typeof v === 'object') return <span className="val-array">{JSON.stringify(v)}</span>;
  return <span>{String(v)}</span>;
}

function Row({ label, value }: { label: string; value: unknown }) {
  return (
    <tr>
      <td>{label}</td>
      <td><Val v={value} /></td>
    </tr>
  );
}

export function DummyPanel({ doc, container }: Props) {
  const panelEmoji: Record<string, string> = {
    Explorer:        '🗂',
    'Text Editor A': '📝',
    'Text Editor B': '📝',
    'Preview Viewer':'👁',
    Properties:      '⚙️',
    Inspector:       '🔬',
    Output:          '📋',
    Console:         '💻',
    Terminal:        '⬛',
  };

  const icon = panelEmoji[doc.title] ?? '📄';

  return (
    <div className="dummy-panel">
      <div className="dummy-panel-heading">
        <span style={{ fontSize: 20 }}>{icon}</span>
        {doc.title}
        <span style={{ color: 'var(--text-dim)', fontWeight: 400, fontSize: 11 }}>
          — DummyPanel
        </span>
      </div>

      {/* Panel / Document options */}
      <div className="dummy-panel-section">
        <div className="dummy-panel-section-title">Document Panel Config</div>
        <table className="dummy-table">
          <tbody>
            <Row label="instanceId"         value={doc.instanceId} />
            <Row label="componentType"      value={doc.componentType} />
            <Row label="allowClose"         value={doc.allowClose} />
            <Row label="killOnClose"        value={doc.killOnClose} />
            <Row label="allowAsTab"         value={doc.allowAsTab} />
            <Row label="restrictToTabTypes" value={doc.restrictToTabTypes} />
            <Row label="toolbarMenus"       value={doc.toolbarMenus} />
            <Row label="width.fixed"        value={doc.width.fixed} />
            <Row label="width.default"      value={doc.width.default} />
            <Row label="closedState"        value={doc.closedState} />
          </tbody>
        </table>
      </div>

      {/* Parent container options */}
      <div className="dummy-panel-section">
        <div className="dummy-panel-section-title">Parent Container Config</div>
        <table className="dummy-table">
          <tbody>
            <Row label="instanceId"         value={container.instanceId} />
            <Row label="allowTabs"          value={container.allowTabs} />
            <Row label="allowClose"         value={container.allowClose} />
            <Row label="allowDragMove"      value={container.allowDragMove} />
            <Row label="forbidDropBefore"   value={container.forbidDropBefore} />
            <Row label="forbidDropAfter"    value={container.forbidDropAfter} />
            <Row label="forceCloseOnEmpty"  value={container.forceCloseOnEmpty} />
            <Row label="killOnClose"        value={container.killOnClose} />
            <Row label="resizable"          value={container.resizable} />
            <Row label="restrictTabToTypes" value={container.restrictTabToTypes} />
            <Row label="rowId"              value={container.rowId} />
            <Row label="rowIndex"           value={container.rowIndex} />
            <Row label="widthPercent"       value={Math.round(container.widthPercent * 10) / 10} />
            <Row label="documentCount"      value={container.documentIds.length} />
          </tbody>
        </table>
      </div>

      {/* Default container options if present */}
      {doc.defaultContainerOptions && (
        <div className="dummy-panel-section">
          <div className="dummy-panel-section-title">Default Container Options (for drop-create)</div>
          <table className="dummy-table">
            <tbody>
              {Object.entries(doc.defaultContainerOptions).map(([k, v]) => (
                <Row key={k} label={k} value={v} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ color: 'var(--text-dim)', fontSize: 10, marginTop: 8, fontStyle: 'italic' }}>
        This panel is a placeholder. Replace with your real React component.
      </div>
    </div>
  );
}
