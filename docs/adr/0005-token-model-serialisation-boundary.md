# ADR-0005 — One serialisation boundary, versioned from the first row

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** project owner; tech lead (role unfilled)
- **Relates to:** production plan §3.4, §6.3, §10; ADR-0001; plan decision A7

## Context

A report is a token stream: text, typed field references and breaks, grouped into sections.
The same document is rendered to plain text, standalone HTML, PDF, FHIR `presentedForm` and
(eventually) DICOM SR — on the client for preview, on the server for the archived artefact.
Signed reports are evidence: a signature is a hash over content, so content must have exactly
one canonical form.

The prototype already enforces the invariant `render(parse(t)) === t` for all 427 templates.
That invariant is what makes fidelity testable. It survives only if serialisation is a single
implementation: two serialisers drift, and once they drift the hash in a signature no longer
means what it claims.

## Decision

1. **`packages/tokens` is the only module permitted to parse or serialise a token stream.**
   Public surface: `parse`, `serialize`, `render(format)`, `hash`, `migrate`. Every other
   package consumes the typed AST.
2. **Stored format is the canonical token string**, not the editor's document model. The
   ProseMirror document is a *view* rebuilt from tokens; ProseMirror JSON is never persisted.
   This keeps the archive independent of the editor library (risk R12).
3. **Renderers are pure functions of the AST.** No renderer may reparse text to recover
   structure. Text, HTML, PDF, FHIR and SR are five renderers over one tree, not five parsers.
4. **Every stored document carries `schema_version`.** `migrate` is total: it either returns a
   current-version document or throws. It is tested against a fixture corpus captured at each
   version, and the fixtures are real documents, not hand-written samples.
5. **The signature hash is computed over the canonical serialised form**, so fixing a renderer
   cannot change a signature. If a fix *must* change canonical form, that is a version bump
   plus a migration, and it is reviewed as one.
6. **Enforced structurally**: `no-restricted-imports` prevents anything outside
   `packages/tokens` from importing its internals, and a dependency-cruiser rule fails the
   build on a violation. Convention documented in a README is not enforcement.

## Consequences

**Accepted:**

- Renderer bugs cannot be fixed by changing canonical output. This will occasionally feel
  pedantic and is the entire point.
- Any format change is a migration with fixtures. That is a real cost per change and it buys
  an archive that survives engine replacement.
- The client cannot be the authority for a signature. Client-side rendering is for preview;
  the server recomputes the hash from the canonical form before signing.

**Made harder:**

- Round-tripping through ProseMirror on every edit requires a cheap token ↔ view mapping.
  Design that in P2 rather than discovering it under load.
- Anyone wanting a quick format tweak has to go through the version path. Budget for the
  conversation.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Persist ProseMirror JSON as the document of record | Couples the archive to a library version. Every ProseMirror upgrade becomes a migration of signed evidence. |
| Serialise only on the server, ship rendered HTML to the client | Kills offline editing, which is a core requirement. |
| Let the editor serialise and trust it | The client cannot be the authority for a signature, and two implementations will drift. |
| Keep renderers but allow each to parse | Reintroduces N parsers, each with its own bracket-depth bugs. |

## Revisit triggers

- The editor engine is replaced → the boundary is exactly what makes that survivable; the
  token format should not need to change.
- DICOM SR export lands → it is a sixth renderer, and any structure the AST cannot express
  becomes a token-model change, reviewed as such.
- A second consumer of the token model appears (e.g. a mobile client) → still one package,
  published internally.
