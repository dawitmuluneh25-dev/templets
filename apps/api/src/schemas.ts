import { z } from 'zod';

/**
 * The schemas are the contract: Fastify validates with them and the OpenAPI
 * document is generated from them, so there is no second description of the wire
 * format to fall out of date (ADR-0006, plan §8.1).
 *
 * Rules that are about *shape* live here. Rules that are about *clinical sense* —
 * a required section left empty, a number where a date belongs — belong to
 * `@reporting/validation` and will gate signing, not parsing.
 */

/** A field value. Bounded so that autosave cannot be used as object storage. */
export const fieldValuesSchema = z.record(z.string().max(200), z.string().max(20_000));

export const createReportBodySchema = z
  .object({
    template_version_id: z.uuid(),
    study_instance_uid: z.string().min(1).max(128),
    accession: z.string().min(1).max(64).optional(),
    modality: z.string().min(1).max(16),
    field_values: fieldValuesSchema.optional(),
    /** D3: how many signatures complete the report. 1 is solo sign. */
    approvals_required: z.number().int().min(1).max(5).optional(),
  })
  .strict();

export const saveDraftBodySchema = z.object({ field_values: fieldValuesSchema }).strict();

export const signBodySchema = z
  .object({
    /**
     * The step-up assertion. Optional in the schema so that "not presented" is a
     * `401 step_up_required` from the domain, not a `400` from the validator —
     * the client needs to be able to tell those apart.
     */
    step_up_token: z.string().min(1).max(4096).optional(),
    /** Cross-cover: the user this signature covers for. */
    on_behalf_of: z.uuid().optional(),
  })
  .strict();

export const reportParamsSchema = z.object({ id: z.uuid() });

/** Documentation mirror of `TokenDocument`. Loose: the token union is `tokens`'s to define. */
export const tokenDocumentSchema = z.looseObject({
  schema_version: z.number().int(),
  tokens: z.array(z.looseObject({ kind: z.string() })),
});

export const reportResourceSchema = z.object({
  id: z.uuid(),
  state: z.enum(['draft', 'submitted', 'signed', 'amended', 'returned']),
  template_version_id: z.uuid(),
  revision: z.number().int().min(0),
  approvals_required: z.number().int().min(1).max(5),
  signatures: z.array(
    z.object({
      actor_id: z.uuid(),
      role: z.enum(['author', 'approver', 'delegate']),
      signed_at: z.string(),
    }),
  ),
  document: tokenDocumentSchema,
  field_values: z.record(z.string(), z.string()),
  current_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  signed_at: z.string().nullable(),
});

export const problemDetailsSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string(),
});
