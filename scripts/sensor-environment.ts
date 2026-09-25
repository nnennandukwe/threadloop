import { readFile, stat } from 'node:fs/promises';
import { canonicalJson } from '../src/domain/canonical-json.js';
import { validateDeclaredGate } from '../src/domain/proof.js';

export type SensorEnvironment = Record<string, string | undefined>;

/** The GitHub Actions run a sensor executes in and the session it reports for. Shared by both sensors. */
export function sensorRunContext(environment: SensorEnvironment = process.env) {
  const required = (name: string) => requiredEnvironment(name, environment);
  const sessionId = required('THREADLOOP_SESSION_ID');
  const planSha256 = required('THREADLOOP_PLAN_SHA256');
  const sourceRepository = `${required('GITHUB_SERVER_URL')}/${required('GITHUB_REPOSITORY')}`;
  const sourceRef = required('GITHUB_REF');
  const sourceHead = required('GITHUB_SHA');
  const runInvocationUri =
    `${sourceRepository}/actions/runs/${required('GITHUB_RUN_ID')}` + `/attempts/${required('GITHUB_RUN_ATTEMPT')}`;

  if (!/^session_[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error('THREADLOOP_SESSION_ID must be a ThreadLoop session id.');
  }
  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(sourceRepository)) {
    throw new Error(
      'The reusable sensor requires a canonical https://github.com/<owner>/<repo> URL accessible to the workflow.',
    );
  }
  if (!/^[a-f0-9]{64}$/.test(planSha256)) {
    throw new Error('THREADLOOP_PLAN_SHA256 must be 64 lowercase hexadecimal characters.');
  }
  if (!/^[a-f0-9]{40}$/.test(sourceHead)) {
    throw new Error('GITHUB_SHA must be a full lowercase commit SHA.');
  }
  return { sessionId, planSha256, sourceRepository, sourceRef, sourceHead, runInvocationUri };
}

/**
 * The caller context shared by the gate sensor's run and sign steps. Both steps must admit exactly the same gate,
 * so it is parsed once here: the gate is validated under v4 rules, which admit a declared `setup` array.
 */
export function gateSensorContext(environment: SensorEnvironment = process.env) {
  const run = sensorRunContext(environment);
  const gateId = requiredEnvironment('THREADLOOP_GATE_ID', environment);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(gateId)) {
    throw new Error('THREADLOOP_GATE_ID is invalid.');
  }
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(run.sourceRef)) {
    throw new Error('The reusable sensor accepts only branch refs.');
  }

  const parsedGate = JSON.parse(requiredEnvironment('THREADLOOP_GATE_JSON', environment)) as unknown;
  const gate = validateDeclaredGate(parsedGate, { field: 'THREADLOOP_GATE_JSON', allowSetup: true });
  if (gate.id !== gateId || canonicalJson(gate) !== canonicalJson(parsedGate)) {
    throw new Error('THREADLOOP_GATE_JSON must be the exact declared gate identified by THREADLOOP_GATE_ID.');
  }

  return { ...run, gate };
}

/** Reads a captured sensor report: a bounded regular file, unchanged while read, containing JSON. */
export async function readReport(reportPath: string, maximumBytes: number, label: string): Promise<unknown> {
  const metadata = await stat(reportPath);
  if (!metadata.isFile() || metadata.size > maximumBytes) {
    throw new Error(`Captured ${label} report must be a regular file no larger than ${maximumBytes} bytes.`);
  }
  const reportJson = await readFile(reportPath, 'utf8');
  if (Buffer.byteLength(reportJson) !== metadata.size) {
    throw new Error(`Captured ${label} report changed while it was being read.`);
  }
  try {
    return JSON.parse(reportJson) as unknown;
  } catch {
    throw new Error(`Captured ${label} report must contain JSON.`);
  }
}

export function requiredEnvironment(name: string, environment: SensorEnvironment = process.env) {
  const value = environment[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function positiveIntegerEnvironment(name: string, environment: SensorEnvironment = process.env) {
  const value = requiredEnvironment(name, environment);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive decimal integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe positive integer.`);
  }
  return parsed;
}
