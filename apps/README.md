# apps/

`api` and `web` are here; `worker` waits for the first queued job.

- `api` — the headless vertical slice (create report → revision → signature → audit event in one
  transaction). See [api/README.md](api/README.md).
- `web` — the shell and the template library, server-rendered, with the installable shell and the
  service-worker allowlist. **P2 step 1**: the editor island is the next milestone, so this app is
  read-only today. See [web/README.md](web/README.md).
- `worker` arrives with the first queued job (export or delivery), not before.

Each arrived with something to assert: `api` with a database contract suite, `web` with search,
faceting and token-projection tests. ADR-0001 fixes the layout, not the order.
