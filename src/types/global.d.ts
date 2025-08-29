// Global window augmentations for compositor runtime
export { }; // ensure this file is a module
declare global {
  interface Window {
    COMPOSITOR_READY?: boolean;
    nodeDone?: (base64Video: string, coverBase64: string) => Promise<void> | void;
    shaderDev?: {
      reload: () => void;
      state: { vert: string; frag: string; log: string; ok: boolean; loading: boolean };
    };
    __COMPOSITOR_RAN?: boolean;
  }
}
