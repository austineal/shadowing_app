export interface PiperPhonemizeModule {
  callMain(args: string[]): number;
}
export function createPiperPhonemize(moduleArg: {
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  locateFile?: (url: string) => string;
  /** Emscripten hook: instantiate the wasm ourselves (e.g. from an already-compiled module). */
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
  ) => object;
  /** Emscripten file-packager hook: supply the .data package instead of downloading it. */
  getPreloadedPackage?: (name: string, size: number) => ArrayBuffer;
}): Promise<PiperPhonemizeModule>;
