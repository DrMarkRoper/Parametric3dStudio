import type { DocumentPanelState, DocumentContainerState } from '../../types';
import { AssemblyLinksSection } from '../../studio/components/PropertiesPanel';
import { useRegen } from '../../studio/studioBridge';

interface Props {
  doc: DocumentPanelState;
  container: DocumentContainerState;
}

/** Assembly-mode Links tab — links list + selected-link editor. */
export function LinksPanel(_props: Props) {
  const { regen } = useRegen();
  return (
    <div className="studio-fill studio-scope">
      <div className="props-panel">
        <div className="props-title">LINKS</div>
        <div className="hint" style={{ marginBottom: 8 }}>
          Couple two joints by a ratio. Cog-to-cog ratios can auto-derive from tooth counts.
        </div>
        <AssemblyLinksSection params={regen.params} />
      </div>
    </div>
  );
}
