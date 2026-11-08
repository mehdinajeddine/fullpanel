import { useState } from "react";
import {
  Activity as ActivityIcon,
  ArrowRight,
  ArrowUpRight,
  Box,
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
} from "./ui";
import { CreateProject } from "./Projects";

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
      <div className="metric-track">
        <span
          style={{ width: `${Math.max(0, Math.min(100, percent || 0))}%` }}
        />
      </div>
      <div className="metric-detail">{detail}</div>
    </div>
  );
}
export default function Dashboard({ name }: { name?: string }) {
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
        title="A little clarity. A lot of possibility."
        description={`Welcome${name ? `, ${name.split(" ")[0]}` : ""}. Here’s what’s happening with your infrastructure.`}
        actions={
          <Button onClick={() => setCreate(true)}>
            <Plus size={17} />
            New project
          </Button>
        }
      />
      <ErrorBox message={error || metrics.error || ""} />
      <div className="overview-status">
        <div>
          <span className={`status-orb ${failed ? "warning" : ""}`} />
          <strong>
            {failed
              ? `${failed} ${failed === 1 ? "service needs" : "services need"} attention`
              : metrics.error
                ? "Runtime needs attention"
                : running
                  ? "Your services are in good hands"
                  : "Ready when you are"}
          </strong>
          <span className="status-secondary">
            {running} running · {services.length} services · {projects.length}{" "}
            projects
          </span>
        </div>
        <span className="live-indicator">
          <i /> {metrics.mode === "demo" ? "Demo workspace" : "Live overview"}
        </span>
      </div>
      <div className="metrics-grid">
        <Metric
          label="Runtime CPU"
          value={
            metrics.cpuPercent === null
              ? "—"
              : `${metrics.cpuPercent.toFixed(1)}%`
          }
          detail={
            metrics.cpuPercent === null
              ? "Waiting for runtime metrics"
              : "Current runtime utilization"
          }
          percent={metrics.cpuPercent}
          icon={<Cpu size={17} />}
        />
        <Metric
          label="Runtime memory"
          value={bytes(metrics.memoryUsedBytes)}
          detail={`of ${bytes(metrics.memoryTotalBytes)} available`}
          percent={memoryPercent}
          icon={<MemoryStick size={17} />}
        />
        <Metric
          label="Disk usage"
          value={
            metrics.diskUsedBytes === null ? "—" : bytes(metrics.diskUsedBytes)
          }
          detail={
            metrics.diskTotalBytes
              ? `of ${bytes(metrics.diskTotalBytes)} total`
              : "Disk metrics unavailable"
          }
          percent={diskPercent}
          icon={<HardDrive size={17} />}
        />
        <Metric
          label="Running services"
          value={`${running} / ${services.length}`}
          detail={
            services.length
              ? `${services.filter((s) => s.status === "not-deployed").length} awaiting first deployment`
              : "Your next idea belongs here"
          }
          percent={services.length ? (running / services.length) * 100 : 0}
          icon={<Layers size={17} />}
        />
      </div>
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
                        {items.length} services
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
                description="Create a project, add a service, and bring your next idea online."
                action={
                  <Button onClick={() => setCreate(true)}>
                    <Plus size={16} />
                    Create your first project
                  </Button>
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
          <div className="launch-card">
            <div className="launch-card-top">
              <span className="eyebrow">LESS SETUP, MORE BUILDING</span>
              <Box size={25} />
            </div>
            <h2>
              A head start
              <br />
              for your next idea.
            </h2>
            <p>
              Databases, automation, and tools you love. Start with a ready-made
              template.
            </p>
            <button onClick={() => navigate("/templates")}>
              Explore templates
              <ArrowUpRight size={17} />
            </button>
            <div className="launch-art" aria-hidden="true">
              <div />
              <div />
              <div />
              <span>H</span>
            </div>
          </div>
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
      {create && (
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
