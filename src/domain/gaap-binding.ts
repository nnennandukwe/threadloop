import { z } from 'zod';
import { validateControllerInput, type ActionRequest, type ControllerInput } from 'threadloop-contracts/controller';
import type { ExecutionPolicy } from 'threadloop-contracts/execution';
import type { ExecutorRequest, GaapMappingPolicy } from 'threadloop-contracts/executor';
import { canonicalJson } from './canonical-json.js';
import { sha256 } from '../adapters/crypto/sha256.js';

const text = z.string().min(1).max(4096);
const hostSchema = z.strictObject({
  schema_version: z.literal('threadloop.gaap-host/1'),
  executable: text,
  arguments: z.array(text).max(128),
  workspace: text,
  environment: z.record(text, z.string().max(65536)),
  timeout_ms: z.number().int().min(1).max(300000),
  verification: z.strictObject({
    id: text,
    keys: z
      .array(z.strictObject({ key_id: text, public_key_hex: z.string().regex(/^[a-f0-9]{64}$/) }))
      .min(1)
      .max(64),
    implementation: z.strictObject({ name: text, version: text, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }),
  }),
});
const bindingSchema = z.strictObject({
  schema_version: z.literal('threadloop.gaap-binding/1'),
  snapshot: z.custom<ControllerInput>((value) => validateControllerInput(value).ok),
  action_request: z.custom<ActionRequest>((value) => value !== null && typeof value === 'object'),
  // The frozen execution and executor validators check these complete values before registration commits.
  execution_policy: z.custom<ExecutionPolicy>((value) => value !== null && typeof value === 'object'),
  mapping_policy: z.custom<GaapMappingPolicy>((value) => value !== null && typeof value === 'object'),
  parameters: z.custom<ExecutorRequest['request']['parameters']>(
    (value) => value !== null && typeof value === 'object',
  ),
  executor: z.strictObject({ id: text, incarnation: text }),
  lease_ms: z.number().int().min(1).max(300000),
});
export type GaapHost = z.infer<typeof hostSchema>;
export type GaapBinding = z.infer<typeof bindingSchema>;
export function parseGaapHost(value: unknown): GaapHost {
  return hostSchema.parse(value);
}
export function parseGaapBinding(value: unknown): GaapBinding {
  return bindingSchema.parse(value);
}
export function gaapVerificationPolicy(host: GaapHost) {
  return {
    id: host.verification.id,
    digest: sha256(canonicalJson({ schema_version: 'threadloop.gaap-verification/1', ...host.verification })),
  };
}
