export interface EnvironmentParseError { line: number; message: string }
export interface EnvironmentParseResult { env: Record<string, string>; errors: EnvironmentParseError[] }
export const environmentKey = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function environmentValueError(key: string, value: string): string | undefined {
  if (!environmentKey.test(key)) return 'Use letters, numbers and underscores; start with a letter or underscore.';
  if (key === '__proto__' || key === 'constructor') return 'This variable name is reserved by the API. Choose another name.';
  if (value.length > 16000) return 'A value cannot exceed 16,000 characters.';
  if (/[\r\n\0]/.test(value)) return 'Multiline values and null characters are not supported. Encode multiline secrets before use.';
  return undefined;
}

/** Project values are defaults; a service value, including an empty string, overrides them. */
export function effectiveServiceEnvironment(service: { env: Record<string, string> }, project: Record<string, string> = {}): Record<string, string> {
  return { ...project, ...service.env };
}

/** A non-evaluating, single-line .env parser. Never expand variables or execute shell syntax. */
export function parseEnvironmentText(text: string): EnvironmentParseResult {
  const env: Record<string, string> = Object.create(null);
  const errors: EnvironmentParseError[] = [];
  if (text.length > 256 * 1024) return { env, errors: [{ line: 1, message: 'The import is too large. Use at most 262,144 characters.' }] };
  const seen = new Map<string, number>();
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = index + 1;
    const content = lines[index].trim();
    if (!content || content.startsWith('#')) continue;
    const assignment = /^(?:export\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*=(.*)$/.exec(content);
    if (!assignment) { errors.push({ line, message: 'Expected NAME=value. Comments must start with #.' }); continue; }
    const key = assignment[1];
    if (seen.has(key)) { errors.push({ line, message: `Duplicate variable ${key}; first defined on line ${seen.get(key)}.` }); continue; }
    seen.set(key, line);
    const raw = assignment[2].trim();
    let value = '', valid = true;
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const quote = raw[0];
      let position = 1, closed = false;
      for (; position < raw.length; position++) {
        const character = raw[position];
        if (character === quote) { closed = true; position++; break; }
        if (quote === '"' && character === '\\') {
          const next = raw[++position];
          if (next === undefined) break;
          if (next === 'n' || next === 'r') { errors.push({ line, message: 'Escaped newlines are not supported. Encode multiline secrets before use.' }); valid = false; break; }
          value += next === 't' ? '\t' : ['"', '\\', '$'].includes(next) ? next : `\\${next}`;
        } else value += character;
      }
      if (!valid) continue;
      if (!closed || !/^\s*(?:#.*)?$/.test(raw.slice(position))) { errors.push({ line, message: 'Close the quoted value on this line; only a comment may follow it.' }); continue; }
    } else value = raw.replace(/\s+#.*$/, '').trimEnd();
    const error = environmentValueError(key, value);
    if (error) { errors.push({ line, message: error }); continue; }
    if (Object.keys(env).length >= 200) { errors.push({ line, message: 'Use at most 200 variables.' }); continue; }
    Object.defineProperty(env, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return { env, errors };
}
