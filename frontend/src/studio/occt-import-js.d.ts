declare module 'occt-import-js' {
  export interface OcctMeshAttribute {
    array: number[];
  }
  export interface OcctMesh {
    name?: string;
    attributes: { position: OcctMeshAttribute; normal?: OcctMeshAttribute };
    index?: { array: number[] };
    color?: [number, number, number];
  }
  export interface OcctResult {
    success: boolean;
    meshes: OcctMesh[];
  }
  export interface OcctModule {
    ReadStepFile(content: Uint8Array, params: unknown): OcctResult;
    ReadIgesFile(content: Uint8Array, params: unknown): OcctResult;
    ReadBrepFile(content: Uint8Array, params: unknown): OcctResult;
  }
  const init: (opts?: { locateFile?: (file: string) => string }) => Promise<OcctModule>;
  export default init;
}

declare module '*.wasm?url' {
  const url: string;
  export default url;
}
