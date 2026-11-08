import { useEffect, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Clock3,
  Cpu,
  MemoryStick,
  RefreshCw,
} from "lucide-react";
import type { Service } from "../shared/types";
import type {
  ServiceMetrics as MetricsSnapshot,
  ServiceContainerMetrics,
} from "../shared/metrics";
import { api, bytes } from "./api";
import { Badge, Button, Loading, Notice, Panel } from "./ui";

const POLL_MS = 10_000;
const STALE_MS = 30_000;

function useServiceMetrics(service: Service) {
  const [data, setData] = useState<MetricsSnapshot>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hidden, setHidden] = useState(document.hidden);
  const [now, setNow] = useState(Date.now());
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let controller: AbortController | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (disposed || document.hidden || pending) return;
      pending = true;
      let timedOut = false;
      controller = new AbortController();
      const current = controller;
      setRefreshing(true);
      timeout = setTimeout(() => {
        timedOut = true;
        current.abort();
      }, 20_000);
      try {
        const next = await api<MetricsSnapshot>(
          `/services/${encodeURIComponent(service.id)}/metrics`,
          { signal: current.signal },
        );
        if (!disposed && !current.signal.aborted) {
          setData(next);
          setError("");
        }
      } catch (cause) {
        if (!disposed && !document.hidden)
          setError(
            timedOut
              ? "The metrics request timed out."
              : (cause as Error).message,
          );
      } finally {
        clearTimeout(timeout);
        pending = false;
        if (!disposed) {
          setLoading(false);
          setRefreshing(false);
          setNow(Date.now());
          if (!document.hidden)
            poll = setTimeout(() => void refresh(), POLL_MS);
        }
      }
    };
    const visibility = () => {
      setHidden(document.hidden);
      setNow(Date.now());
      clearTimeout(poll);
      if (document.hidden) controller?.abort();
      else void refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    const clock = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
    void refresh();
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(poll);
      clearTimeout(timeout);
      clearInterval(clock);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [service.id, service.status, revision]);
  return {
    data,
    error,
    loading,
    refreshing,
    hidden,
    now,
    retry: () => setRevision((value) => value + 1),
  };
}

function Timestamp({ value }: { value: string }) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return <>Unknown time</>;
  return (
    <time dateTime={value} title={value}>
      {parsed.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        timeZoneName: "short",
      })}
    </time>
  );
}

function MetricValue({
  label,
  value,
  detail,
  icon,
  percent,
}: {
  label: string;
  value: string;
  detail: string;
  icon: ReactNode;
  percent?: number | null;
}) {
  return (
    <div className="service-metric-card">
      <div className="service-metric-label">
        {icon}
        <span>{label}</span>
      </div>
      <strong className="service-metric-value">{value}</strong>
      {percent != null && (
        <div
          className="metric-track"
          role="meter"
          aria-label={`${label} usage`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.max(0, Math.min(100, percent))}
        >
          <span style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
        </div>
      )}
      <p>{detail}</p>
    </div>
  );
}

function ContainerRow({ container }: { container: ServiceContainerMetrics }) {
  return (
    <li className="metrics-container">
      <div className="metrics-container-heading">
        <strong>{container.name}</strong>
        <Badge status={container.state} />
      </div>
      <dl>
        <div>
          <dt>CPU</dt>
          <dd>
            {container.cpuPercent == null
              ? "Unavailable"
              : `${container.cpuPercent.toFixed(1)}%`}
          </dd>
        </div>
        <div>
          <dt>Memory</dt>
          <dd>
            {bytes(container.memoryUsedBytes)} /{" "}
            {bytes(container.memoryLimitBytes)}
          </dd>
        </div>
        <div>
          <dt>Received</dt>
          <dd>{bytes(container.networkRxBytes)}</dd>
        </div>
        <div>
          <dt>Sent</dt>
          <dd>{bytes(container.networkTxBytes)}</dd>
        </div>
      </dl>
      <p>
        {container.runtimeStartedAt ? (
          <>
            Started <Timestamp value={container.runtimeStartedAt} />
          </>
        ) : (
          "Container start time unavailable"
        )}
        {container.sampledAt && (
          <>
            {" "}
            · Sample <Timestamp value={container.sampledAt} />
          </>
        )}
      </p>
    </li>
  );
}

