import type { Template } from '../shared/types.js';
export const templates: Template[] = [
  { id: 'nginx', name: 'Nginx', description: 'A fast, lightweight web server and reverse proxy.', category: 'Web servers', kind: 'app', image: 'nginx:1.28-alpine', port: 80, website: 'https://nginx.org' },
  { id: 'postgres', name: 'PostgreSQL', description: 'A reliable relational database for your applications.', category: 'Databases', kind: 'postgres', image: 'postgres:17-alpine', port: 5432, website: 'https://www.postgresql.org' },
  { id: 'redis', name: 'Redis', description: 'Fast in-memory storage for caching and queues.', category: 'Databases', kind: 'redis', image: 'redis:7-alpine', port: 6379, website: 'https://redis.io' },
  { id: 'mysql', name: 'MySQL', description: 'The familiar relational database.', category: 'Databases', kind: 'mysql', image: 'mysql:8.4', port: 3306, website: 'https://www.mysql.com' },
  { id: 'mariadb', name: 'MariaDB', description: 'A community-developed relational database.', category: 'Databases', kind: 'mariadb', image: 'mariadb:11.4', port: 3306, website: 'https://mariadb.org' },
  { id: 'mongo', name: 'MongoDB', description: 'A document database for flexible data models.', category: 'Databases', kind: 'mongo', image: 'mongo:8', port: 27017, website: 'https://www.mongodb.com' },
  { id: 'uptime-kuma', name: 'Uptime Kuma', description: 'Keep an eye on your websites and services.', category: 'Monitoring', kind: 'app', image: 'louislam/uptime-kuma:1', port: 3001, website: 'https://github.com/louislam/uptime-kuma', mounts: [{ name: 'data', mountPath: '/app/data' }] },
  { id: 'dozzle', name: 'Dozzle', description: 'Container log viewer. Requires separate agent configuration; no Docker socket is mounted.', category: 'Monitoring', kind: 'app', image: 'amir20/dozzle:v8', port: 8080, website: 'https://dozzle.dev' },
  { id: 'vaultwarden', name: 'Vaultwarden', description: 'An independent password management server. Configure HTTPS before use.', category: 'Productivity', kind: 'app', image: 'vaultwarden/server:1.34.3', port: 80, website: 'https://github.com/dani-garcia/vaultwarden', env: { SIGNUPS_ALLOWED: 'false' }, mounts: [{ name: 'data', mountPath: '/data' }] },
  { id: 'whoami', name: 'Whoami', description: 'A tiny HTTP service to test your deployment and domains.', category: 'Developer tools', kind: 'app', image: 'traefik/whoami:v1.11', port: 80, website: 'https://github.com/traefik/whoami' }
];
