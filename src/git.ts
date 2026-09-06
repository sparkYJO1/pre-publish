import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export class GitError extends Error {}

export interface CommitMeta {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}

export interface ObjectMeta {
  sha: string;
  type: "blob" | "tree" | "commit" | "tag";
  size: number;
  /** Path git associated with the object. Absent for commits and tag objects. */
  path?: string;
}

/**
 * The surface the scanner uses. It is an interface so that a test can hand the
 * scanner a deliberately broken git and prove the control check fails loudly
 * instead of reporting a clean repository.
 */
export interface GitRepo {
  readonly root: string;
  isShallow(): boolean;
  refNames(): string[];
  commits(): CommitMeta[];
  /** Every path that has existed in any commit on any ref. */
  paths(): string[];
  objects(): ObjectMeta[];
  /** sha -> raw bytes. Only called for objects returned by objects(). */
  readObjects(shas: string[]): Map<string, Buffer>;
  /** Working-tree file, or null when absent. Used only for .gitignore checks. */
  workingTreeFile(relativePath: string): string | null;
  remoteFetchSpecs(): string[];
}

const FIELD_SEP = "\u0000";
const RECORD_SEP = "\u001e";
const LOG_FORMAT = "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x1e";

export interface RealGitOptions {
  includeReflog?: boolean;
}

export class RealGitRepo implements GitRepo {
  readonly root: string;
  private readonly includeReflog: boolean;

  constructor(root: string, options: RealGitOptions = {}) {
    this.root = root;
    this.includeReflog = options.includeReflog ?? true;
  }

  private run(args: string[], input?: Buffer): Buffer {
    const result = spawnSync("git", args, {
      cwd: this.root,
      input,
      maxBuffer: 512 * 1024 * 1024,
    });
    if (result.error)
      throw new GitError(`git ${args[0]}: ${result.error.message}`);
    if (result.status !== 0) {
      throw new GitError(
        `git ${args.join(" ")} exited ${result.status}: ${result.stderr.toString().trim()}`,
      );
    }
    return result.stdout;
  }

  private tryRun(args: string[]): Buffer | null {
    try {
      return this.run(args);
    } catch {
      return null;
    }
  }

  /** `--all` plus, by default, `--reflog`: an amended commit is still on disk. */
  private historyArgs(): string[] {
    return this.includeReflog ? ["--all", "--reflog"] : ["--all"];
  }

  isShallow(): boolean {
    const out = this.tryRun(["rev-parse", "--is-shallow-repository"]);
    return out?.toString().trim() === "true";
  }

  refNames(): string[] {
    const out = this.tryRun(["for-each-ref", "--format=%(refname)"]);
    if (!out) return [];
    return out.toString("utf8").split("\n").filter(Boolean);
  }

  commits(): CommitMeta[] {
    const out = this.tryRun([
      "log",
      ...this.historyArgs(),
      "--no-color",
      LOG_FORMAT,
    ]);
    if (!out) return [];
    const seen = new Set<string>();
    const commits: CommitMeta[] = [];
    for (const record of out.toString("utf8").split(RECORD_SEP)) {
      const trimmed = record.replace(/^\n+/, "");
      if (!trimmed) continue;
      const fields = trimmed.split(FIELD_SEP);
      if (fields.length < 6) continue;
      const sha = fields[0]!.trim();
      if (!/^[0-9a-f]{7,64}$/.test(sha) || seen.has(sha)) continue;
      seen.add(sha);
      commits.push({
        sha,
        authorName: fields[1]!,
        authorEmail: fields[2]!,
        committerName: fields[3]!,
        committerEmail: fields[4]!,
        message: fields[5]!,
      });
    }
    return commits;
  }

  /**
   * `-m` is load-bearing: without it, a path introduced only by a merge commit
   * ("evil merge") never appears in the output. See docs/decisions/0001.
   */
  paths(): string[] {
    const paths = new Set<string>();
    const log = this.tryRun([
      "log",
      ...this.historyArgs(),
      "-m",
      "--name-only",
      "--no-color",
      "--pretty=format:",
    ]);
    if (log) {
      for (const line of log.toString("utf8").split("\n")) {
        const path = line.trim();
        if (path) paths.add(path);
      }
    }
    // Belt and braces: the full tree at each ref tip, directories included.
    for (const ref of this.refNames()) {
      const tree = this.tryRun(["ls-tree", "-r", "-t", "--name-only", ref]);
      if (!tree) continue;
      for (const line of tree.toString("utf8").split("\n")) {
        const path = line.trim();
        if (path) paths.add(path);
      }
    }
    return [...paths];
  }

  objects(): ObjectMeta[] {
    const listed = this.tryRun([
      "rev-list",
      "--objects",
      ...this.historyArgs(),
    ]);
    if (!listed) return [];
    const pathBySha = new Map<string, string>();
    const shas: string[] = [];
    for (const line of listed.toString("utf8").split("\n")) {
      if (!line) continue;
      const space = line.indexOf(" ");
      const sha = space === -1 ? line : line.slice(0, space);
      if (!/^[0-9a-f]{7,64}$/.test(sha)) continue;
      if (pathBySha.has(sha)) continue;
      shas.push(sha);
      pathBySha.set(sha, space === -1 ? "" : line.slice(space + 1));
    }
    if (shas.length === 0) return [];

    const check = this.run(
      ["cat-file", "--batch-check"],
      Buffer.from(shas.join("\n") + "\n", "utf8"),
    );
    const objects: ObjectMeta[] = [];
    for (const line of check.toString("utf8").split("\n")) {
      if (!line) continue;
      const [sha, type, size] = line.split(" ");
      if (!sha || !type) continue;
      if (
        type !== "blob" &&
        type !== "tree" &&
        type !== "commit" &&
        type !== "tag"
      )
        continue;
      const path = pathBySha.get(sha);
      objects.push({
        sha,
        type,
        size: Number(size ?? 0),
        ...(path ? { path } : {}),
      });
    }
    return objects;
  }

  readObjects(shas: string[]): Map<string, Buffer> {
    const out = new Map<string, Buffer>();
    const batchSize = 64;
    for (let i = 0; i < shas.length; i += batchSize) {
      const chunk = shas.slice(i, i + batchSize);
      const raw = this.run(
        ["cat-file", "--batch"],
        Buffer.from(chunk.join("\n") + "\n", "utf8"),
      );
      parseBatch(raw, out);
    }
    return out;
  }

  workingTreeFile(relativePath: string): string | null {
    try {
      return readFileSync(join(this.root, relativePath), "utf8");
    } catch {
      return null;
    }
  }

  remoteFetchSpecs(): string[] {
    const out = this.tryRun(["config", "--get-all", "remote.origin.fetch"]);
    if (!out) return [];
    return out.toString("utf8").split("\n").filter(Boolean);
  }
}

/**
 * `git cat-file --batch` frames each object as
 *   "<sha> <type> <size>\n" + <size bytes> + "\n"
 * and a missing object as "<sha> missing\n".
 */
export function parseBatch(raw: Buffer, into: Map<string, Buffer>): void {
  let cursor = 0;
  while (cursor < raw.length) {
    const newline = raw.indexOf(0x0a, cursor);
    if (newline === -1) break;
    const header = raw.subarray(cursor, newline).toString("utf8");
    cursor = newline + 1;
    const parts = header.split(" ");
    if (parts.length < 3) continue; // "<sha> missing"
    const sha = parts[0]!;
    const size = Number(parts[2]);
    if (!Number.isFinite(size)) break;
    into.set(sha, raw.subarray(cursor, cursor + size));
    cursor += size + 1;
  }
}
