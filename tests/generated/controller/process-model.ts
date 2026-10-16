// Independent expectations for the implemented one-Attempt bridge; no GAAP resumption semantics.
import { z } from 'zod';
export const processHistorySchema = z.strictObject({
  schema: z.literal('threadloop.generated-process-history/1'),
  mode: z.enum(['success', 'block', 'failed', 'interrupted', 'effect_response_lost', 'effect_publication_lost']),
  fault: z.enum([
    'none',
    'dispatch.before_commit',
    'dispatch.after_commit',
    'observation.before_commit',
    'admission.prepared',
    'admission.blobs',
    'admission.result',
    'admission.after_commit',
  ]),
  steps: z.array(z.enum(['run', 'admit', 'restart', 'evaluate', 'mutate', 'inspect', 'cancel'])).max(32),
});
export type ProcessHistory = z.infer<typeof processHistorySchema>;
export class ProcessModel {
  launches = 0;
  observations = 0;
  admitted = 0;
  request = 'open';
  attempt = 'pending';
  changed = false;
  private hit = false;
  private snapshotMatches = true;
  private cancelled = false;
  constructor(private history: ProcessHistory) {}
  private fault(point: ProcessHistory['fault']) {
    if (this.hit || this.history.fault !== point) return false;
    this.hit = true;
    return true;
  }
  apply(step: ProcessHistory['steps'][number]): string {
    if (step === 'mutate') {
      this.changed = true;
      this.snapshotMatches = false;
      return 'mutated';
    }
    if (step === 'restart') return 'restarted';
    if (step === 'inspect') return 'inspected';
    if (step === 'evaluate') return 'evaluated';
    if (step === 'run') {
      if (this.launches || !this.snapshotMatches) return 'thrown';
      if (this.fault('dispatch.before_commit')) return 'thrown';
      this.launches = 1;
      this.attempt = 'running';
      if (this.fault('dispatch.after_commit')) return 'thrown';
      const lost = this.history.mode.startsWith('effect_');
      if (lost) {
        this.changed = true;
        this.snapshotMatches = false;
      }
      if (this.fault('observation.before_commit')) return 'thrown';
      this.observations = 1;
      if (lost || this.cancelled) return 'uncertain';
      return this.admit();
    }
    if (step === 'cancel') {
      // A pre-aborted real dispatch still commits its start and launch intent, then records cancellation.
      if (this.launches || !this.snapshotMatches) return 'thrown';
      if (this.fault('dispatch.before_commit')) return 'thrown';
      this.launches = 1;
      this.attempt = 'running';
      if (this.fault('dispatch.after_commit')) return 'thrown';
      if (this.fault('observation.before_commit')) return 'thrown';
      this.cancelled = true;
      this.observations = 1;
      return 'uncertain';
    }
    if (!this.observations || this.history.mode.startsWith('effect_') || this.cancelled || !this.snapshotMatches)
      return 'thrown';
    if (this.admitted) return 'already_admitted';
    const outcome = this.admit();
    return outcome === 'rejected' ? 'thrown' : outcome;
  }
  private admit() {
    if (this.fault('admission.prepared') || this.fault('admission.blobs') || this.fault('admission.result'))
      return 'rejected';
    this.admitted = 1;
    const success = this.history.mode === 'success';
    this.request = success ? 'satisfied' : 'open';
    this.attempt = success ? 'succeeded' : 'unknown_outcome';
    if (this.fault('admission.after_commit')) return 'committed_with_warning';
    return 'admitted';
  }
  observe() {
    return {
      launches: this.launches,
      observations: this.observations,
      admitted: this.admitted,
      request: this.request,
      attempt: this.attempt,
      changed: this.changed,
    };
  }
}
