# corpus/

The specification this product is built against: 427 report templates, their
provenance, and the token streams derived from them.

## Where the raw files are

`corpus/raw` is **`alem-reporting-templates/` at the repository root**, not a directory under this
one. That is deliberate:

- the frozen prototype's baseline command (`node tools/import-templates.mjs`) reads that path, and
  ADR-0001 keeps the prototype runnable;
- a second copy of the specification is a second thing that can drift, and drift in the corpus is
  the one failure this project cannot absorb.

So `corpus/` holds what is *derived*. ADR-0004's decisions — immutable source, provenance-gated,
generated artefacts committed and reproducible — are all satisfied by the arrangement; only the
path differs from the illustrative tree in ADR-0001.

**Never edit `alem-reporting-templates/`.** It is the input, not a working directory. A template
that cannot be imported is quarantined and named, not fixed in place.

## What is here

| Path | Produced by | Reviewed by | Committed |
|---|---|---|---|
| `provenance.json` | `packages/corpus` | a human, per file: author, class, hashes | yes |
| `generated/templates.json` | `packages/corpus` | diffing: a wording change shows up as a diff | yes |
| `generated/quarantine.json` | `packages/corpus` | must stay empty | yes |
| `generated/stats.json` | `packages/corpus` | glance | yes |

Regenerate with `pnpm corpus`. The output is deterministic — sorted, no timestamps, no absolute
paths — so CI regenerates it and fails if the committed copy differs. That is what makes
"reproducible" a test rather than a claim.

## What it proves

```
files              427
imported           427
quarantined        0
round-trip pass    427
fields             2381 (258 templates)
```

`serialize(parse(body)) === body` for every file, byte for byte. This is the P1 exit criterion and
the most important test in the build: every downstream assertion is about a document these tokens
represent, so an importer bug would make the whole suite confidently wrong.

## Two things that change bytes, both recorded

39 files contain escape sequences the exporter leaked (`iterative\u00a0reconstruction` instead of a
space). Decoding them is not a clinical edit — it restores the character the author typed — but it
*is* a transformation, so `provenance.json` records the raw `sha256` before cleaning and the
`body_sha256` after, plus a `transforms` list per file. Nothing is cleaned silently.

The round-trip is asserted against the cleaned body. A file that cannot be reproduced from its
tokens, cleaned or not, is quarantined rather than shipped.

## Provenance is not the scope label

| Class | Files | Meaning |
|---|---|---|
| `third_party` | 130 | named external author (RSNA) |
| `unattributed` | 128 | opaque `auth0\|…` id — 123 of them inside the organisation's own scope |
| `unknown` | 168 | no author at all; provenance unrecoverable from the export |
| `org_authored` | 1 | a named organisation account — and it sits in the *public* scope |

Default deny: a template is usable when its licence position says so, not when its filing category
looks reassuring. See [ADR-0004](../docs/adr/0004-corpus-provenance-and-licensing.md).
