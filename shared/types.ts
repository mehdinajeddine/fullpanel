export type ServiceKind = 'app' | 'postgres' | 'mysql' | 'mariadb' | 'mongo' | 'redis' | 'compose';
export type RuntimeMode = 'docker' | 'demo';
export type ServiceStatus = 'running' | 'stopped' | 'deploying' | 'failed' | 'not-deployed';
export interface Project { id: string; name: string; description: string; color: string; createdAt: string }
export interface Source { type: 'image' | 'git' | 'dockerfile' | 'compose'; image?: string; repository?: string; branch?: string; dockerfile?: string; context?: string; compose?: string }
export interface Domain { id: string; hostname: string; port: number; https: boolean; path: string }
export interface Mount { id: string; name: string; mountPath: string }
export interface Port { published: number; target: number; protocol: 'tcp' | 'udp' }
export interface Service {
  id: string; projectId: string; name: string; kind: ServiceKind; status: ServiceStatus;
  source: Source; env: Record<string, string>; domains: Domain[]; mounts: Mount[]; ports: Port[];
  resources: { cpu: number; memoryMb: number }; notes: string; createdAt: string; updatedAt: string;
  deployedAt?: string; containerId?: string; error?: string;
}
export interface Deployment { id: string; serviceId: string; status: 'queued' | 'running' | 'success' | 'failed'; trigger: string; createdAt: string; finishedAt?: string; output: string; image?: string; commit?: string; forceRebuild?: boolean }
export interface Backup { id: string; serviceId: string; status: 'running' | 'success' | 'failed'; createdAt: string; sizeBytes: number; filename: string; error?: string }
export interface Activity { id: string; action: string; resource: string; createdAt: string; detail?: string }
export interface Template { id: string; name: string; description: string; category: string; kind: ServiceKind; image: string; port: number; website: string; env?: Record<string,string>; mounts?: { name: string; mountPath: string }[] }
export interface Settings { serverName: string; baseDomain: string; letsEncryptEmail: string; theme: 'light' | 'dark' | 'system' }
export interface Metrics { mode: RuntimeMode; cpuPercent: number | null; memoryUsedBytes: number; memoryTotalBytes: number; diskUsedBytes: number | null; diskTotalBytes: number | null; uptime: number; dockerVersion: string | null; containersRunning: number; error?: string }
export interface Session { authenticated: boolean; setupRequired: boolean; mode: RuntimeMode; user?: { email: string; name: string } }
export interface Overview { projects: Project[]; services: Service[]; deployments: Deployment[]; activity: Activity[]; metrics: Metrics }
