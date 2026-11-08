import { useEffect, useRef, useState } from "react";
import { Activity, Clock3, Network, RefreshCw } from "lucide-react";
import type { Service } from "../shared/types";
import type { ServicePorts } from "../shared/ports";
import { api } from "./api";
import { Badge, Button, ErrorBox, Field, Notice } from "./ui";

interface PortTarget {
  id: string;
  label: string;
  port: number;
}
interface Snapshot {
  data: ServicePorts;
  runtime: string;
}

export default function PortDiagnostics({
  service,
  targets,
  onSelect,
  disabled = false,
}: {
  service: Service;
  targets: PortTarget[];
  onSelect?: (targetId: string, port: number) => void;
  disabled?: boolean;
}) {
  const runtime = JSON.stringify([
    service.id,
    service.containerId,
    service.deployedAt,
    service.status,
  ]);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [selectedId, setSelectedId] = useState(targets[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const [selection, setSelection] = useState("");
  const request = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);
  useEffect(() => {
    request.current?.abort();
    request.current = undefined;
    setBusy(false);
    setSelection("");
  }, [runtime]);
  useEffect(() => {
    const visibility = () => {
      if (document.hidden) request.current?.abort();
      else setNow(Date.now());
    };
    const clock = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(clock);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const target = targets.find((item) => item.id === selectedId) || targets[0];
  const data = snapshot?.data;
  const changed = !!snapshot && snapshot.runtime !== runtime;
  const age = data?.sampledAt ? now - Date.parse(data.sampledAt) : null;
  const stale =
    !!data?.sampledAt &&
    (age === null || !Number.isFinite(age) || age > 30_000);
  const canChoose =
    !!onSelect &&
    !!target &&
    !disabled &&
    !busy &&
    !error &&
    !changed &&
    !stale &&
    !!data?.sampledAt &&
    (data.state === "available" || data.state === "partial");
  async function inspect() {
    if (request.current || document.hidden) return;
    const controller = new AbortController();
    request.current = controller;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 20_000);
    setBusy(true);
    setSelection("");
    try {
      const result = await api<ServicePorts>(
        `/services/${encodeURIComponent(service.id)}/ports`,
        { signal: controller.signal },
      );
      if (mounted.current && !controller.signal.aborted) {
        setSnapshot({ data: result, runtime });
        setError("");
        setNow(Date.now());
      }
    } catch (cause) {
      if (mounted.current && (!controller.signal.aborted || timedOut))
        setError(
          timedOut
            ? "Port inspection timed out. Try again."
            : (cause as Error).message,
        );
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) {
        request.current = undefined;
        if (mounted.current) setBusy(false);
      }
    }
  }
  const label = changed
    ? "Runtime changed"
    : error || stale
      ? "Inspection out of date"
      : data?.state === "available"
        ? "Inspected"
        : data?.state === "partial"
          ? "Partial inspection"
          : data?.state === "stopped"
            ? "Service stopped"
            : data?.state === "not-deployed"
              ? "Not deployed"
              : data?.state === "unsupported"
                ? "Not supported"
                : "Unavailable";
  const currentListeners =
    target && data?.listeners.filter((item) => item.port === target.port);
  return (
    <section
      className="port-diagnostics"
      aria-label="Container port diagnostics"
    >
      <div className="port-diagnostics-heading">
        <div>
          <Network size={19} aria-hidden="true" />
          <h3>Container ports</h3>
        </div>
        <Button
          type="button"
          variant="secondary"
          busy={busy}
          onClick={() => void inspect()}
          aria-label={
            snapshot || error
              ? "Refresh port inspection"
              : "Inspect container ports"
          }
        >
          <RefreshCw size={15} />
          {snapshot || error ? "Refresh inspection" : "Inspect ports"}
        </Button>
      </div>
      <p className="port-diagnostics-intro">
        Find the internal port your application listens on. Inspection does not
        publish ports or change your routes.
      </p>
      <ErrorBox message={error} />
      {data && (
        <>
          <div className="port-inspection-meta">
            <Badge
              status={
                changed || stale || error || data.state === "partial"
                  ? "pending"
                  : "configured"
              }
              tone={
                changed || stale || error || data.state === "partial"
                  ? "warning"
                  : "neutral"
              }
              label={label}
            />
            {data.mode === "demo" && <span>Demo · no live inspection</span>}
            <span>
              <Clock3 size={12} aria-hidden="true" />
              Checked{" "}
              <time dateTime={data.checkedAt} title={data.checkedAt}>
                {new Date(data.checkedAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "long",
                })}
              </time>
            </span>
          </div>
          {data.mode === "demo" && (
            <p className="port-diagnostics-intro">
              Demo mode does not inspect containers. Any displayed entries are
              simulated.
            </p>
          )}
          {(changed || stale) && (
            <Notice
              tone="warning"
              title={
                changed
                  ? "Inspect the current runtime"
                  : "Refresh before choosing a port"
              }
            >
              {changed
                ? "The service runtime changed after this inspection."
                : "This inspection is more than 30 seconds old."}{" "}
              Inspect again to use a detected port.
            </Notice>
          )}
          {data.message && (
            <p className="port-diagnostics-intro">{data.message}</p>
          )}
          {onSelect && targets.length > 0 && (
            <div className="port-route-picker">
              <Field label="Route to update">
                <select
                  value={target?.id || ""}
                  onChange={(event) => {
                    setSelectedId(event.target.value);
                    setSelection("");
                  }}
                  disabled={disabled}
                >
                  {targets.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.label} · port {item.port}
                    </option>
                  ))}
                </select>
              </Field>
              <p>
                Choosing a port changes this route’s draft. Save changes, then
                deploy to apply it.
              </p>
            </div>
          )}
          {!!data.listeners.length && (
            <>
              <h4 className="port-section-label">
                <Activity size={14} aria-hidden="true" />
                Observed TCP listeners
              </h4>
              <ul className="port-listeners">
                {data.listeners.map((listener, index) => (
                  <li
                    key={`${listener.family}/${listener.address}/${listener.port}/${index}`}
                  >
                    <div className="port-listener-content">
                      <div className="port-listener-title">
                        <strong>
                          {listener.protocol.toUpperCase()} {listener.port}
                        </strong>
                        <Badge
                          status={
                            changed || stale || error ? "configured" : "running"
                          }
                          tone={
                            changed || stale || error ? "neutral" : "positive"
                          }
                          label={
                            changed || stale || error
                              ? "Previously observed"
                              : "Listening"
                          }
                        />
                        {data.exposed.some(
                          (item) =>
                            item.port === listener.port &&
                            item.protocol === listener.protocol,
                        ) && (
                          <Badge
                            status="configured"
                            tone="neutral"
                            label="Declared"
                          />
                        )}
                      </div>
                      <code>{listener.address}</code>
                      <span className="port-listener-scope">
                        {listener.family === "ipv4" ? "IPv4" : "IPv6"} ·{" "}
                        {listener.scope === "loopback"
                          ? "Loopback only"
                          : listener.scope === "wildcard"
                            ? "All interfaces"
                            : "Specific interface"}
                      </span>
                      {listener.scope === "loopback" ? (
                        <p className="port-listener-warning">
                          The proxy cannot reach a loopback-only listener.
                          Configure the app to listen on a container interface,
                          such as 0.0.0.0.
                        </p>
                      ) : (
                        (listener.scope === "interface" ||
                          listener.family === "ipv6") && (
                          <p>
                            Reachability from the proxy is not verified for this
                            address.
                          </p>
                        )
                      )}
                    </div>
                    {onSelect && target && (
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={!canChoose || listener.scope === "loopback"}
                        aria-label={`Use TCP port ${listener.port} on ${listener.address}`}
                        onClick={() => {
                          if (canChoose && listener.scope !== "loopback") {
                            onSelect(target.id, listener.port);
                            setSelection(
                              `Port ${listener.port} selected for ${target.label}. Save changes, then deploy to apply it.`,
                            );
                          }
                        }}
                      >
                        Use port {listener.port}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {!data.listeners.length && (
            <p className="port-diagnostics-intro">
              {data.state === "available"
                ? "No TCP listener was observed in this inspection."
                : "No observed TCP listeners are available."}
            </p>
          )}
          {target &&
            data.sampledAt &&
            !changed &&
            !stale &&
            !error &&
            (data.state === "available" || data.state === "partial") && (
              <p className="port-target-check">
                {currentListeners?.some((item) => item.scope !== "loopback")
                  ? `Route target ${target.port} was observed listening. HTTP, TLS and proxy access are not verified.`
                  : currentListeners?.length
                    ? `Route target ${target.port} was observed only on loopback, which the proxy cannot reach.`
                    : `Route target ${target.port} was not observed listening in this inspection. Check the application’s startup configuration.`}
              </p>
            )}
          {!!data.exposed.length && (
            <div className="port-exposed">
              <h4>Declared container ports</h4>
              <div>
                {data.exposed.map((item) => (
                  <Badge
                    key={`${item.protocol}/${item.port}`}
                    status="configured"
                    tone="neutral"
                    label={`${item.port}/${item.protocol.toUpperCase()} · Declared`}
                  />
                ))}
              </div>
              <p>
                Docker metadata, not proof of listening. Declarations can come
                from image EXPOSE or container port configuration. UDP listeners
                are not inspected.
              </p>
            </div>
          )}
          {selection && (
            <p className="port-selection-feedback" role="status">
              {selection}
            </p>
          )}
        </>
      )}
      <p className="port-diagnostics-footnote">
        A TCP listener does not confirm HTTP or HTTPS. Check the app’s upstream
        protocol separately. Ports are inspected only when requested.
      </p>
    </section>
  );
}
