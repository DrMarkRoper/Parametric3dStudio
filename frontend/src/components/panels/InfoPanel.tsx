import type { DocumentPanelState, DocumentContainerState } from '../../types';
import { PropertiesPanel } from '../../studio/components/PropertiesPanel';
import { useRegen } from '../../studio/studioBridge';

interface Props {
  doc: DocumentPanelState;
  container: DocumentContainerState;
}

/** Context-sensitive properties / info panel — wraps the ported PropertiesPanel. */
export function InfoPanel(_props: Props) {
  const { regen } = useRegen();
  return (
    <div className="studio-fill studio-scope">
      <PropertiesPanel params={regen.params} bodies={regen.bodies} />
    </div>
  );
}
