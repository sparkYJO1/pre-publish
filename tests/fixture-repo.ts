import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Tests build real git repositories on disk. A fake object model would let the
 * scanner pass against a git that does not exist; every claim this tool makes
 * is a claim about what git actually does.
 *
 * Every term planted here is invented. Nothing in this repository names a real
 * employer, client or product -- which is the failure the tool exists to catch.
 */

export const TERMS = {
  /** Stands in for an employer product name. */
  product: "Zephyrline",
  /** Stands in for a client organisation name. */
  client: "Norhaven",
  /** Stands in for a non-ASCII spelling of the same organisation. */
  clientKorean: "노르헤이븐",
  /** Stands in for an employer email domain. */
  employerDomain: "zephyrline-internal.example",
  /** AWS's own documentation example key: a real pattern, not a real key. */
  exampleAwsKey: "AKIAIOSFODNN7EXAMPLE",
} as const;

export class Fixture {
  readonly dir: string;

  constructor(prefix = "gitsieve-test-") {
    this.dir = mkdtempSync(join(tmpdir(), prefix));
  }

  git(args: string[], env: Record<string, string> = {}): string {
    return execFileSync("git", args, {
      cwd: this.dir,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
  }

  init(): this {
    this.git(["init", "-q", "-b", "main"]);
    this.git(["config", "user.name", "Test Author"]);
    this.git(["config", "user.email", "test@example.invalid"]);
    this.git(["config", "commit.gpgsign", "false"]);
    return this;
  }

  write(relativePath: string, contents: string): this {
    const full = join(this.dir, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
    return this;
  }

  commit(message: string, identity?: { name: string; email: string }): this {
    this.git(["add", "-A"]);
    const args = ["commit", "-q", "-m", message];
    const env: Record<string, string> = {};
    if (identity) {
      env["GIT_AUTHOR_NAME"] = identity.name;
      env["GIT_AUTHOR_EMAIL"] = identity.email;
      env["GIT_COMMITTER_NAME"] = identity.name;
      env["GIT_COMMITTER_EMAIL"] = identity.email;
    }
    this.git(args, env);
    return this;
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * A repository whose working tree is clean and whose history is not. Each
 * planted finding maps to one channel the scanner must cover.
 */
export function buildLeakyRepo(): Fixture {
  const fixture = new Fixture().init();

  // 1. contents, later deleted: a `git grep` of the working tree misses this.
  fixture.write(
    "src/gateway.ts",
    `export const target = "${TERMS.product} gateway";\n`,
  );
  fixture.write("README.md", "# demo project\n\nA small service.\n");
  fixture.commit("initial import");

  // 2. paths: a directory named after a client, on a side branch.
  fixture.git(["checkout", "-q", "-b", "feature/integration"]);
  fixture.write(
    `vendor/${TERMS.client}/adapter.ts`,
    "export const adapter = 1;\n",
  );
  fixture.commit("add vendor adapter");

  // 3. identities: a commit authored from an employer address.
  fixture.write("src/util.ts", "export const util = 2;\n");
  fixture.commit("tidy utilities", {
    name: "Internal Dev",
    email: `dev@${TERMS.employerDomain}`,
  });

  // 4. messages: the product name in a commit subject.
  fixture.git(["checkout", "-q", "main"]);
  fixture.write("src/app.ts", "export const app = 3;\n");
  fixture.commit(`wire the app to the ${TERMS.product} queue`);

  // 5. non-ASCII contents, then removed from the working tree.
  fixture.write(
    "docs/notes.md",
    `# 메모\n\n${TERMS.clientKorean} 연동 메모.\n`,
  );
  fixture.commit("add integration notes");

  // 6. a credential pattern in history.
  fixture.write("config/dev.env", `AWS_ACCESS_KEY_ID=${TERMS.exampleAwsKey}\n`);
  fixture.commit("add dev env");

  // Clean the working tree, exactly as the real incident's repo looked.
  fixture.git([
    "rm",
    "-q",
    "src/gateway.ts",
    "docs/notes.md",
    "config/dev.env",
  ]);
  fixture.commit("remove leftovers before publishing");

  // 7. refs: a branch named after the product.
  fixture.git(["branch", `legacy/${TERMS.product}-migration`]);

  return fixture;
}
