# Premerge SIGINT campaign (45 runs)

Serial SIGINT regression against real `premerge.mjs`. The driver **does not** remove Docker containers or networks; any `ic_premerge_*` leftovers after a run indicate a premerge shutdown bug.

## Requirements

- Ubuntu + `sg docker` (same as premerge gates)
- `apps/postgres/.env` with `POSTGRES_PASSWORD`
- Clean git tree at `EXPECTED_SHA` (or use fail-cleanup rows with `IC_PREMERGE_ALLOW_DIRTY=1`)

## Optional outside vault

Start a vault agent outside premerge HOME and point at a marker file:

```bash
OUT=$(mktemp -d /tmp/ic-outside-vault-home-XXXX)
echo ok > "$OUT/marker.txt"
HOME="$OUT" node apps/js-sdk/lib/vault-agent-serve.mjs &
export IC_SIGINT_OUTSIDE_VAULT_MARKER="$OUT/marker.txt"
```

## Run

From repository root:

```bash
node apps/js-sdk/scripts/premerge-sigint-campaign.mjs
```

Output TSV: `PREMERGE_SIGINT_TSV` (default `/tmp/premerge-sigint-final.tsv`).

Each row must show `rc=130`, `tmpLeft=0`, `hit=1`, `premergeAlive=0`, `dockerBefore=0`, `dockerAfter=0` (containers, networks, and volumes), `vaultBefore=0`, `vaultAfter=0` (premerge HOME only), `markerOk=1`.

Clear inherited `PREMERGE_MUTANT` before each run (the driver sets `PREMERGE_MUTANT=` on the child).

The lib's `bash -lc` starts a login shell that resets `PATH`, so an isolated `HOME` needs a `.profile` that puts `node`, `docker`, and other tools on `PATH`.

SIGINT is sent only to the Node PID printed as `premerge: node pid=…` in that run's log (never broad `pgrep`).
