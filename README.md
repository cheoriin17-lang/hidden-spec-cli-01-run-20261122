# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/cheoriin17-lang/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/cheoriin17-lang/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend — one patch tool for every AI edit format: it applies unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON text-editor tool calls to a tree of text files, exactly per SPEC.md. All or nothing: any edit that fails stops the whole patch and nothing is written.

## Run it

```sh
node main.ts [options] [PATCH]
```

`PATCH` is the patch file, or `-` (or absent) to read it from standard input. `--format=NAME` forces one format (`unified`, `search-replace`, `v4a`, `json`, or `auto`, the default, which detects it). `--check` reports what would happen without writing anything. `--strict` matches lines exactly (tier 0 only). Exit 0 prints the files changed and `ok: <n> files`; exit 1 lists every failed edit; exit 2 is a usage, missing-patch, format or parse error.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9etrdpz6&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
