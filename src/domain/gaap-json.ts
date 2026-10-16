/** Bounded I-JSON decoding for authenticated external bytes, including duplicate-key rejection. */
export class GaapEvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GaapEvidenceError';
  }
}

export function parseGaapJson(
  bytes: Uint8Array,
  options: { maxBytes?: number; integerLiterals?: boolean } = {},
): unknown {
  const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
  if (bytes.byteLength > maxBytes) throw new GaapEvidenceError('json.limit', 'Evidence exceeds its byte limit.');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new GaapEvidenceError('json.utf8', 'Evidence must contain valid UTF-8.');
  }
  const reader = new JsonReader(text, options.integerLiterals ?? false);
  const value = reader.value(0);
  reader.whitespace();
  if (reader.offset !== text.length) reader.reject();
  return value;
}

class JsonReader {
  offset = 0;
  private values = 0;
  constructor(
    private readonly text: string,
    private readonly integerLiterals: boolean,
  ) {}

  reject(): never {
    throw new GaapEvidenceError('json.invalid', 'Evidence requires one bounded I-JSON value with unique object keys.');
  }

  whitespace(): void {
    while (' \t\r\n'.includes(this.text[this.offset] ?? '\0')) this.offset += 1;
  }

  value(depth: number): unknown {
    if (depth > 64 || ++this.values > 1_000_000) this.reject();
    this.whitespace();
    const first = this.text[this.offset];
    if (first === '"') return this.string();
    if (first === '{') return this.object(depth + 1);
    if (first === '[') return this.array(depth + 1);
    for (const [token, value] of [
      ['null', null],
      ['true', true],
      ['false', false],
    ] as const) {
      if (this.text.startsWith(token, this.offset)) {
        this.offset += token.length;
        return value;
      }
    }
    return this.number();
  }

  private number(): number {
    const start = this.offset;
    if (this.text[this.offset] === '-') this.offset += 1;
    if (this.text[this.offset] === '0') this.offset += 1;
    else {
      if (!this.digit() || this.text[this.offset] === '0') this.reject();
      while (this.digit()) this.offset += 1;
    }
    if (this.text[this.offset] === '.') {
      this.offset += 1;
      if (!this.digit()) this.reject();
      while (this.digit()) this.offset += 1;
    }
    if (['e', 'E'].includes(this.text[this.offset] ?? '')) {
      this.offset += 1;
      if (['+', '-'].includes(this.text[this.offset] ?? '')) this.offset += 1;
      if (!this.digit()) this.reject();
      while (this.digit()) this.offset += 1;
    }
    const token = this.text.slice(start, this.offset);
    const number = Number(token);
    if (this.integerLiterals && (/[.eE]/.test(token) || Object.is(number, -0))) this.reject();
    if (number === 0 && /[1-9]/.test(token.split(/[eE]/, 1)[0]!)) this.reject();
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) this.reject();
    return number;
  }

  private digit(): boolean {
    const character = this.text[this.offset];
    return character !== undefined && character >= '0' && character <= '9';
  }

  private string(): string {
    const start = this.offset++;
    while (this.offset < this.text.length) {
      const character = this.text[this.offset++];
      if (character === '\\') this.offset += 1;
      else if (character === '"') {
        let value: unknown;
        try {
          value = JSON.parse(this.text.slice(start, this.offset));
        } catch {
          return this.reject();
        }
        if (typeof value !== 'string' || !wellFormed(value)) this.reject();
        return value;
      }
    }
    return this.reject();
  }

  private object(depth: number): Record<string, unknown> {
    this.offset += 1;
    const entries: Array<[string, unknown]> = [];
    const keys = new Set<string>();
    this.whitespace();
    if (this.text[this.offset] === '}') {
      this.offset += 1;
      return {};
    }
    while (true) {
      this.whitespace();
      if (this.text[this.offset] !== '"') this.reject();
      const key = this.string();
      if (keys.has(key)) this.reject();
      keys.add(key);
      this.whitespace();
      if (this.text[this.offset++] !== ':') this.reject();
      entries.push([key, this.value(depth)]);
      this.whitespace();
      const separator = this.text[this.offset++];
      if (separator === '}') return Object.fromEntries(entries);
      if (separator !== ',') this.reject();
    }
  }

  private array(depth: number): unknown[] {
    this.offset += 1;
    const values: unknown[] = [];
    this.whitespace();
    if (this.text[this.offset] === ']') {
      this.offset += 1;
      return values;
    }
    while (true) {
      values.push(this.value(depth));
      this.whitespace();
      const separator = this.text[this.offset++];
      if (separator === ']') return values;
      if (separator !== ',') this.reject();
    }
  }
}

function wellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** RFC 8785 identities for GAAP evidence; ThreadLoop's frozen process codec stays separate. */
export function canonicalGaapJson(value: unknown): string {
  const seen = new Set<object>();
  let values = 0;
  const encode = (entry: unknown, depth: number): string => {
    if (depth > 64 || ++values > 1_000_000)
      throw new GaapEvidenceError('json.limit', 'Canonical evidence exceeds its structural limit.');
    if (entry === null) return 'null';
    if (typeof entry === 'boolean') return entry ? 'true' : 'false';
    if (typeof entry === 'string' && wellFormed(entry)) return JSON.stringify(entry);
    if (
      typeof entry === 'number' &&
      Number.isFinite(entry) &&
      (!Number.isInteger(entry) || Number.isSafeInteger(entry))
    )
      return JSON.stringify(entry);
    if (typeof entry !== 'object' || entry === null || seen.has(entry))
      throw new GaapEvidenceError('json.invalid', 'Canonical evidence requires a bounded JSON tree.');
    seen.add(entry);
    if (Array.isArray(entry) && Object.getPrototypeOf(entry) === Array.prototype) {
      const elements: string[] = [];
      for (let index = 0; index < entry.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(entry, index);
        if (!descriptor || !('value' in descriptor))
          throw new GaapEvidenceError('json.invalid', 'Canonical arrays require ordinary data elements.');
        elements.push(encode(descriptor.value, depth + 1));
      }
      return '[' + elements.join(',') + ']';
    }
    if (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null)
      throw new GaapEvidenceError('json.invalid', 'Canonical evidence requires ordinary JSON objects.');
    return (
      '{' +
      Object.keys(entry)
        .sort()
        .map((key) => {
          if (!wellFormed(key))
            throw new GaapEvidenceError('json.invalid', 'Canonical object keys require Unicode scalar text.');
          const descriptor = Object.getOwnPropertyDescriptor(entry, key);
          if (!descriptor || !('value' in descriptor))
            throw new GaapEvidenceError('json.invalid', 'Canonical objects require data properties.');
          return JSON.stringify(key) + ':' + encode(descriptor.value, depth + 1);
        })
        .join(',') +
      '}'
    );
  };
  return encode(value, 0);
}
