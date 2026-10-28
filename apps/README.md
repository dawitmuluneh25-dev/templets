# apps/

Empty on purpose. `web` (Next.js App Router shell), `api` (Fastify + Zod) and `worker`
(BullMQ) are created when there is something for them to serve:

- `api` arrives with P1 step 8 — the headless vertical slice (create report → revision →
  signature → audit event in one transaction).
- `web` arrives with P1 step 9 — the shell and editor island, built against the prototype as a
  behavioural reference.
- `worker` arrives with the first queued job (export or delivery), not before.

Creating them now would mean three packages that build but assert nothing. ADR-0001 fixes the
layout, not the order.
