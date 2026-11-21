import type { ControllerDecision, ControllerInput } from 'threadloop-contracts/controller';
import { sha256 } from '../adapters/crypto/sha256.js';
import { canonicalJson } from './canonical-json.js';

type WorkflowGraph = ControllerInput['compiled_graph']['graph'];
export type WorkflowEdge = WorkflowGraph['transitions'][number];
export type WorkflowGuard = WorkflowGraph['guards'][number];
export type WorkflowAction = WorkflowGraph['required_actions'][number];
export type WorkflowReason = Extract<ControllerDecision['decision'], { outcome: 'blocked' }>['reasons'][number];

export function workflowDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}