export default function ServiceMetrics({ service }: { service: Service }) {
  const { data, error, loading, refreshing, hidden, now, retry } =
    useServiceMetrics(service);
  const age = data?.sampledAt ? now - Date.parse(data.sampledAt) : null;
  const hasSample = !!data?.sampledAt;
  const stale =
    hasSample &&
    (!!error || age === null || !Number.isFinite(age) || age > STALE_MS);
  const stateLabel = error
    ? hasSample
      ? "Stale sample"
      : "Unavailable"
    : stale
      ? "Stale sample"
      : data?.state === "available"
        ? "Recent sample"
        : data?.state === "partial"
          ? "Partial sample"
          : data?.state === "stopped"
            ? "Service stopped"
            : data?.state === "not-deployed"
              ? "Not deployed"
              : "Unavailable";
  const warning = !!error || stale || data?.state === "partial";
  const totals = data?.totals;
  const memoryPercent =
    totals?.memoryUsedBytes != null &&
    totals.memoryLimitBytes != null &&
    totals.memoryLimitBytes > 0
      ? (totals.memoryUsedBytes / totals.memoryLimitBytes) * 100
      : null;
  const hasValues =
    totals && Object.values(totals).some((value) => value != null);
  const summary =
    data?.state === "stopped"
      ? "This service is stopped. No current usage sample is available."
      : data?.state === "not-deployed"
        ? "Deploy this service to collect container metrics."
        : data?.state === "partial"
          ? "Some container measurements are missing. Incomplete totals stay unavailable; known values are shown in the container breakdown."
          : data?.message || "No container measurements are available yet.";
  return (
    <section
      className="service-metrics"
      aria-label="Service metrics"
      data-stale={stale || !!error ? "true" : "false"}
    >
      <Panel
        title="Service metrics"
        description="A recent container sample, with its collection time."
        actions={
          <Button
            variant="secondary"
            onClick={retry}
            disabled={refreshing}
            aria-label={error ? "Retry metrics" : "Refresh metrics"}
          >
            <RefreshCw size={15} className={refreshing ? "spin" : ""} />
            {error ? "Retry" : "Refresh"}
          </Button>
        }
      >
        {loading ? (
          <Loading label="Loading service metrics" />
        ) : (
          <div className="service-metrics-body">
            <div className="metrics-freshness">
              <div role="status">
                <Badge
                  status={warning ? "pending" : "configured"}
                  tone={
                    warning
                      ? "warning"
                      : data?.state === "available"
                        ? "info"
                        : "neutral"
                  }
                  label={stateLabel}
                />
                {data?.mode === "demo" && (
                  <span className="metrics-demo-label">
                    Demo · no live measurements
                  </span>
                )}
              </div>
              <span>
                <Clock3 size={13} aria-hidden="true" />
                {hidden
                  ? "Updates paused while hidden"
                  : "Refreshes every 10 seconds while visible"}
              </span>
            </div>
            {data?.mode === "demo" && (
              <p className="metrics-explanation">
                Metrics are not collected in demo mode. Any displayed sample
                values are simulated.
              </p>
            )}
            {error && (
              <Notice tone="warning" title="Metrics refresh failed">
                {error}{" "}
                {hasSample
                  ? "Showing the last sample; these values are not current."
                  : "Retry to request a new sample."}
              </Notice>
            )}
            {!error && stale && (
              <Notice tone="warning" title="Sample is out of date">
                This sample is more than 30 seconds old. Its values may no
                longer reflect the running containers.
              </Notice>
            )}
            {data && data.state !== "available" && (
              <p className="metrics-explanation">{summary}</p>
            )}
            {(hasValues ||
              data?.state === "available" ||
              data?.state === "partial") && (
              <div className="service-metrics-grid">
                <MetricValue
                  label="CPU"
                  value={
                    totals?.cpuPercent == null
                      ? "Unavailable"
                      : `${totals.cpuPercent.toFixed(1)}%`
                  }
                  detail="100% equals one CPU core"
                  icon={<Cpu size={17} aria-hidden="true" />}
                />
                <MetricValue
                  label="Memory"
                  value={
                    totals?.memoryUsedBytes == null
                      ? "Unavailable"
                      : bytes(totals.memoryUsedBytes)
                  }
                  detail={
                    totals?.memoryLimitBytes == null
                      ? "Limit unavailable"
                      : `of ${bytes(totals.memoryLimitBytes)} container limit`
                  }
                  percent={memoryPercent}
                  icon={<MemoryStick size={17} aria-hidden="true" />}
                />
                <MetricValue
                  label="Network received"
                  value={
                    totals?.networkRxBytes == null
                      ? "Unavailable"
                      : bytes(totals.networkRxBytes)
                  }
                  detail="Cumulative received bytes (Rx)"
                  icon={<ArrowDownToLine size={17} aria-hidden="true" />}
                />
                <MetricValue
                  label="Network sent"
                  value={
                    totals?.networkTxBytes == null
                      ? "Unavailable"
                      : bytes(totals.networkTxBytes)
                  }
                  detail="Cumulative sent bytes (Tx)"
                  icon={<ArrowUpFromLine size={17} aria-hidden="true" />}
                />
              </div>
            )}
            {!data && !error && (
              <p className="metrics-explanation">
                No sample has been collected.
              </p>
            )}
            {data && (
              <div className="metrics-timestamps">
                <span>
                  <Activity size={13} aria-hidden="true" />
                  {data.sampledAt ? (
                    <>
                      Sample collected <Timestamp value={data.sampledAt} />
                    </>
                  ) : (
                    "No sample collected"
                  )}
                </span>
                <span>
                  Last checked <Timestamp value={data.checkedAt} />
                </span>
              </div>
            )}
            {(hasValues || !!data?.containers.length) && (
              <p className="metrics-footnote">
                Network totals are counters since each container started, not
                transfer rates. They reset when containers restart. CPU can
                exceed 100% across multiple cores.
              </p>
            )}
            {!!data?.containers.length && (
              <details className="metrics-breakdown">
                <summary>
                  Container breakdown <span>{data.containers.length}</span>
                </summary>
                <ul>
                  {data.containers.map((container) => (
                    <ContainerRow container={container} key={container.id} />
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </Panel>
    </section>
  );
}
