import { randomBytes, randomUUID, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Store, UserRecord, ApiKeyRecord } from './store.js';
import { AccessControl, publicUser, publicApiKey, digestToken, accessError } from './access.js';

const scrypt = promisify(scryptCallback);
const timestamp = () => new Date().toISOString();
const membership = z.object({ projectId: z.string().uuid(), role: z.enum(['viewer', 'operator']) }).strict();
const fields = { name: z.string().trim().min(1).max(80), email: z.email().max(254).transform(value => value.toLowerCase()), role: z.enum(['admin', 'member']), memberships: z.array(membership).max(1000), disabled: z.boolean() };
const password = z.string().min(12, 'Use at least 12 characters.').max(200);
const createInput = z.object({ name: fields.name, email: fields.email, role: fields.role.default('member'), memberships: fields.memberships.default([]), password }).strict();
const updateInput = z.object(fields).partial().strict();
const keyInput = z.object({ name: z.string().trim().min(1).max(80), projectIds: z.array(z.string().uuid()).min(1).max(1000), permission: z.enum(['read', 'write']), expiresInDays: z.number().int().min(1).max(365).default(90) }).strict();

/** Sessions, API keys and deployment triggers issued by the user all lose authority together. */
export function revokeUserCredentials(store: Store, userId: string) {
  store.state.sessions = store.state.sessions.filter(session => session.userId !== userId);
  store.state.apiKeys = store.state.apiKeys.filter(key => key.userId !== userId);
  for (const [serviceId,hook] of Object.entries(store.state.githubWebhooks)) if (hook.issuerId===userId) delete store.state.githubWebhooks[serviceId];
  for (const [serviceId, issuer] of Object.entries(store.state.deployTokenOwners)) if (issuer === userId) { delete store.state.deployTokens[serviceId]; delete store.state.deployTokenOwners[serviceId]; }
}

export function registerAccounts(app: FastifyInstance, store: Store, access: AccessControl) {
  const parameter = (request: FastifyRequest) => z.string().uuid().parse((request.params as { id: string }).id);
  const find = (id: string) => { const user = store.state.users.find(item => item.id === id); if (!user) throw accessError(404, 'User not found.'); return user; };
  function validateMemberships(memberships: UserRecord['memberships']) {
    if (new Set(memberships.map(item => item.projectId)).size !== memberships.length) throw accessError(400, 'Each project may only appear once.');
    if (memberships.some(item => !store.state.projects.some(project => project.id === item.projectId))) throw accessError(400, 'One or more projects do not exist.');
  }
  function assertEmail(email: string, userId?: string) { if (store.state.users.some(user => user.id !== userId && user.email === email)) throw accessError(409, 'An account with this email already exists.'); }
  app.get('/api/users', async request => { access.requireGlobal(request); return store.state.users.map(publicUser); });
  app.post('/api/users', async (request, reply) => {
    access.requireGlobal(request);
    const input = createInput.parse(request.body); validateMemberships(input.memberships); assertEmail(input.email);
    const salt = randomBytes(16).toString('hex');
    const hash = (await scrypt(input.password, salt, 64) as Buffer).toString('hex');
    access.requireGlobal(request); assertEmail(input.email); validateMemberships(input.memberships);
    const user: UserRecord = { id: randomUUID(), name: input.name, email: input.email, role: input.role, memberships: input.memberships, disabled: false, createdAt: timestamp(), updatedAt: timestamp(), hash, salt };
    store.state.users.push(user); store.activity('User created', user.email); store.save();
    return reply.status(201).send(publicUser(user));
  });
  app.patch('/api/users/:id', async request => {
    const actor = access.requireGlobal(request), user = find(parameter(request)), input = updateInput.parse(request.body);
    if (user.role === 'owner' && (actor.user.id !== user.id || input.role !== undefined || input.disabled !== undefined || input.memberships !== undefined)) throw accessError(403, 'The owner account and its privileges are protected.');
    if (input.email) assertEmail(input.email, user.id);
    if (input.memberships) validateMemberships(input.memberships);
    const privilegesChanged = input.role !== undefined || input.memberships !== undefined || input.disabled !== undefined || input.email !== undefined;
    Object.assign(user, input, { updatedAt: timestamp() });
    if (privilegesChanged) revokeUserCredentials(store, user.id);
    if (user.role === 'owner') store.state.owner = { name: user.name, email: user.email, hash: user.hash, salt: user.salt };
    store.activity('User updated', user.email); store.save(); return publicUser(user);
  });
  app.delete('/api/users/:id', async request => {
    const actor = access.requireGlobal(request), user = find(parameter(request));
    if (user.role === 'owner') throw accessError(403, 'The owner account cannot be deleted.');
    if (actor.user.id === user.id) throw accessError(400, 'You cannot delete your own active account.');
    revokeUserCredentials(store, user.id); store.state.users = store.state.users.filter(item => item.id !== user.id); store.activity('User deleted', user.email); store.save(); return { ok: true };
  });
  app.post('/api/users/:id/password', async request => {
    let actor = access.requireGlobal(request), user = find(parameter(request));
    if (user.role === 'owner' && actor.user.id !== user.id) throw accessError(403, 'Only the owner can change the owner password.');
    const input = z.object({ password }).strict().parse(request.body), salt = randomBytes(16).toString('hex');
    const hash = (await scrypt(input.password, salt, 64) as Buffer).toString('hex');
    actor = access.requireGlobal(request); user = find(parameter(request));
    if (user.role === 'owner' && actor.user.id !== user.id) throw accessError(403, 'Only the owner can change the owner password.');
    user.hash = hash; user.salt = salt; user.updatedAt = timestamp(); revokeUserCredentials(store, user.id);
    if (user.role === 'owner') store.state.owner = { name: user.name, email: user.email, hash, salt };
    store.activity('User password reset', user.email); store.save(); return { ok: true, sessionsRevoked: true, apiKeysRevoked: true };
  });
  app.get('/api/api-keys', async request => { const actor = access.requireCookie(request); return store.state.apiKeys.filter(key => key.userId === actor.user.id).map(publicApiKey); });
  app.post('/api/api-keys', async (request, reply) => {
    const actor = access.requireCookie(request), input = keyInput.parse(request.body);
    const projectIds = [...new Set(input.projectIds)];
    for (const projectId of projectIds) access.requireProject(request, projectId, input.permission);
    if (store.state.apiKeys.filter(key => key.userId === actor.user.id).length >= 30) throw accessError(400, 'Revoke an existing key before creating more than 30 keys.');
    const token = `hl_${randomBytes(32).toString('base64url')}`;
    const key: ApiKeyRecord = { id: randomUUID(), userId: actor.user.id, name: input.name, projectIds, permission: input.permission, prefix: token.slice(0, 10), createdAt: timestamp(), expiresAt: new Date(Date.now() + input.expiresInDays * 86400000).toISOString(), hash: digestToken(token) };
    store.state.apiKeys.push(key); store.activity('API key created', key.name); store.save(); return reply.status(201).send({ ...publicApiKey(key), token });
  });
  app.delete('/api/api-keys/:id', async request => {
    const actor = access.requireCookie(request), keyId = parameter(request);
    const key = store.state.apiKeys.find(item => item.id === keyId && item.userId === actor.user.id);
    if (!key) throw accessError(404, 'API key not found.');
    store.state.apiKeys = store.state.apiKeys.filter(item => item.id !== key.id); store.activity('API key revoked', key.name); store.save(); return { ok: true };
  });
}
