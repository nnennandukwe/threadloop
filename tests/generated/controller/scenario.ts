import { z } from 'zod';

const slot = z.number().int().min(0).max(7);
const actor = z.enum(['a', 'b']);
export const driftSchema = z.enum(['none', 'subject', 'state', 'graph', 'policy', 'authority', 'capability']);
export const stepSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['acquire', 'replace']), slot, actor, lease: z.number().int().min(1).max(20) }),
  z.strictObject({ kind: z.enum(['start', 'release', 'renew']), slot, actor }),
  z.strictObject({ kind: z.literal('expire'), slot }),
  z.strictObject({
    kind: z.literal('reconcile'),
    slot,
    actor: z.enum(['human', 'executor']),
    disposition: z.enum(['no_effect_confirmed', 'effect_confirmed', 'abandon']),
    proof: z.enum(['complete', 'missing', 'contradictory']),
  }),
  z.strictObject({ kind: z.literal('cancel'), actor: z.enum(['executor', 'controller', 'human']) }),
  z.strictObject({
    kind: z.literal('receipt'),
    slot,
    identity: slot,
    status: z.enum(['succeeded', 'failed', 'interrupted']),
    effect: z.enum(['none', 'unknown', 'occurred']),
    fault: z.enum(['none', 'digest', 'binding', 'admission', 'expired_admission', 'future', 'malformed']),
  }),
  z.strictObject({ kind: z.literal('receipt_replay'), identity: slot, changed: z.boolean() }),
  z.strictObject({ kind: z.literal('redeliver'), index: z.number().int().min(0).max(255), changed: z.boolean() }),
  z.strictObject({ kind: z.literal('clock'), by: z.number().int().min(1).max(20) }),
  z.strictObject({ kind: z.literal('drift'), field: driftSchema }),
  z.strictObject({
    kind: z.enum([
      'restart',
      'evaluate',
      'register_duplicate',
      'register_conflict',
      'invalidate',
      'untrusted',
      'human_request',
      'terminal',
      'executor_transition',
    ]),
  }),
]);
export const scenarioSchema = z.strictObject({
  schema: z.literal('threadloop.generated-history/1'),
  retry: z.enum(['reconciliation_required', 'repeatable_with_overlap']),
  steps: z.array(stepSchema).max(128),
});
export type Step = z.infer<typeof stepSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
export type Drift = z.infer<typeof driftSchema>;
export interface Observation {
  revision: number;
  request: string;
  claims: { slot: number; version: number; status: string; deadline: number }[];
  attempts: { slot: number; status: string; effect: string; receipt: number | null; resolution: string | null }[];
  receipts: { identity: number; accepted: boolean }[];
  conflicts: { namespace: string; identity: string }[];
  execution: string;
}
