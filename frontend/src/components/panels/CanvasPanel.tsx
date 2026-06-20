import type { DocumentPanelState, DocumentContainerState } from '../../types';
import { Viewport } from '../../studio/components/Viewport';
import { StudioFileInputs, useRegen } from '../../studio/studioBridge';

interface Props {
  doc: DocumentPanelState;
  container: DocumentContainerState;
}

/** 3D canvas — wraps the ported Viewport and the hidden file inputs. The
 *  modelling status (mode hint, grid, snap, cursor) is rendered in the MDI
 *  status bar instead, so the canvas panel stays a clean viewport area. */
export function CanvasPanel(_props: Props) {
  const { regen, rev } = useRegen();
  return (
    <div className="studio-canvas studio-scope">
      <div className="viewport-host">
        <Viewport bodies={regen.bodies} rev={rev} params={regen.params} />
      </div>
      <StudioFileInputs />
    </div>
  );
}
