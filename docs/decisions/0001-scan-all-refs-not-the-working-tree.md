# 0001 — Scan every ref and every commit, not the working tree

Status: accepted
Date: 2026-09-06

## Context

The check this tool replaces was a `git grep` over a `--depth 1` clone. It
returned zero and the repository was published. A later full-history scan of
the same repository found, in past commits, 37 files under a directory named
after an employer's product, roughly 17,900 content matches, employer package
names, and commits authored from an employer email address. The working tree
was genuinely clean. The history was not.

So the question is not "what should we grep for" but "what is the corpus".

## Decision

The corpus is every object reachable from every ref, plus the reflog, and it is
built from git plumbing rather than from the filesystem:

| channel      | source                                                    |
| ------------ | --------------------------------------------------------- |
| `contents`   | `git rev-list --objects --all --reflog` → `git cat-file --batch` |
| `paths`      | `git log --all --reflog -m --name-only` + `git ls-tree -r -t` per ref |
| `messages`   | `git log --all --reflog --format=…%B`                     |
| `identities` | the same log's `%an %ae %cn %ce`                            |
| `refs`       | `git for-each-ref --format=%(refname)`                     |

A shallow clone is a **blocker**, not a warning. `--allow-shallow` downgrades
it, and the report then carries the warning.

## Evidence: a shallow clone answers "clean" with confidence

Set-up: a repository where a term is present in the first commit and removed in
the second.

```
$ git clone -q --depth 1 file://$PWD/origin shallow
$ cd shallow
$ git rev-parse --is-shallow-repository
true
$ git rev-list --all --count
1
$ git grep -i acmeproduct                          # working tree
$ echo $?
1                                                   # "no matches"
$ git grep -i acmeproduct $(git rev-list --all)     # "all history"
$ echo $?
1                                                   # still "no matches"
```

The same two commands in the full repository:

```
$ git grep -i acmeproduct $(git rev-list --all)
e6d368b:src/leak.ts:const gateway = "ACMEPRODUCT_GATEWAY";
```

`git rev-list --all` is a correct command. In a shallow clone it enumerates one
commit, and grepping one commit is not a history check no matter how the loop
is written. Detecting the clone shape is the only defence.

## What we tried first and had to abandon

**Enumerating paths from `git rev-list --objects --all`.** It is the obvious
choice: one command, deduplicated, gives a sha and a path for every blob and
tree. It is also wrong for the finding that mattered most in the real incident,
which was a *directory name*.

```
$ mkdir -p src vendor/acmeproduct
$ echo 'shared content line' > src/a.txt
$ cp src/a.txt vendor/acmeproduct/a.txt
$ git add -A && git commit -qm "two paths, same content"

$ git rev-list --objects --all
cbb1d72…                                    # commit
247ff8a…                                    # root tree
1788c3a… src
d8fceb9… src/a.txt
312f8a1… vendor
```

`vendor/acmeproduct` is not in that list, and neither is the file under it.
Git objects are content-addressed, so the tree for `vendor/acmeproduct` has the
same sha as the tree for `src` — identical entries — and `rev-list` prints each
object once, under the first path it met. The directory name exists only as an
entry inside its parent tree.

`git ls-tree -r -t` of that same commit shows what was actually there:

```
040000 tree 1788c3a…  src
100644 blob d8fceb9…  src/a.txt
040000 tree 312f8a1…  vendor
040000 tree 1788c3a…  vendor/acmeproduct
100644 blob d8fceb9…  vendor/acmeproduct/a.txt
```

So paths come from `git log --name-only` instead. That has its own hole:
without `-m`, a path introduced only by a merge commit is never printed.

```
$ git log --all --name-only --pretty=format: | sort -u
base.txt
m.txt
pkg/acmeproduct/f.txt                # evil/clientname/g.txt is missing

$ git log --all -m --name-only --pretty=format: | sort -u
base.txt
evil/clientname/g.txt                # only -m finds it
m.txt
pkg/acmeproduct/f.txt
```

The final path enumeration is `git log --all --reflog -m --name-only` unioned
with `git ls-tree -r -t` at each ref tip. Directory names need no special
handling once file paths are complete: every directory that ever existed is a
prefix of some file path that ever existed, and the term matcher runs over the
whole path string.

Blob *contents* still come from `git rev-list --objects`, where deduplication
is a feature — identical content is scanned once.

## Consequences

- Cost is proportional to history, not to the working tree. Measured on a
  laptop against a 740-commit repository — 4,870 objects, 1,073 text blobs,
  6.8 MB scanned — the full five-channel run takes 2.2 s. Acceptable for
  something that runs once, before publication.
- Objects reachable only from the reflog are included by default. They are not
  transferred by `git push`, but they are in the `.git` directory being handed
  over if a repository is published by copying rather than pushing.
  `--no-reflog` turns this off.
- Findings in history cannot be fixed by deleting a file. The report says where
  a finding is; removing it means rewriting history or publishing a fresh
  repository with no history at all.
