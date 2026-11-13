// Independent specification model. No contract validators, adapter or runtime imports.
import type { Drift, Observation, Scenario, Step } from './scenario.js';

type Claim = Observation['claims'][number] & { actor: 'a' | 'b'; closedAt: number | null };
type Attempt = Observation['attempts'][number] & { started: boolean };
type Report = { fingerprint: string; accepted: boolean };
export class ControllerModel {
  readonly retry: Scenario['retry'];
  time = 0;
  drift: Drift = 'none';
  revision = 0;
  request = 'open';
  claims: Claim[] = [];
  attempts: Attempt[] = [];
  receipts = new Map<number, Report>();
  conflicts: Observation['conflicts'] = [];
  private recovery = new Map<number, { at: number; kinds: string[] }[]>();
  private controls = new Set<number>();
  private conflictContents = new Set<string>();
  private grants = new Map<number, string>();
  private deliveries = new Set<number>();
  private changedDeliveries = new Set<number>();
  private reports = new Map<number, { step: Extract<Step, { kind: 'receipt' }>; time: number }>();

  constructor(scenario: Scenario) {
    this.retry = scenario.retry;
  }
  private conflict(namespace: string, identity: string, content = '') {
    const key = JSON.stringify([namespace, identity, content]);
    if (!this.conflictContents.has(key)) {
      this.conflictContents.add(key);
      this.conflicts.push({ namespace, identity });
    }
  }
  private close(claim: Claim, status: string) {
    claim.status = status;
    claim.closedAt = this.time;
    const attempt = this.attempts.find((item) => item.slot === claim.slot)!;
    if (attempt.status === 'pending' || attempt.status === 'running')
      attempt.status = attempt.started ? 'unknown_outcome' : status === 'cancelled' ? 'cancelled' : 'interrupted';
  }
  private validClaim(claim: Claim | undefined): claim is Claim {
    return claim !== undefined && claim.status === 'active' && claim.deadline > this.time;
  }
  apply(step: Step, index: number): void {
    if (step.kind === 'clock') {
      this.time += step.by;
      return;
    }
    if (step.kind === 'drift') {
      this.drift = step.field;
      return;
    }
    if (['restart', 'evaluate', 'untrusted', 'human_request', 'terminal', 'executor_transition'].includes(step.kind))
      return;
    if (step.kind === 'receipt' && step.fault === 'malformed') return;
    const control =
      ['cancel', 'invalidate', 'expire', 'reconcile'].includes(step.kind) ||
      (step.kind === 'redeliver' && this.controls.has(step.index));
    if (this.drift === 'graph' && !control) return;
    if (step.kind === 'redeliver') {
      if (!this.deliveries.has(step.index)) return;
      if (!step.changed || this.changedDeliveries.has(step.index)) return;
      this.revision++;
      this.changedDeliveries.add(step.index);
      this.conflict('operation', `operation_${step.index}`);
      return;
    }
    if (step.kind === 'receipt_replay') {
      const original = this.reports.get(step.identity);
      if (!original) return;
      this.revision++;
      this.deliveries.add(index);
      if (step.changed) this.conflict('receipt', `receipt_${step.identity}`, 'changed replay');
      return;
    }
    this.revision++;
    this.deliveries.add(index);
    if (control) this.controls.add(index);
    if (step.kind === 'register_duplicate') return;
    if (step.kind === 'register_conflict') {
      if (this.drift === 'none') this.conflict('request', 'request');
      return;
    }
    if (step.kind === 'cancel' || step.kind === 'invalidate') {
      if (step.kind === 'cancel' && (step.actor === 'executor' || this.drift === 'authority')) return;
      if (step.kind === 'invalidate' && this.drift === 'authority') return;
      if (this.request !== 'open' && step.kind !== 'invalidate') return;
      this.request = step.kind === 'cancel' ? 'cancelled' : 'invalidated';
      for (const claim of this.claims) if (claim.status === 'active') this.close(claim, this.request);
      return;
    }
    const claim = 'slot' in step ? this.claims.find((item) => item.slot === step.slot) : undefined;
    if (step.kind === 'expire') {
      if (this.drift !== 'authority' && claim?.status === 'active' && claim.deadline <= this.time)
        this.close(claim, 'expired');
      return;
    }
    if (step.kind === 'reconcile') {
      const attempt = this.attempts.find((item) => item.slot === step.slot);
      const kinds =
        step.proof === 'missing'
          ? []
          : step.proof === 'contradictory'
            ? ['executor_stopped', 'no_effect', 'effect_occurred']
            : [
                'executor_stopped',
                ...(step.disposition === 'no_effect_confirmed'
                  ? ['no_effect']
                  : step.disposition === 'effect_confirmed'
                    ? ['effect_occurred']
                    : []),
              ];
      const retained = this.recovery.get(step.slot) ?? [];
      retained.push({ at: this.time, kinds });
      this.recovery.set(step.slot, retained);
      const all = new Set(
        retained.filter((entry) => claim && entry.at >= (claim.closedAt ?? 0)).flatMap((entry) => entry.kinds),
      );
      if (attempt?.effect === 'none') all.add('no_effect');
      if (attempt?.effect === 'occurred') all.add('effect_occurred');
      if (
        step.actor !== 'human' ||
        this.drift === 'authority' ||
        !claim ||
        claim.status === 'active' ||
        !attempt ||
        attempt.resolution !== null ||
        attempt.status === 'succeeded' ||
        !kinds.includes('executor_stopped') ||
        (all.has('no_effect') && all.has('effect_occurred'))
      )
        return;
      attempt.resolution = step.disposition;
      if (this.request === 'open' && step.disposition !== 'no_effect_confirmed') {
        this.request = step.disposition === 'effect_confirmed' ? 'satisfied' : 'cancelled';
        for (const current of this.claims) if (current.status === 'active') this.close(current, 'cancelled');
      }
      return;
    }
    if (step.kind === 'receipt') {
      // Admission conditions aren't receipt content. Only public report fields identify redelivery.
      const fingerprint = JSON.stringify([
        step.slot,
        claim?.version ?? step.slot + 1,
        claim?.actor ?? 'a',
        step.identity,
        step.status,
        step.effect,
        this.time + (step.fault === 'future' ? 1 : 0),
        step.fault === 'binding',
        step.fault === 'digest',
      ]);
      this.reports.set(step.identity, this.reports.get(step.identity) ?? { step, time: this.time });
      const previous = this.receipts.get(step.identity);
      if (previous) {
        if (previous.fingerprint !== fingerprint) this.conflict('receipt', `receipt_${step.identity}`, fingerprint);
        return;
      }
      const attempt = this.attempts.find((item) => item.slot === step.slot);
      const accepted =
        this.validClaim(claim) &&
        this.request === 'open' &&
        this.conflicts.length === 0 &&
        this.drift === 'none' &&
        attempt?.status === 'running' &&
        step.fault === 'none' &&
        !(step.status === 'succeeded' && step.effect === 'unknown');
      this.receipts.set(step.identity, { fingerprint, accepted });
      if (accepted && claim && attempt) {
        attempt.status = step.effect === 'unknown' ? 'unknown_outcome' : step.status;
        attempt.effect = step.effect;
        attempt.receipt = step.identity;
        claim.status = 'completed';
        if (step.status === 'succeeded') this.request = 'satisfied';
      }
      return;
    }
    if (step.kind === 'acquire' || step.kind === 'replace') {
      const fingerprint = JSON.stringify([
        step.kind,
        step.slot,
        step.actor,
        this.time + step.lease,
        step.kind === 'replace' ? (this.claims.at(-1)?.slot ?? null) : null,
      ]);
      const original = this.grants.get(step.slot);
      if (original !== undefined) {
        if (original !== fingerprint) this.conflict('claim', `claim_${step.slot}`, fingerprint);
        return;
      }
      this.grants.set(step.slot, fingerprint);
      if (
        this.conflicts.length ||
        this.request !== 'open' ||
        this.drift !== 'none' ||
        this.claims.some((item) => item.status === 'active') ||
        this.attempts.length >= 8
      )
        return;
      const previous = this.claims.at(-1);
      if ((step.kind === 'acquire') !== (previous === undefined)) return;
      if (previous) {
        const priorAttempt = this.attempts.at(-1)!;
        if (
          priorAttempt.resolution === 'abandon' ||
          (priorAttempt.started &&
            priorAttempt.effect !== 'none' &&
            priorAttempt.resolution !== 'no_effect_confirmed' &&
            this.retry !== 'repeatable_with_overlap')
        )
          return;
        const kinds = new Set(
          (this.recovery.get(previous.slot) ?? [])
            .filter((entry) => entry.at >= (previous.closedAt ?? 0))
            .flatMap((entry) => entry.kinds),
        );
        if (
          kinds.has('effect_occurred') &&
          (kinds.has('no_effect') ||
            priorAttempt.effect === 'none' ||
            priorAttempt.resolution === 'no_effect_confirmed')
        )
          return;
        previous.status = 'replaced';
      }
      this.claims.push({
        slot: step.slot,
        version: this.claims.length + 1,
        actor: step.actor,
        status: 'active',
        closedAt: null,
        deadline: this.time + step.lease,
      });
      this.attempts.push({
        slot: step.slot,
        status: 'pending',
        effect: 'not_started',
        receipt: null,
        resolution: null,
        started: false,
      });
      return;
    }
    if (
      !('actor' in step) ||
      this.conflicts.length ||
      this.request !== 'open' ||
      this.drift !== 'none' ||
      !this.validClaim(claim) ||
      claim.actor !== step.actor
    )
      return;
    const attempt = this.attempts.find((item) => item.slot === claim.slot)!;
    if (step.kind === 'start' && attempt.status === 'pending') {
      attempt.status = 'running';
      attempt.effect = 'unknown';
      attempt.started = true;
    } else if (step.kind === 'renew') {
      if (this.time + 20 > claim.deadline) claim.deadline = this.time + 20;
    } else if (step.kind === 'release') this.close(claim, 'released');
  }
  observe(): Observation {
    const last = this.claims.at(-1);
    const unresolved = this.attempts.some(
      (item) =>
        item.resolution === null &&
        (item.effect === 'unknown' || (item.effect === 'occurred' && item.status !== 'succeeded')),
    );
    let execution = 'idle';
    if (this.drift === 'graph') execution = 'invalid';
    else if (this.conflicts.length || this.request === 'invalidated' || this.drift !== 'none')
      execution = 'reconciliation_required';
    else if (last?.status === 'active') execution = last.deadline > this.time ? 'in_flight' : 'reconciliation_required';
    else if (unresolved) execution = 'reconciliation_required';
    return {
      revision: this.revision,
      request: this.request,
      claims: this.claims.map(({ slot, version, status, deadline }) => ({ slot, version, status, deadline })),
      attempts: this.attempts.map(({ slot, status, effect, receipt, resolution }) => ({
        slot,
        status,
        effect,
        receipt,
        resolution,
      })),
      receipts: [...this.receipts].map(([identity, report]) => ({ identity, accepted: report.accepted })),
      conflicts: this.conflicts,
      execution,
    };
  }
}
