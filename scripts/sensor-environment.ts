export type SensorEnvironment = Record<string, string | undefined>;

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
