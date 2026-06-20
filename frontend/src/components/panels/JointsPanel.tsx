import type { DocumentPanelState, DocumentContainerState } from '../../types';
import { AssemblyJointsSection, AssemblyWarnings } from '../../studio/components/PropertiesPanel';
import { useRegen } from '../../studio/studioBridge';

interface Props {
  doc: DocumentPanelState;
  container: DocumentContainerState;
}

/** Assembly-mode Joints tab — joints list + selected-joint editor. */
export function JointsPanel(_props: Props) {
  const { regen } = useRegen();
  return (
    <div className="studio-fill studio-scope">
      <div className="props-panel">
        <div className="props-title">JOINTS</div>
        <div className="hint" style={{ marginBottom: 8 }}>
          Non-permanent: leaving Assembly mode returns every body to its design position.
        </div>
        <AssemblyWarnings />
        <AssemblyJointsSection params={regen.params} />
      </div>
    </div>
  );
}
