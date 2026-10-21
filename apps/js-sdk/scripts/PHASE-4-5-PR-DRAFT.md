## Phase 4–5 premerge / SIGINT (draft PR body)

### SIGINT shutdown

- Scoped SIGINT driver (`premerge-sigint-campaign.mjs`): signals only `premerge: node pid=…`.
- Fail-cleanup gate: `fail()` yields 500ms for INT; campaign passes env on the same shell line as `node`.
- **Hang (rc=124) root cause:** after INT, shutdown used slow leg teardown (SIGTERM + 8s waits) and blocking `storage:emu:down` without timeout, so premerge could stay alive until the driver watchdog fired. **Fix:** fast leg teardown on `shuttingDown` (SIGKILL + 250ms caps) and 25s timeout on emu down.

### Docker

- Ephemeral Postgres: `tearDownEphemeralPostgresProject` (`compose down -v --remove-orphans`) on every cleanup path; label `com.infinitecontext.premerge=true`.
- No global prune; campaign checks containers, networks, and volumes before/after each run.

### Mutants

| ID  | Outcome |
|-----|---------|
| M1, M2, M3, M6, M7 | Killed by tests |
| M1b | **Structural kill** — `premerge-shutdown-group-kill.test.mjs` asserts `kill(-pgid)` before per-PID walk; M1b only via `PREMERGE_MUTANT` for redundant-defence integration tests |
