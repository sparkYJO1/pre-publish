import type { GitRepo, ObjectMeta } from "./git.js";
import type { Channel, Warning } from "./types.js";

export interface TextUnit {
  channel: Channel;
  /** Human-readable place, e.g. "src/a.ts (blob 1a2b3c4)". */
  location: string;
  /** Repository path, when the unit has one. Used by suppressions. */
  path?: string;
  text: string;
}

export interface Corpus {
  units: TextUnit[];
  warnings: Warning[];
  /**
   * Reasons the corpus is known to be incomplete. Any entry here makes the
   * whole run untrusted: an incomplete scan that returns zero is exactly the
   * failure this tool exists to prevent.
   */
  integrityProblems: string[];
  stats: {
    commits: number;
    refs: number;
    paths: number;
    objects: number;
    blobsRead: number;
    bytesScanned: number;
  };
}

export interface BuildCorpusOptions {
  maxBlobBytes?: number;
}

const DEFAULT_MAX_BLOB_BYTES = 2 * 1024 * 1024;

function short(sha: string): string {
  return sha.slice(0, 7);
}

/** A blob with a NUL byte near its start is not source text. */
export function looksBinary(buffer: Buffer): boolean {
  const window = buffer.subarray(0, Math.min(buffer.length, 8000));
  return window.includes(0);
}

export function buildCorpus(
  repo: GitRepo,
  options: BuildCorpusOptions = {},
): Corpus {
  const maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  const units: TextUnit[] = [];
  const warnings: Warning[] = [];
  const integrityProblems: string[] = [];

  // --- refs -----------------------------------------------------------------
  const refs = repo.refNames();
  for (const ref of refs) {
    units.push({ channel: "refs", location: ref, text: ref });
  }

  // --- paths ----------------------------------------------------------------
  const paths = repo.paths();
  for (const path of paths) {
    units.push({ channel: "paths", location: path, path, text: path });
  }

  // --- commit messages and identities ---------------------------------------
  const commits = repo.commits();
  for (const commit of commits) {
    units.push({
      channel: "messages",
      location: `commit ${short(commit.sha)}`,
      text: commit.message,
    });
    units.push({
      channel: "identities",
      location: `commit ${short(commit.sha)}`,
      text:
        `author ${commit.authorName} <${commit.authorEmail}>\n` +
        `committer ${commit.committerName} <${commit.committerEmail}>`,
    });
  }

  // --- object contents ------------------------------------------------------
  const objects = repo.objects();
  const readable: ObjectMeta[] = [];
  for (const object of objects) {
    if (object.type !== "blob" && object.type !== "tag") continue;
    if (object.size > maxBlobBytes) {
      warnings.push({
        code: "blob-too-large",
        message: `${object.path ?? short(object.sha)} is ${object.size} bytes; contents not scanned (raise --max-blob-bytes)`,
      });
      continue;
    }
    readable.push(object);
  }

  const bytes = repo.readObjects(readable.map((o) => o.sha));
  let blobsRead = 0;
  let bytesScanned = 0;
  let missing = 0;
  let truncated = 0;

  for (const object of readable) {
    const buffer = bytes.get(object.sha);
    if (!buffer) {
      missing += 1;
      continue;
    }
    if (buffer.length !== object.size) {
      truncated += 1;
      continue;
    }
    if (looksBinary(buffer)) continue;
    blobsRead += 1;
    bytesScanned += buffer.length;
    const text = buffer.toString("utf8");
    if (object.type === "tag") {
      units.push({
        channel: "messages",
        location: `tag object ${short(object.sha)}`,
        text,
      });
    } else {
      units.push({
        channel: "contents",
        location: `${object.path ?? "(unnamed)"} (blob ${short(object.sha)})`,
        ...(object.path ? { path: object.path } : {}),
        text,
      });
    }
  }

  // Silence is the enemy. If git listed an object and we could not read it,
  // say so and mark the run untrusted rather than scanning what is left.
  if (missing > 0) {
    integrityProblems.push(
      `${missing} of ${readable.length} objects were listed by git but returned no content`,
    );
  }
  if (truncated > 0) {
    integrityProblems.push(
      `${truncated} of ${readable.length} objects returned a different byte count than git reported`,
    );
  }

  // Cross-checks between channels. A repository cannot have refs but no
  // commits, or blobs but no paths; if it appears to, a channel was dropped.
  if (refs.length > 0 && commits.length === 0) {
    integrityProblems.push(
      `git listed ${refs.length} refs but no commits; the messages and identities channels were not read`,
    );
  }
  if (readable.length > 0 && paths.length === 0) {
    integrityProblems.push(
      `git listed ${readable.length} readable objects but no paths; the paths channel was not read`,
    );
  }

  return {
    units,
    warnings,
    integrityProblems,
    stats: {
      commits: commits.length,
      refs: refs.length,
      paths: paths.length,
      objects: objects.length,
      blobsRead,
      bytesScanned,
    },
  };
}
