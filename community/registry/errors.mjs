/** Public-safe errors only. Never attach the original database error or connection details. */
export class RegistryError extends Error {
  constructor(code, statusCode, message) { super(message); this.name = 'RegistryError'; this.code = code; this.statusCode = statusCode; }
}
export const unavailable = () => new RegistryError('REGISTRY_UNAVAILABLE', 503, 'The community registry is unavailable.');
export const invalid = () => new RegistryError('INVALID_REGISTRY_INPUT', 400, 'Invalid registry input.');
export const notFound = () => new RegistryError('INSTALLATION_NOT_FOUND', 404, 'Installation not found.');
