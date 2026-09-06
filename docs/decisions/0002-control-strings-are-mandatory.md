# 0002 — The control-string check is mandatory, not a flag

Status: accepted
Date: 2026-09-06

## Context

The third failure in the incident behind this tool is the one that is hard to
defend against, because it produces no error and no warning.

A second scan was run over the *current* files of the repository and returned
zero. It was wrong. In that shell, `grep` was not `/usr/bin/grep`: it was a
shell function shimming ugrep with `--ignore-files`, which honours
`.gitignore`. The repository's `.gitignore` was a deny-everything whitelist —

```gitignore
*
!allowed/
!allowed/**
```

— so the scanner skipped nearly every file in the repository and reported
success. `git grep` over the same directory returned three matches. The
employer's product name was public for about fifteen minutes.

Nothing about that run looked wrong. The command was right, the exit code was
0, the output was empty, and empty output is what you want to see.

## Decision

**A zero is only reported after the scanner has been observed finding
something.** Before any result is printed, the tool derives one control string
per channel from the repository itself:

| channel      | control derived from                                   |
| ------------ | ------------------------------------------------------ |
| `contents`   | the longest ASCII word in the first text blob, by sorted path |
| `paths`      | the longest path segment in the repository             |
| `messages`   | the longest word across all commit messages            |
| `identities` | the first author email address                          |
| `refs`       | the longest segment of any ref name                     |

Each control is compiled and matched through the *same* `compileTerm` and
`findMatches` functions a real term uses. A control that took a shortcut past
the matcher would verify nothing.

If any control matches zero times, or a channel that plainly has data yields no
control, or no control can be established at all, the run is marked **not
trusted**: exit code 2, and the report prints `THIS RESULT IS NOT TRUSTWORTHY`
above the findings count with the findings described as "whatever the broken
scan happened to see".

Operators can add their own controls in the terms file — a string they know is
in the repository — which are checked the same way.

This is not a `--verify` flag. A verification you can turn off is a
verification that will be off in the run that matters.

## Alternatives considered

**A canary file committed to the repository.** Plant a known string, scan, and
check it is found. Rejected: it requires writing to the repository under audit,
it only covers the `contents` channel, and it does not exist in the history you
are actually trying to check.

**Trusting exit codes.** This is what failed. `grep` exited 0 having read
almost nothing; `git grep` in a shallow clone exited 1 with a truncated corpus.
Both are correct exits from the scanner's point of view.

**Warning instead of blocking.** Rejected on the evidence: the person reading a
pre-publication report is looking for permission to publish. A warning above a
zero reads as a zero.

## Evidence: this caught a real bug in this repository

The first time the tool was pointed at its own repository — after the source
was written but before the first commit — it printed:

```
SCANNER VERIFICATION
  (none established)

WARNINGS
  ! no-controls: no control strings could be established; nothing verified the scanner

FINDINGS (0 across 0 term/channel pairs)
  none

RESULT: GO -- controls verified and no findings.
```

`RESULT: GO -- controls verified` on a run that verified nothing. The repository
had no commits, so every channel was empty, so no control could be derived, so
nothing failed, so the tool declared success. It reproduced its own founding
failure on the second day of its existence.

The fix is that an empty control set is itself an untrusted result:

```
THIS RESULT IS NOT TRUSTWORTHY
  x no control string could be established, so nothing verified that the
    scanner reads anything at all

RESULT: NO-GO -- the scan could not be trusted. Fix the reasons above and rerun.
$ echo $?
2
```

The regression test is `tests/control-verification.test.ts`, "a repository with
no commits → is untrusted, not clean". The general rule it encodes: the absence
of a failure is not a pass.

## Consequences

- A repository containing only binary files cannot verify its `contents`
  channel and is reported untrusted. This is a false alarm, and it is the
  direction the tool errs in deliberately.
- Control derivation costs one extra pass over a corpus already in memory.
- The tool cannot detect a scanner that reads every channel but matches
  incorrectly on some *other* input — controls prove the plumbing, and the
  matcher's own behaviour is covered by unit tests instead
  (`tests/matcher.test.ts`).
