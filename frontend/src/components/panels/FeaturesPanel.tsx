import type { DocumentPanelState, DocumentContainerState } from '../../types';
import { SidePanel } from '../../studio/components/SidePanel';
import { useRegen } from '../../studio/studioBridge';

interface Props {
  doc: DocumentPanelState;
  container: DocumentContainerState;
}

/** Features + Parameters tree — wraps the ported SidePanel. */
export function FeaturesPanel(_props: Props) {
  const { regen } = useRegen();
  return (
    <div className="studio-fill studio-scope">
      <SidePanel
        params={regen.params}
        paramErrors={regen.paramErrors}
        featureErrors={regen.errors}
      />
    </div>
  );
}
