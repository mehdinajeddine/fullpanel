import { useState } from "react";
import {
  Activity as ActivityIcon,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  AlertTriangle,
  ChevronRight,
  Cpu,
  Folder,
  HardDrive,
  Layers,
  MemoryStick,
  Plus,
  Rocket,
  Server,
} from "lucide-react";
import type { Overview } from "../shared/types";
import { bytes, navigate, relative, useQuery } from "./api";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Loading,
  PageHeader,
  Panel,
  ServiceStateSummary,
  hasPendingConfiguration,
} from "./ui";
import { CreateProject } from "./Projects";
import { useAccess } from "./Access";

function Metric({
  label,
  value,
  detail,
  percent,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  percent?: number | null;
  icon: React.ReactNode;
}) {
  return (
    <div className="metric-card">
      <div className="metric-label">
        <span>{label}</span>
        {icon}
      </div>
      <strong className="metric-value">{value}</strong>
      {typeof percent === "number" && (
        <div
          className="metric-track"
          role="meter"
          aria-label={label}
          aria-valuenow={Math.round(Math.max(0, Math.min(100, percent)))}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span
            style={{ width: `${Math.max(0, Math.min(100, percent || 0))}%` }}
          />
        </div>
      )}
      <div className="metric-detail">{detail}</div>
    </div>
  );
}
export default function Dashboard({ name }: { name?: string }) {
  const access = useAccess();
  const { data, error, loading, reload } = useQuery<Overview>(
    "/overview",
    8000,
  );
  const [create, setCreate] = useState(false);
  if (loading) return <Loading />;
  if (!data) return <ErrorBox message={error} retry={reload} />;
  const { projects, services, deployments, activity, metrics } = data;
  const running = services.filter((s) => s.status === "running").length;
  const failed = services.filter((s) => s.status === "failed").length;
  const latestDeployment = deployments[0];
  const nextSteps = services
    .filter(
      (service) =>
        service.status === "failed" ||
        hasPendingConfiguration(service) ||
        service.status === "not-deployed",
    )
    .sort(
      (a, b) =>
        Number(b.status === "failed" || !!b.runtimeUncertain) -
        Number(a.status === "failed" || !!a.runtimeUncertain),
    );
  const memoryPercent = metrics.memoryTotalBytes
    ? (metrics.memoryUsedBytes / metrics.memoryTotalBytes) * 100
    : 0;
  const diskPercent =
    metrics.diskTotalBytes && metrics.diskUsedBytes !== null
      ? (metrics.diskUsedBytes / metrics.diskTotalBytes) * 100
      : null;
  return (
    <>
      <PageHeader
        eyebrow="MISSION CONTROL"
        title="Workspace overview"
        description={`Welcome${name ? `, ${name.split(" ")[0]}` : ""}. Your services, deployment activity and next steps.`}
        actions={
          access.isAdmin && (
            <Button onClick={() => setCreate(true)}>
              <Plus size={17} />
              New project
            </Button>
          )
        }
      />
      <ErrorBox message={error || metrics.error || ""} />
      <div className="overview-status">
        <div>
          {failed || metrics.error ? (
            <AlertTriangle
              size={18}
              className="summary-warning"
              aria-hidden="true"
            />
          ) : (
            <Server
              size={18}
              className="summary-runtime-icon"
              aria-hidden="true"
            />
          )}
          <strong>
            {failed
              ? `${failed} ${failed === 1 ? "service needs" : "services need"} attention`
              : metrics.error
                ? "Runtime needs attention"
                : running
                  ? `${running} of ${services.length} services running`
                  : "No services running"}
          </strong>
          <span className="status-secondary">
            {running} running · {services.length} services · {projects.length}{" "}
            projects
          </span>
        </div>
        <span className="live-indicator">
          <i />{" "}
          {metrics.mode === "demo"
            ? "Demo workspace"
            : error || metrics.error
              ? "Overview refresh failed"
              : "Latest overview"}
        </span>
      </div>
      <ServiceStateSummary services={services} />
      {access.isAdmin ? (
        <div className="metrics-grid">
          <Metric
            label={metrics.mode === "demo" ? "CPU (demo)" : "Docker CPU"}
            value={
              metrics.cpuPercent === null
                ? "—"
                : `${metrics.cpuPercent.toFixed(1)}%`
            }
            detail={
              metrics.cpuPercent === null
                ? "Waiting for runtime metrics"
                : metrics.mode === "demo"
                  ? "Simulated CPU usage"
                  : "All containers · normalized by host cores"
            }
            percent={metrics.cpuPercent}
            icon={<Cpu size={17} />}
          />
          <Metric
            label={
              metrics.mode === "demo" ? "Memory (demo)" : "Panel host memory"
            }
            value={bytes(metrics.memoryUsedBytes)}
            detail={`of ${bytes(metrics.memoryTotalBytes)} · ${metrics.mode === "demo" ? "simulated" : "host running the panel"}`}
            percent={memoryPercent}
            icon={<MemoryStick size={17} />}
          />
          <Metric
            label={metrics.mode === "demo" ? "Disk (demo)" : "Panel disk"}
            value={
              metrics.diskUsedBytes === null
                ? "—"
                : bytes(metrics.diskUsedBytes)
            }
            detail={
              metrics.diskTotalBytes
                ? `of ${bytes(metrics.diskTotalBytes)} · ${metrics.mode === "demo" ? "simulated" : "data filesystem"}`
                : "Disk metrics unavailable"
            }
            percent={diskPercent}
            icon={<HardDrive size={17} />}
          />
          <Metric
            label="Latest deployment"
            value={
              latestDeployment ? relative(latestDeployment.createdAt) : "—"
            }
            detail={
              latestDeployment
                ? `${services.find((service) => service.id === latestDeployment.serviceId)?.name || "Removed service"} · ${latestDeployment.status}`
                : "No deployments recorded"
            }
            icon={<Rocket size={17} />}
          />
        </div>
      ) : (
        <div className="metrics-grid member-metrics">
          <Metric
            label="Accessible projects"
            value={String(projects.length)}
            detail="Projects shared with your account"
            icon={<Folder size={17} />}
          />
          <Metric
            label="Running services"
            value={`${running} / ${services.length}`}
            detail="Across your accessible projects"
            icon={<Layers size={17} />}
            percent={services.length ? (running / services.length) * 100 : 0}
          />
          <Metric
            label="Deployments"
            value={String(deployments.length)}
            detail="Recorded in your projects"
            icon={<Rocket size={17} />}
          />
        </div>
      )}
      {access.isAdmin && (
        <p className="dashboard-metrics-source">
          {metrics.sampledAt ? (
            <>
              Metrics collected{" "}
              <time dateTime={metrics.sampledAt} title={metrics.sampledAt}>
                {new Date(metrics.sampledAt).toLocaleString(undefined, {
                  dateStyle: "medium",
                  timeStyle: "long",
                })}
              </time>
              .
            </>
          ) : (
            "Metrics collection time unavailable."
          )}
          {(error || metrics.error) &&
            " Refresh failed; displayed values may be out of date."}
        </p>
      )}
      <div className="dashboard-grid">
        <div className="dashboard-main">
          <Panel
            title="Your projects"
            description="A dedicated home for everything you build."
            actions={
              <a className="text-link" href="#/projects">
                View all
                <ArrowRight size={15} />
              </a>
            }
          >
            {projects.length ? (
              <div className="dashboard-projects">
                {projects.slice(0, 4).map((p) => {
                  const items = services.filter((s) => s.projectId === p.id);
                  return (
                    <button
                      key={p.id}
                      className="dashboard-project"
                      onClick={() => navigate(`/projects/${p.id}`)}
                    >
                      <span
                        className="project-symbol"
                        style={{
                          color: p.color,
                          backgroundColor: `${p.color}15`,
                        }}
                      >
                        <Folder size={21} />
                      </span>
                      <span>
                        <strong>{p.name}</strong>
                        <small>
                          {p.description ||
                            `${items.length} ${items.length === 1 ? "service" : "services"}`}
                        </small>
                      </span>
                      <span className="project-service-count">
                        <Badge
                          status={
                            items.some((item) => item.status === "failed")
                              ? "failed"
                              : "configured"
                          }
                          label={
                            items.some((item) => item.status === "failed")
                              ? `${items.filter((item) => item.status === "failed").length} failed`
                              : `${items.filter((item) => item.status === "running").length}/${items.length} running`
                          }
                          tone={
                            items.some((item) => item.status === "failed")
                              ? "danger"
                              : "neutral"
                          }
                        />
                      </span>
                      <ChevronRight size={16} />
                    </button>
                  );
                })}
              </div>
            ) : (
              <Empty
                icon={<Folder size={26} />}
                title="Make yourself at home"
                description={
                  access.isAdmin
                    ? "Create a project, add a service, and bring your next idea online."
                    : "Your projects will appear here when an administrator grants you access."
                }
                action={
                  access.isAdmin && (
                    <Button onClick={() => setCreate(true)}>
                      <Plus size={16} />
                      Create your first project
                    </Button>
                  )
                }
              />
            )}
          </Panel>
          <Panel
            title="Recent deployments"
            actions={
              <a className="text-link" href="#/deployments">
                View all
                <ArrowRight size={15} />
              </a>
            }
          >
            {deployments.length ? (
              <div className="compact-deployments">
                {deployments.slice(0, 4).map((d) => (
                  <button
                    key={d.id}
                    className="deployment-row"
                    onClick={() => navigate(`/deployments/${d.id}`)}
                  >
                    <span
                      className={`event-symbol ${d.status === "success" ? "event-success" : ""}`}
                    >
                      <Rocket size={17} />
                    </span>
                    <span className="deployment-name">
                      <strong>
                        {services.find((s) => s.id === d.serviceId)?.name ||
                          "Removed service"}
                      </strong>
                      <small>{d.trigger || "Manual deployment"}</small>
                    </span>
                    <Badge status={d.status} />
                    <time dateTime={d.createdAt}>{relative(d.createdAt)}</time>
                  </button>
                ))}
              </div>
            ) : (
              <Empty
                icon={<Rocket size={25} />}
                title="Your first launch is ahead"
                description="Deployment activity appears here when you deploy a service."
              />
            )}
          </Panel>
        </div>
        <aside className="dashboard-aside">
          <Panel
            title="Next steps"
            description="Configuration and runtime events to review."
          >
            {nextSteps.length ? (
              <div className="next-step-list">
                {nextSteps.slice(0, 4).map((service) => (
                  <button
                    key={service.id}
                    onClick={() => navigate(`/services/${service.id}`)}
                    className="next-step-item"
                  >
                    <span
                      className={`next-step-icon ${service.status === "failed" ? "needs-attention" : ""}`}
                    >
                      {service.status === "failed" ||
                      service.runtimeUncertain ? (
                        <AlertTriangle size={18} />
                      ) : (
                        <Rocket size={18} />
                      )}
                    </span>
                    <span>
                      <strong>{service.name}</strong>
                      <small>
                        {service.runtimeUncertain
                          ? "Reconcile interrupted deployment"
                          : service.status === "failed"
                            ? "Review the failed operation"
                            : service.status === "not-deployed"
                              ? "Prepare the first deployment"
                              : "Saved changes need deployment"}
                      </small>
                    </span>
                    <ChevronRight size={15} />
                  </button>
                ))}
              </div>
            ) : (
              <div className="quiet-state next-steps-clear">
                <CheckCircle2 size={28} />
                <strong>No pending actions</strong>
                <p>
                  No failed services or pending configurations in this view.
                </p>
              </div>
            )}
            {access.isAdmin && (
              <a className="panel-footer-link" href="#/templates">
                Browse application templates <ArrowUpRight size={14} />
              </a>
            )}
          </Panel>
          <Panel
            title="Activity"
            actions={
              <a
                href="#/activity"
                className="text-link"
                aria-label="View all activity"
              >
                <ArrowUpRight size={17} />
              </a>
            }
          >
            {activity.length ? (
              <div className="activity-preview">
                {activity.slice(0, 5).map((a) => (
                  <div className="activity-item" key={a.id}>
                    <span className="timeline-dot" />
                    <div>
                      <p>
                        {a.action.replace(/\./g, " ")}{" "}
                        <strong>{a.resource}</strong>
                      </p>
                      <time>{relative(a.createdAt)}</time>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="quiet-state">
                <ActivityIcon size={22} />
                <p>
                  A quiet workspace.
                  <br />
                  Your next action starts the story.
                </p>
              </div>
            )}
          </Panel>
        </aside>
      </div>
      {access.isAdmin && (
        <div className="workspace-footer">
          <span>
            <Server size={14} />
            {metrics.dockerVersion
              ? `Docker ${metrics.dockerVersion}`
              : "Docker runtime"}
            <span className="footer-dot">·</span>
            {metrics.mode === "demo"
              ? "Simulated runtime"
              : `${Math.floor(metrics.uptime / 3600)}h host uptime`}
          </span>
          <span>Built for what’s next.</span>
        </div>
      )}
      {create && access.isAdmin && (
        <CreateProject
          close={() => setCreate(false)}
          created={(p) => {
            reload();
            navigate(`/projects/${p.id}`);
          }}
        />
      )}
    </>
  );
}
