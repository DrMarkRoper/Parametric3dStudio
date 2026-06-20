import type { DocumentPanelState, DocumentContainerState } from '../types';
import { DummyPanel } from './DummyPanel';
import { FeaturesPanel } from './panels/FeaturesPanel';
import { CanvasPanel } from './panels/CanvasPanel';
import { InfoPanel } from './panels/InfoPanel';

// ── Component registry ───────────────────────────────────────────────────
// Add real components here as they are built. DummyPanel is the fallback.

type PanelComponent = React.ComponentType<{
  doc: DocumentPanelState;
  container: DocumentContainerState;
}>;

const COMPONENT_REGISTRY: Record<string, PanelComponent> = {
  DummyPanel,
  FeaturesPanel,
  CanvasPanel,
  InfoPanel,
};

// ── DocumentPanel host ───────────────────────────────────────────────────

interface Props {
  doc: DocumentPanelState;
  container: DocumentContainerState;
}

export function DocumentPanel({ doc, container }: Props) {
  const Component = COMPONENT_REGISTRY[doc.componentType] ?? DummyPanel;
  return <Component doc={doc} container={container} />;
}
