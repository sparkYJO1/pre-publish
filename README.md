# gitsieve

Audit a private repository's **entire git history** before you open-source it,
and get a go/no-go.

It scans every commit on every ref — file contents, path names, commit
messages, author and committer identities, and ref names — against a list of
words you supply: your organisation's name, your products, your clients. Then
it exits non-zero if it finds any of them.

The feature that matters most is the one that sounds like overhead: **it proves
it can find something before it tells you it found nothing.**

```
$ gitsieve --repo . --terms ~/private/terms.json

SCANNER VERIFICATION
  ok   contents    "createReadStream"           1 match(es), derived
  ok   paths       "decisions"                  1 match(es), derived
  ok   messages    "verification"               1 match(es), derived
  ok   identities  "someone@example.com"        1 match(es), derived
  ok   refs        "heads"                      1 match(es), derived

FINDINGS (3 across 2 term/channel pairs)
  [term] client-name -- paths -- 2 match(es)
      vendor/<redacted>/adapter.ts
  [term] client-name -- identities -- 1 match(es)
      commit 8f31a04

RESULT: NO-GO -- 3 finding(s). Do not publish this repository.
$ echo $?
1
```

---

## Why this exists

This tool is not a hypothetical. Earlier this year, publishing a private
repository as open source went wrong in three distinct ways, and every rule in
here comes from one of them.

**1. The confidentiality check ran against a `--depth 1` clone.**
A shallow clone holds one commit of one branch. `git grep` over it is a
perfectly correct command answering a question nobody asked, and it reported
clean.

**2. A full-history scan later found what was actually there.**
37 files under a directory named after an employer's product, roughly 17,900
content matches, employer package names, and commits authored from an employer
email address. Every current file was clean. The history was not, and history
is what `git push` sends.

