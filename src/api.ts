import { useCallback, useEffect, useRef, useState } from "react";
// randomUUID is restricted to secure contexts; initial self-hosted setup may use HTTP.
export function newId(): string {
  if (typeof globalThis.crypto.randomUUID === "function")
    return globalThis.crypto.randomUUID();
  const data = globalThis.crypto.getRandomValues(new Uint8Array(16));
  data[6] = (data[6] & 0x0f) | 0x40;
  data[8] = (data[8] & 0x3f) | 0x80;
  const hex = Array.from(data, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    if (response.status === 401)
      window.dispatchEvent(new Event("harborlight:unauthorized"));
    throw new Error(body?.error || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export const post = <T>(path: string, body?: unknown) =>
  api<T>(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const remove = (path: string) => api<void>(path, { method: "DELETE" });
export function useQuery<T>(path: string, interval = 0, enabled = true) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((v) => v + 1), []);
  const lastPath = useRef(path);
  useEffect(() => {
    if (!enabled) {
      setData(undefined);
      setLoading(false);
      setError("");
      return;
    }
    const controller = new AbortController();
    let fetching = false;
    if (lastPath.current !== path) {
      setData(undefined);
      setLoading(true);
      lastPath.current = path;
    }
    const fetchData = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const value = await api<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setData(value);
          setError("");
        }
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
        fetching = false;
      }
    };
    void fetchData();
    const timer = interval
      ? window.setInterval(() => {
          if (!document.hidden) void fetchData();
        }, interval)
      : undefined;
    return () => {
      controller.abort();
      if (timer) window.clearInterval(timer);
    };
  }, [path, revision, interval, enabled]);
  return { data, error, loading, reload, setData };
}
export function navigate(path: string) {
  window.location.hash = path;
}
export function useRoute() {
  const [route, setRoute] = useState(
    () => window.location.hash.slice(1) || "/",
  );
  useEffect(() => {
    const handler = () => setRoute(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return route;
}
export function bytes(value: number | null | undefined) {
  if (value == null) return "Unavailable";
  if (value === 0) return "0 B";
  const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${["B", "KB", "MB", "GB", "TB"][i]}`;
}
export function relative(value: string) {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export const date = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
export const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/g, "")
    .slice(0, 48);
