export { scan } from "./scan.js";
export type { ScanOptions } from "./scan.js";
export { buildCorpus } from "./corpus.js";
export type { Corpus, TextUnit } from "./corpus.js";
export { deriveControls, verifyControls } from "./controls.js";
export { preflight, isDenyAllIgnoreFile } from "./preflight.js";
export { compileTerm, findMatches, shouldUseWordBoundary } from "./matcher.js";
export { SECRET_PATTERNS } from "./secrets.js";
export {
  loadConfig,
  parseConfig,
  assertTermsFileOutsideRepo,
  ConfigError,
  EMPTY_CONFIG,
} from "./config.js";
export { RealGitRepo, GitError } from "./git.js";
export type { GitRepo, CommitMeta, ObjectMeta } from "./git.js";
export {
  formatReport,
  formatJson,
  exitCodeFor,
  EXIT_OK,
  EXIT_FINDINGS,
  EXIT_UNTRUSTED,
  EXIT_USAGE,
} from "./report.js";
export { main, parseArgs } from "./cli.js";
export * from "./types.js";