**3. Worse: a second scan of the *current* files also returned zero, falsely.**
In that shell `grep` was not `/usr/bin/grep`. It was a shell function shimming
[ugrep](https://github.com/Genivia/ugrep) with `--ignore-files`, so it honoured
`.gitignore`. The repository's `.gitignore` was a deny-everything whitelist —
`*` followed by a handful of `!allowed` lines — so the scanner silently skipped
almost every file and exited 0. `git grep` over the same directory returned
three matches.

The employer's product name was public for about fifteen minutes.

None of those three runs produced an error. Two of them produced an empty
result set, which is exactly what a person about to publish wants to see.

---

## What it checks

### Five channels

The worst finding in the real incident was a **directory name**, and the second
worst was an **email address in an author field**. A scanner that only reads
file contents sees neither.

| channel      | what it is                              | why it is in the list                                          |
| ------------ | --------------------------------------- | -------------------------------------------------------------- |
| `contents`   | every text blob in every commit         | the obvious one, and the only one most tools do                 |
| `paths`      | every path that ever existed            | `vendor/<client-name>/…` leaks the client with no file content  |
| `messages`   | every commit message, and tag messages  | "integrate with <product> v2" ships with the repo               |
| `identities` | every author and committer name/email   | `you@employer.example` in `%ae` on every commit you ever made   |
| `refs`       | every branch and tag name               | `feature/<client>-migration` is on the GitHub branch dropdown   |

### Scanner verification (the important one)

Before printing a result, the tool derives a control string per channel from
the repository itself — a real word from a real file, a real path segment, a
real author address — and pushes each through the *same* matcher a real term
uses. Any control that matches zero times means that channel is not being read,
and the whole run is reported as **not trustworthy**, exit code 2, with the
finding count explicitly disclaimed.

You can add your own controls to the terms file: strings you know are in the
repository. They are checked identically.

This is not a flag. A verification you can turn off is a verification that will
be off in the run that matters. Rationale and evidence:
[docs/decisions/0002](docs/decisions/0002-control-strings-are-mandatory.md).

### Preflight

- **Shallow clone** → blocker. `git rev-parse --is-shallow-repository`. There is
  no scan that can rescue a corpus of one commit. `--allow-shallow` downgrades
  it to a warning if you know what you are doing.
- **Single-branch clone** → warning, when `remote.origin.fetch` does not cover
  `refs/heads/*`. Branches outside that refspec were never fetched.
- **Deny-all `.gitignore`** → warning. A `*` + `!allowed` whitelist is a normal
  thing to write and an auditing hazard: every tool that honours ignore files
  will skip most of the repository and report it clean. `gitsieve` itself
  reads objects from git, not files from disk, so it is unaffected — but the
  next person to run ripgrep in that directory will be.

### Non-ASCII terms

Terms are literal strings, never regexes, and word boundaries are applied only
when the term itself starts and ends with an ASCII word character.

`\b` in a regex is defined against `[A-Za-z0-9_]`. It never fires next to a
Hangul syllable, a kana, or a Han character. A term list built on
`\b<term>\b` therefore matches **nothing at all** for exactly the terms most
likely to be the organisation's real internal vocabulary. In the incident this
tool comes from, the terms included Korean spellings of the same names.

```ts
// tests/matcher.test.ts
findMatches(compileTerm({ id: "ko", value: "노르헤이븐" }).regex, "노르헤이븐 연동 메모");
// => 1 match

findMatches(compileTerm({ id: "ko", value: "노르헤이븐", wholeWord: "always" }).regex,
            "노르헤이븐 연동 메모");
// => 0 matches — the bug this design avoids
```

### Secret patterns

A short list of prefix-anchored credential patterns (AWS key ids, GitHub
tokens, PEM private key blocks, Slack, Stripe, Google API keys, npm tokens,
JWTs) runs as a **secondary** check. It is not the headline. See below.

---

## "gitleaks and trufflehog exist. Why this?"

They are better than this tool at what they do, and you should run one of them
too. They are not substitutes for each other.

**gitleaks and trufflehog find secrets.** Keys, tokens, credentials — things
with a recognisable shape, often verified live against the issuing service.
Hundreds of rules, years of tuning. `gitsieve` ships nine patterns and no
verification, and will not catch what they catch.

**They do not find organisation-owned vocabulary,** because it has no shape. A
product name is a word. A client name is a word. No entropy heuristic and no
regex library knows that one particular ordinary-looking noun is the one you
are contractually forbidden from publishing. Only you know that, which is why
this tool's core input is a list *you* write.

Concretely, against the real incident:

| what actually leaked                             | a secret scanner finds it? |
| ------------------------------------------------ | -------------------------- |
| a directory named after the employer's product    | no — it is a path, not a secret, and most secret scanners scan blob contents |
| an employer email address in the commit author field | no — `%ae` is not part of the scanned corpus |
| the product name in 17,900 lines of past commits  | no — it is an ordinary word with no entropy signature |
| Korean spellings of the same names                | no — non-ASCII names are not in any rule set |
| an API key                                        | **yes** — but there wasn't one |

The leak was not an API key. It was a client's name in a directory path and an
employer's address in an author field.

**And neither of them tells you when they read nothing.** That is the specific
failure that put a product name in public: a scanner that skipped almost every
file, exited 0, and printed nothing. Every tool in this category is one shell
alias away from that. This one refuses to report a zero it has not just
verified.

Run gitleaks for secrets. Run this for the words only you know are dangerous,
and for the reassurance that the scan happened at all.

---

## False positives, and the suppression list

**When a term is also a common word.** It happens: an organisation called Delta
or Nova or Prism will match the geometry code, the CSS, and the changelog.
There is no clever fix, so the tool does three unclever things instead:

1. **Word boundaries by default for ASCII terms.** `Zephyr` matches
   `vendor/Zephyr-adapter/x.ts` and does not match `Zephyrline`.
   `wholeWord: "never"` widens it, `"always"` narrows it.
2. **`channels` per term.** A term that is only dangerous in a path
   (`{ "value": "Delta", "channels": ["paths", "refs"] }`) stops generating
   noise from prose.
3. **`suppress` entries, each with a mandatory `reason`.** A suppression
   without a stated reason is rejected by the config parser. An unexplained
   hole in an audit is worse than a noisy audit.

```json
{
  "suppress": [
    {
      "termId": "delta",
      "channel": "contents",
      "pathPrefix": "src/geometry/",
      "reason": "delta as in difference; unrelated to the organisation name"
    }
  ]
}
```

**How the suppression list avoids becoming a leak vector.** Two rules:

- **Suppressions reference a term by `id`, never by value.** Passing a `value`
  or `term` field is a hard config error, with that reason in the message. A
  suppression file that repeated the sensitive string would be the leak it was
  written to prevent.
- **The terms file itself must live outside the repository being scanned.**
  The tool refuses a `--terms` path inside the repo and exits 3. That file is a
  list of exactly the strings you are trying not to publish; committing it into
  the repository you are about to publish is the whole problem in miniature.
  `--allow-terms-in-repo` exists for terms that are genuinely not sensitive.

So a repository can carry `gitsieve.config.json` with its suppressions and
its `id`s, and the file that maps those ids to real words stays in your home
directory, your password manager, or your CI secrets.

**Reports redact by default.** Findings print the term id and location, not the
matched text. `--show-matches` reveals context for terms; secret matches are
never printed, with or without the flag. A report pasted into a ticket or a CI
log must not become the leak.

**Known false negatives**, stated plainly:

- An ASCII term next to an underscore. `Zephyrline` does not match
  `ZEPHYRLINE_QUEUE_URL`, because `_` is a word character and the boundary does
  not fire. Use `wholeWord: "never"` if that matters to you.
- Terms split across lines, obfuscated, or base64-encoded in history.
- Content inside binary blobs, which are skipped after a NUL-byte check, and
  blobs over `--max-blob-bytes` (2 MiB), which are reported as a warning rather
  than skipped silently.
- A term that is not on your list. This tool cannot tell you what you forgot.

---

## Install and use

```bash
git clone https://github.com/sparkYJO1/gitsieve
cd gitsieve
npm install && npm run build
node dist/cli.js --repo /path/to/repo --terms ~/private/terms.json
```

Node 20+. No runtime dependencies — it shells out to `git` and nothing else.

### Terms file

```json
{
  "terms": [
    { "id": "org", "value": "Norhaven" },
    { "id": "org-ko", "value": "노르헤이븐" },
    { "id": "product", "value": "Zephyrline", "channels": ["contents", "paths", "refs"] },
    { "id": "employer-mail", "value": "zephyrline-internal.example" },
    "AnotherName"
  ],
  "controls": [
    { "value": "a string you know is in this repository", "channel": "contents" }
  ],
  "suppress": [
    { "termId": "org", "channel": "contents", "pathPrefix": "docs/", "reason": "…" }
  ],
  "secrets": true
}
```

A bare string is shorthand for `{ "id": s, "value": s }`. See
[`gitsieve.config.example.json`](gitsieve.config.example.json).

### Options

```
--repo <path>            repository to audit (default: .)
--terms <file.json>      terms, suppressions and controls
--json                   machine-readable report on stdout
--show-matches           print matched text instead of a redaction placeholder
--allow-shallow          scan a shallow clone anyway, as a warning not a blocker
--allow-terms-in-repo    permit a terms file stored inside the audited repo
--no-reflog              scan refs only, ignoring the reflog
--no-secrets             skip the secondary credential patterns
--max-blob-bytes <n>     do not read blobs larger than this (default 2097152)
```

### Exit codes

| code | meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| 0    | go — controls verified and no findings                              |
| 1    | no-go — findings                                                    |
| 2    | no-go — the scan could not be trusted; the number it printed means nothing |
| 3    | usage or configuration error                                        |

`0` and `2` are the pair that matters. Most tools collapse them.

---

## What this does not do

- **It does not rewrite history.** It tells you where a finding is. Removing it
  means `git filter-repo`, or publishing a fresh repository with no history.
- **It is not a secret scanner.** Nine patterns, no live verification. Run
  gitleaks or trufflehog alongside it.
- **It does not read submodules, LFS objects, or `.git/objects` that no ref or
  reflog entry reaches.** Unreachable objects are not pushed, but they are in a
  `.git` directory you hand over by copying.
- **It does not know your terms.** Everything depends on the list you write.
  It cannot tell you the word you forgot, and a clean report against a short
  list means very little.
- **It does not scan GitHub.** Issues, pull request titles, release notes,
  wiki, Actions logs and repository description are all outside a git
  repository and all publishable. Check them by hand.
- **It does not detect a leak that is a paraphrase.** A sentence that
  identifies an organisation without naming it -- "our largest customer's
  internal platform" -- is not a string match.
- **It is not legal advice about what you may publish.**

---

## Development

```bash
npm run typecheck
npm test          # 46 tests; each builds real git repositories in a temp dir
npm run selfcheck # build, then audit this repository with itself
```

The tests do not mock git. Every fixture is a real repository with planted
findings across history, branches, path names, commit messages and author
fields, and the suite asserts each one is found. It also includes a test that
hands the scanner a deliberately broken git — one whose object reader silently
returns nothing, reproducing the shimmed-`grep` failure — and proves the
control check fails loudly instead of reporting the repository clean.

Every term in the test fixtures is invented. Nothing in this repository names a
real employer, client or product, which is the failure it exists to catch.

---

## Provenance

The incident is real and the decisions are mine. The code was written with
[Claude](https://claude.com/claude-code) against those decisions, and I
reviewed every line of it. The two architecture decision records in
[`docs/decisions/`](docs/decisions/) carry the reasoning and the terminal
transcripts behind the two choices that were not obvious — including an
approach that looked right, produced a plausible result, and turned out to miss
the exact category of finding that caused the incident.

## Licence

MIT. See [LICENSE](LICENSE).
