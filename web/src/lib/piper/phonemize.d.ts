export interface PiperPhonemizeModule {
  callMain(args: string[]): number;
}
export function createPiperPhonemize(moduleArg: {
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  locateFile?: (url: string) => string;
}): Promise<PiperPhonemizeModule>;
