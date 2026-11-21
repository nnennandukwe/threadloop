import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const descriptor = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value.trim().length > 0 && [...value].every((character) => character.charCodeAt(0) >= 32));

export const runConfigurationInputSchema = z.strictObject({
  harness: descriptor,
  model: descriptor.nullable(),
  proof_plan_path: z.string().min(1),
  runner_skill_path: z.string().min(1),
});

export const runConfigurationSchema = z
  .strictObject({
    schema_version: z.literal('threadloop.run-configuration/1'),
    threadloop_version: z.string().min(1),
    implementation_sha256: digest,
    implementation_scope: z.enum(['source_and_lockfile', 'javascript_bundle', 'npm_bundled_files']),
    storage_schema_version: z.number().int().positive(),
    protocol_components: z.strictObject({
      protocol: z.number().int().positive(),
      proofPlan: z.number().int().positive(),
      sessionNext: z.number().int().positive(),
      signedReviewReceipt: z.number().int().positive(),
      auditEvent: z.number().int().positive(),
      handoff: z.number().int().positive(),
    }),
    caller: z.strictObject({ harness: descriptor, model: descriptor.nullable() }).nullable(),
    proof_plan_sha256: digest.nullable(),
    runner_skill_sha256: digest.nullable(),
  })
  .refine(
    (value) =>
      value.caller === null
        ? value.proof_plan_sha256 === null && value.runner_skill_sha256 === null
        : value.proof_plan_sha256 !== null && value.runner_skill_sha256 !== null,
    { message: 'Caller attribution requires both declared snapshot digests.' },
  );

export type RunConfiguration = z.infer<typeof runConfigurationSchema>;
