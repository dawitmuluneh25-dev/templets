# apps/

`api` is here; `web` and `worker` are not yet, and each waits for something to serve:

- `api` — the headless vertical slice (create report → revision → signature → audit event in one
  transaction). See [api/README.md](api/README.md).
- `web` arrives with P1 step 9 — the shell and editor island, built against the prototype as a
  behavioural reference.
- `worker` arrives with the first queued job (export or delivery), not before.

Creating the others now would mean packages that build but assert nothing. ADR-0001 fixes the layout,
not the order.
