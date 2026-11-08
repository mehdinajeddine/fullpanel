import type { Service } from '../shared/types.js';
import type { ProxyAuthMap } from '../shared/proxy.js';
import type { Store } from './store.js';
import { effectiveServiceEnvironment } from '../shared/environment.js';

function canonical(value: unknown): unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
  return value;
}
export function mountConfiguration(service: Service) {
  return JSON.stringify(service.mounts.map(({name,mountPath})=>({name,mountPath})).sort((a,b)=>a.name.localeCompare(b.name)));
}
export function runtimeConfiguration(service: Service, proxyAuth: ProxyAuthMap = {}) {
  return JSON.stringify(canonical({name:service.name,kind:service.kind,source:service.source,env:service.env,domains:[...service.domains].sort((a,b)=>a.id.localeCompare(b.id)),mounts:JSON.parse(mountConfiguration(service)),ports:[...service.ports].sort((a,b)=>a.published-b.published||a.protocol.localeCompare(b.protocol)),resources:service.resources,proxyAuth}));
}
export function servicePendingChanges(store: Store, service: Service) {
  if(service.runtimeUncertain)return true;
  const applied=store.state.appliedServices[service.id];
  if(!applied)return !!service.deployedAt&&service.updatedAt>service.deployedAt;
  const desired={...service,env:effectiveServiceEnvironment(service,store.state.projectEnvironments[service.projectId]||{})};
  return runtimeConfiguration(desired,store.state.proxyAuth[service.id])!==runtimeConfiguration(applied,store.state.appliedProxyAuth[service.id]);
}
