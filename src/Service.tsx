import {
  lazy,
  Suspense,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  Box,
  ChevronRight,
  Database,
  Eye,
  EyeOff,
  FileCode2,
  GitBranch,
  Globe2,
  Hammer,
  HardDrive,
  KeyRound,
  Layers,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Trash2,
} from "lucide-react";
import type {
  Backup,
  Deployment,
  Mount,
  Port,
  Project,
  Service,
  Source,
} from "../shared/types";
import { date, navigate, newId, patch, post, remove, useQuery } from "./api";
import {
  Badge,
  ConfigurationBadge,
  Button,
  ConfirmDelete,
  CopyButton,
  Empty,
  ErrorBox,
  Field,
  IconButton,
  Loading,
  Notice,
  Panel,
  SearchInput,
  ServiceIcon,
  useToast,
} from "./ui";
import { BackupTable, DeploymentTable } from "./Operations";
import DeploymentTrigger from "./DeploymentTrigger";
import BackupSchedules from "./BackupSchedules";
import DomainsEditor, { DomainLink, type RoutingDomain } from "./Domains";
import SourceCredentials from "./SourceCredentials";
import { useAccess } from "./Access";
import { ServiceEnvironment } from "./Environment";
import { RestoreHistory } from "./Restores";
import GitHubWebhook from "./GitHubWebhook";
import Releases from "./Releases";
import ServiceMetrics from "./ServiceMetrics";
import { githubSshRepository } from "./git-source";
const ServiceTerminal = lazy(() => import("./Terminal"));
const tabs = [
  ["overview", "Overview"],
  ["source", "Source"],
  ["environment", "Environment"],
  ["domains", "Domains"],
  ["storage", "Storage"],
  ["resources", "Resources"],
  ["deployments", "Deployments"],
  ["releases", "Releases"],
  ["logs", "Logs"],
  ["terminal", "Terminal"],
  ["backups", "Backups"],
  ["settings", "Settings"],
] as const;
function useSave(
  service: Service,
  updated: () => void,
  onSaved?: (service: Service) => void,
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const save = async (values: Partial<Service>) => {
    setBusy(true);
    setError("");
    try {
      const result = await patch<Service>(`/services/${service.id}`, values);
      onSaved?.(result);
      toast("Configuration saved. Deploy to apply runtime changes.");
      updated();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { save, busy, error, setError };
}
function EditorPanel({
  title,
  description,
  children,
  onSubmit,
  busy,
  error,
  action = "Save changes",
}: {
  title: string;
  description: string;
  children: ReactNode;
  onSubmit: (e: FormEvent) => void;
  busy: boolean;
  error: string;
  action?: string;
}) {
  return (
    <Panel title={title} description={description}>
      <form onSubmit={onSubmit} className="form-panel">
        <ErrorBox message={error} />
        {children}
        <div className="form-actions">
          <span className="form-note">Save first, then deploy to apply.</span>
          <Button busy={busy}>
            <Save size={16} />
            {action}
          </Button>
        </div>
      </form>
    </Panel>
  );
}
export default function ServicePage({
  id,
  tab = "overview",
}: {
  id: string;
  tab?: string;
}) {
  const access = useAccess();
  const query = useQuery<Service>(`/services/${encodeURIComponent(id)}`, 5000);
  const projects = useQuery<Project[]>("/projects");
  const [busy, setBusy] = useState("");
  const toast = useToast();
  const service = query.data;
  async function action(name: string, forceRebuild = false) {
    setBusy(name);
    try {
      await post(
        `/services/${id}/${name}`,
        forceRebuild ? { forceRebuild: true } : undefined,
      );
      toast(
        name === "deploy"
          ? "Deployment queued. Follow progress in Deployments."
          : `Service ${name === "stop" ? "stopped" : name === "start" ? "started" : "restarted"}`,
      );
      query.reload();
      if (name === "deploy") navigate(`/services/${id}/deployments`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy("");
    }
  }
  if (query.loading) return <Loading label="Loading service" />;
  if (!service)
    return (
      <ErrorBox
        message={query.error || "Service not found"}
        retry={query.reload}
      />
    );
  const project = projects.data?.find((p) => p.id === service.projectId);
  const canEdit = access.canOperate(service.projectId);
  const visibleTabs = tabs.filter(
    ([name]) =>
      canEdit ||
      !["environment", "logs", "terminal", "settings"].includes(name),
  );
  const active = visibleTabs.some(([t]) => t === tab) ? tab : "overview";
  const openDomain = ([...service.domains] as RoutingDomain[])
    .filter((d) => !d.hostname.startsWith("*."))
    .sort((a, b) => Number(!!b.primary) - Number(!!a.primary))[0];
  return (
    <>
      <div className="service-breadcrumb">
        <a href="#/projects">Projects</a>
        <ChevronRight size={13} />
        <a href={`#/projects/${service.projectId}`}>
          {project?.name || "Project"}
        </a>
        <ChevronRight size={13} />
        <span>{service.name}</span>
      </div>
      <div className="service-heading">
        <div className="service-heading-main">
          <ServiceIcon kind={service.kind} size={27} />
          <div>
            <div className="service-title">
              <h1>{service.name}</h1>
              <Badge status={service.status} />
            </div>
            <p>
              {service.kind === "app"
                ? "Application service"
                : service.kind === "compose"
                  ? "Compose application"
                  : `${service.kind === "mongo" ? "MongoDB" : service.kind === "postgres" ? "PostgreSQL" : service.kind === "mysql" ? "MySQL" : service.kind === "mariadb" ? "MariaDB" : "Redis"} database`}
              <span>·</span>
              <code>{service.id.slice(0, 8)}</code>
            </p>
          </div>
        </div>
        <div className="service-actions">
          {openDomain && (
            <a
              className="btn btn-secondary"
              href={`${openDomain.https ? "https" : "http"}://${openDomain.hostname}${openDomain.path || "/"}`}
              target="_blank"
              rel="noreferrer"
            >
              Open
              <ArrowUpRight size={15} />
            </a>
          )}
          {canEdit && (
            <>
              {["git", "dockerfile"].includes(service.source.type) && (
                <IconButton
                  label="Rebuild without cache"
                  onClick={() => action("deploy", true)}
                  disabled={!!busy || service.status === "deploying"}
                >
                  <Hammer size={17} />
                </IconButton>
              )}
              {service.status === "running" ? (
                <>
                  <IconButton
                    label="Restart service"
                    onClick={() => action("restart")}
                    disabled={!!busy}
                  >
                    <RefreshCw size={17} />
                  </IconButton>
                  <Button
                    variant="secondary"
                    onClick={() => action("stop")}
                    busy={busy === "stop"}
                    disabled={!!busy}
                  >
                    <Pause size={15} />
                    Stop
                  </Button>
                </>
              ) : service.status === "stopped" ? (
                <Button
                  variant="secondary"
                  onClick={() => action("start")}
                  busy={busy === "start"}
                  disabled={!!busy}
                >
                  <Play size={15} />
                  Start
                </Button>
              ) : null}
              <Button
                onClick={() => action("deploy")}
                busy={busy === "deploy"}
                disabled={!!busy || service.status === "deploying"}
              >
                <Rocket size={16} />
                Deploy
              </Button>
            </>
          )}
        </div>
      </div>
      <div
        className="service-configuration-strip"
        aria-label="Service configuration state"
      >
        <span>
          <Rocket size={15} aria-hidden="true" />
          Deployment configuration
        </span>
        <ConfigurationBadge service={service} />
        <span className="service-configuration-detail">
          {service.runtimeUncertain
            ? "A fresh deployment is required to reconcile runtime state."
            : !service.deployedAt
              ? "Configure this service, then deploy when ready."
              : service.status === "running"
                ? "Container running. Application health is not monitored here."
                : "Configuration state is separate from the container’s running state."}
        </span>
      </div>
      <ErrorBox message={query.error || service.error || ""} />
      {!canEdit && (
        <Notice>
          You have viewer access to this project. Configuration changes,
          credentials, and runtime output are available to operators.
        </Notice>
      )}
      <nav className="service-tabs" aria-label="Service sections">
        {visibleTabs.map(([t, label]) => (
          <a
            key={t}
            href={`#/services/${id}/${t}`}
            className={active === t ? "active" : ""}
            aria-current={active === t ? "page" : undefined}
          >
            {label}
          </a>
        ))}
      </nav>
      <div className="service-tab-content" key={`${id}/${active}`}>
        {service.runtimeUncertain && (
          <Notice tone="warning" title="Applied configuration needs attention">
            A deployment was interrupted, so the applied runtime configuration
            is uncertain.{" "}
            {canEdit
              ? "Deploy the saved configuration to reconcile it before using rollback or backups."
              : "Ask a project operator to deploy the saved configuration and reconcile the runtime."}
          </Notice>
        )}
        {canEdit &&
          !service.runtimeUncertain &&
          service.deployedAt &&
          (service.pendingChanges ??
            new Date(service.updatedAt).getTime() >
              new Date(service.deployedAt).getTime()) && (
            <Notice tone="warning" title="Saved changes are waiting">
              Saved configuration differs from the current runtime. Select
              Deploy to apply your saved changes.
            </Notice>
          )}
        {active === "overview" && <ServiceOverview service={service} />}
        {active === "source" &&
          (canEdit ? (
            <SourceEditor service={service} updated={query.reload} />
          ) : (
            <ServiceReadView service={service} section="source" />
          ))}
        {active === "environment" && (
          <ServiceEnvironment service={service} updated={query.reload} />
        )}
        {active === "domains" &&
          (service.kind === "compose" ? (
            <Empty
              icon={<Globe2 size={26} />}
              title="Compose routing is not available yet"
              description="Published ports can be configured in the Compose source. Automatic proxy routing for individual Compose containers is planned."
            />
          ) : (
            <DomainsEditor service={service} updated={query.reload} />
          ))}
        {active === "storage" &&
          (canEdit ? (
            <StorageEditor service={service} updated={query.reload} />
          ) : (
            <ServiceReadView service={service} section="storage" />
          ))}
        {active === "resources" &&
          (canEdit ? (
            <ResourcesEditor service={service} updated={query.reload} />
          ) : (
            <ServiceReadView service={service} section="resources" />
          ))}
        {active === "deployments" && <ServiceDeployments service={service} />}
        {active === "releases" && <Releases service={service} />}
        {active === "logs" && <Logs service={service} />}
        {active === "terminal" && canEdit && (
          <Suspense fallback={<Loading label="Loading terminal" />}>
            <ServiceTerminal service={service} />
          </Suspense>
        )}
        {active === "backups" &&
          (service.kind === "compose" ||
          (service.kind === "app" && !service.mounts.length) ? (
            <Empty
              icon={<HardDrive size={26} />}
              title="No supported backup source"
              description={
                service.kind === "compose"
                  ? "Compose backups are not available yet. Back up the volumes using your own tooling."
                  : "Add persistent storage to this application before creating a backup."
              }
              action={
                service.kind === "app" ? (
                  <Button
                    variant="secondary"
                    onClick={() => navigate(`/services/${service.id}/storage`)}
                  >
                    Configure storage
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <ServiceBackups service={service} />
          ))}
        {active === "settings" && (
          <ServiceSettings service={service} updated={query.reload} />
        )}
      </div>
    </>
  );
}
function ServiceOverview({ service }: { service: Service }) {
  const canEdit = useAccess().canOperate(service.projectId);
  const deployments = useQuery<Deployment[]>(
    `/services/${service.id}/deployments`,
    5000,
  );
  const image =
    service.source.image ||
    service.source.repository ||
    `${service.source.type} source`;
  return (
    <>
      <ServiceMetrics service={service} />
      {canEdit && !["app", "compose"].includes(service.kind) && (
        <DatabaseConnection service={service} />
      )}
      <div className="service-overview-grid">
        <Panel title="Service at a glance">
          <dl className="property-list">
            <div>
              <dt>Source</dt>
              <dd>
                <code>{image}</code>
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <Badge status={service.status} />
              </dd>
            </div>
            <div>
              <dt>Last deployed</dt>
              <dd>
                {service.deployedAt
                  ? date(service.deployedAt)
                  : "Waiting for the first deployment"}
              </dd>
            </div>
            <div>
              <dt>CPU limit</dt>
              <dd>
                {service.resources.cpu > 0
                  ? `${service.resources.cpu} cores`
                  : "No limit"}
              </dd>
            </div>
            <div>
              <dt>Memory limit</dt>
              <dd>
                {service.resources.memoryMb > 0
                  ? `${service.resources.memoryMb} MB`
                  : "No limit"}
              </dd>
            </div>
            <div>
              <dt>Persistent storage</dt>
              <dd>
                {service.mounts.length}{" "}
                {service.mounts.length === 1 ? "volume" : "volumes"}
              </dd>
            </div>
          </dl>
        </Panel>
        <div>
          <Panel
            title="Domains"
            actions={
              <a
                href={`#/services/${service.id}/domains`}
                className="text-link"
              >
                {canEdit ? "Manage" : "View"}
                <ArrowUpRight size={15} />
              </a>
            }
          >
            {service.domains.length ? (
              <div className="domain-links">
                {service.domains.map((domain) => (
                  <DomainLink key={domain.id} domain={domain} />
                ))}
              </div>
            ) : (
              <div className="quiet-state">
                <Globe2 size={24} />
                <p>
                  {["app", "compose"].includes(service.kind)
                    ? canEdit
                      ? "Add a domain to give your service a public address."
                      : "No public domains are configured."
                    : "Private by default. Connect from a service in the same project."}
                </p>
              </div>
            )}
          </Panel>
          {canEdit && (
            <Panel
              title="Notes"
              actions={
                <a
                  href={`#/services/${service.id}/settings`}
                  className="text-link"
                >
                  {canEdit ? "Edit" : "View"}
                  <ArrowUpRight size={15} />
                </a>
              }
            >
              <p className="service-notes">
                {service.notes ||
                  "A place for context, reminders, and the little things worth keeping."}
              </p>
            </Panel>
          )}
        </div>
      </div>
      {canEdit && service.status === "not-deployed" && (
        <Notice>
          Configure the source and environment, then select Deploy. Saving
          configuration does not change a running container.
        </Notice>
      )}
      <Panel
        title="Deployment history"
        actions={
          <a
            href={`#/services/${service.id}/deployments`}
            className="text-link"
          >
            View all
            <ArrowUpRight size={15} />
          </a>
        }
      >
        <ErrorBox message={deployments.error} />
        {deployments.loading ? (
          <Loading />
        ) : (
          <DeploymentTable deployments={(deployments.data || []).slice(0, 5)} />
        )}
      </Panel>
    </>
  );
}
function SourceEditor({
  service,
  updated,
}: {
  service: Service;
  updated: () => void;
}) {
  const [source, setSource] = useState<Source>({ ...service.source });
  const { save, busy, error } = useSave(service, updated, (saved) =>
    setSource({ ...saved.source }),
  );
  function cleanSource(): Source {
    if (source.type === "image")
      return { type: "image", image: source.image?.trim() };
    if (source.type === "dockerfile")
      return { type: "dockerfile", dockerfile: source.dockerfile };
    if (source.type === "compose")
      return { type: "compose", compose: source.compose };
    return {
      type: "git",
      repository: source.repository?.trim(),
      ...(source.branch?.trim() ? { branch: source.branch.trim() } : {}),
      ...(source.context?.trim() ? { context: source.context.trim() } : {}),
      ...(source.dockerfile?.trim()
        ? { dockerfile: source.dockerfile.trim() }
        : {}),
    };
  }
  const set = <K extends keyof Source>(key: K, value: Source[K]) =>
    setSource((s) => ({ ...s, [key]: value }));
  const types: {
    type: Source["type"];
    label: string;
    icon: ReactNode;
    description: string;
  }[] =
    service.kind === "compose"
      ? [
          {
            type: "compose",
            label: "Compose",
            icon: <Layers size={21} />,
            description: "Define your application stack",
          },
        ]
      : service.kind === "app"
        ? [
            {
              type: "image",
              label: "Docker image",
              icon: <Box size={21} />,
              description: "Pull from a container registry",
            },
            {
              type: "git",
              label: "Git repository",
              icon: <GitBranch size={21} />,
              description: "Build and deploy a Git repository",
            },
            {
              type: "dockerfile",
              label: "Dockerfile",
              icon: <FileCode2 size={21} />,
              description: "Write your image definition",
            },
          ]
        : [
            {
              type: "image",
              label: "Docker image",
              icon: <Database size={21} />,
              description: "Database container image",
            },
          ];
  const sourceSaved =
    source.type === service.source.type &&
    (source.type !== "git" ||
      source.repository?.trim() === service.source.repository?.trim()) &&
    (source.type !== "image" ||
      source.image?.trim() === service.source.image?.trim());
  const sourceDraft = cleanSource();
  const sshRepository =
    source.type === "git" ? githubSshRepository(source.repository) : undefined;
  const sshPrepared =
    source.type === "git" &&
    !sourceSaved &&
    githubSshRepository(service.source.repository) === source.repository;
  const sourceHasEdits = (
    [
      "type",
      "image",
      "repository",
      "branch",
      "context",
      "dockerfile",
      "compose",
    ] as const
  ).some((key) => (sourceDraft[key] || "") !== (service.source[key] || ""));
  return (
    <>
      <EditorPanel
        title="Application source"
        description="Tell FullPanel where your application comes from."
        busy={busy}
        error={error}
        onSubmit={(e) => {
          e.preventDefault();
          void save({ source: cleanSource() });
        }}
      >
        <div className="source-state-line">
          <Badge
            status={sourceHasEdits ? "pending-changes" : "configured"}
            label={sourceHasEdits ? "Unsaved source" : "Source saved"}
          />
          <span>
            {sourceHasEdits
              ? "Save this draft before deploying it."
              : "Deploy to apply source and configuration changes."}
          </span>
        </div>
        <div className="source-types">
          {types.map((t) => (
            <button
              type="button"
              key={t.type}
              onClick={() =>
                setSource(
                  t.type === "image"
                    ? { type: "image", image: service.source.image || "" }
                    : t.type === "git"
                      ? {
                          type: "git",
                          repository: service.source.repository || "",
                          branch: "main",
                          context: ".",
                          dockerfile: "Dockerfile",
                        }
                      : t.type === "dockerfile"
                        ? {
                            type: "dockerfile",
                            dockerfile:
                              service.source.type === "dockerfile"
                                ? service.source.dockerfile
                                : "",
                          }
                        : {
                            type: "compose",
                            compose: service.source.compose || "",
                          },
                )
              }
              className={source.type === t.type ? "selected" : ""}
              aria-pressed={source.type === t.type}
            >
              {t.icon}
              <strong>{t.label}</strong>
              <small>{t.description}</small>
            </button>
          ))}
        </div>
        {source.type === "image" && (
          <Field
            label="Image"
            hint="Use a pinned version or digest for reproducible deployments."
          >
            <input
              value={source.image || ""}
              onChange={(e) => set("image", e.target.value)}
              placeholder="nginx:1.27-alpine"
              required
              className="mono"
            />
          </Field>
        )}
        {source.type === "git" && (
          <>
            <div
              className="repository-access-guide"
              aria-label="Git authentication options"
            >
              <div>
                <strong>HTTPS · access token</strong>
                <code>https://github.com/org/repo.git</code>
              </div>
              <div>
                <strong>SSH · deploy key</strong>
                <code>git@github.com:org/repo.git</code>
                {sshRepository && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => set("repository", sshRepository)}
                  >
                    <KeyRound size={16} />
                    Use SSH key
                  </Button>
                )}
              </div>
              <p>
                For an SSH deploy key, enter your SSH repository URL, select
                Save changes, then Generate SSH deploy key below. Changing the
                saved repository revokes its stored access credentials.
              </p>
            </div>
            {sshPrepared && (
              <Notice
                tone="warning"
                title="SSH URL prepared — save to continue"
              >
                Select Save changes to use this SSH repository. Saving revokes
                the access credentials for the previous repository. Then
                Generate SSH deploy key will appear below.
              </Notice>
            )}
            <Field
              label="Repository URL"
              hint="Use HTTPS, git@host:owner/repo.git, or ssh://git@host:port/path. Save first, then configure private access below."
            >
              <input
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={1000}
                value={source.repository || ""}
                onChange={(e) => set("repository", e.target.value)}
                placeholder="https://github.com/your-team/your-app.git"
                required
              />
            </Field>
            <div className="form-grid">
              <Field label="Branch">
                <input
                  value={source.branch || ""}
                  onChange={(e) => set("branch", e.target.value)}
                  placeholder="main"
                />
              </Field>
              <Field label="Build context">
                <input
                  value={source.context || ""}
                  onChange={(e) => set("context", e.target.value)}
                  placeholder="."
                />
              </Field>
            </div>
            <Field label="Dockerfile path">
              <input
                value={source.dockerfile || ""}
                onChange={(e) => set("dockerfile", e.target.value)}
                placeholder="Dockerfile"
              />
            </Field>
          </>
        )}
        {source.type === "dockerfile" && (
          <Field
            label="Dockerfile"
            hint="Files from a repository are not available in this build context."
          >
            <textarea
              className="code-editor"
              spellCheck={false}
              rows={15}
              value={source.dockerfile || ""}
              onChange={(e) => set("dockerfile", e.target.value)}
              required
              placeholder={
                'FROM nginx:1.27-alpine\nRUN echo "Hello, FullPanel" > /usr/share/nginx/html/index.html\nEXPOSE 80'
              }
            />
          </Field>
        )}
        {source.type === "compose" && (
          <Field
            label="Compose configuration"
            hint="Keep secrets in the Environment tab. Persistent volumes remain after service deletion."
          >
            <textarea
              className="code-editor"
              spellCheck={false}
              rows={18}
              value={source.compose || ""}
              onChange={(e) => set("compose", e.target.value)}
              required
              placeholder={
                'services:\n  web:\n    image: nginx:1.27-alpine\n    ports:\n      - "8080:80"'
              }
            />
          </Field>
        )}
        {!["app", "compose"].includes(service.kind) && (
          <Notice>
            Changing a database major version may require a data migration. Keep
            a verified backup before upgrading.
          </Notice>
        )}
      </EditorPanel>
      <SourceCredentials
        key={`${service.source.type}:${service.source.repository || service.source.image || ""}`}
        service={service}
        sourceSaved={sourceSaved}
        updated={updated}
      />
      {service.kind === "app" && source.type === "git" && (
        <GitHubWebhook
          key={`${service.id}:${service.source.repository || ""}:${service.source.branch || "main"}`}
          service={service}
          sourceSaved={
            sourceSaved &&
            (source.branch?.trim() || "main") ===
              (service.source.branch?.trim() || "main")
          }
        />
      )}
    </>
  );
}
function StorageEditor({
  service,
  updated,
}: {
  service: Service;
  updated: () => void;
}) {
  const [mounts, setMounts] = useState<Mount[]>(
    service.mounts.map((m) => ({ ...m })),
  );
  const { save, busy, error } = useSave(service, updated);
  const update = (id: string, key: keyof Mount, value: string) =>
    setMounts((old) =>
      old.map((m) => (m.id === id ? { ...m, [key]: value } : m)),
    );
  return (
    <EditorPanel
      title="Persistent storage"
      description="Keep application data across container restarts and deployments."
      busy={busy}
      error={error}
      onSubmit={(e) => {
        e.preventDefault();
        void save({ mounts });
      }}
    >
      <Notice>
        Named volumes are retained when you remove a mount or delete a service.
        Removing a mount detaches the data on the next deployment.
      </Notice>
      {mounts.map((m, i) => (
        <div className="config-card" key={m.id}>
          <div className="config-card-heading">
            <strong>
              <HardDrive size={16} />
              Volume {i + 1}
            </strong>
            <IconButton
              label={`Remove volume ${i + 1}`}
              onClick={() =>
                setMounts((old) => old.filter((x) => x.id !== m.id))
              }
            >
              <Trash2 size={16} />
            </IconButton>
          </div>
          <div className="form-grid">
            <Field label={`Volume name ${i + 1}`}>
              <input
                value={m.name}
                onChange={(e) => update(m.id, "name", e.target.value)}
                placeholder="app-data"
                required
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
              />
            </Field>
            <Field label={`Mount path ${i + 1}`}>
              <input
                value={m.mountPath}
                onChange={(e) => update(m.id, "mountPath", e.target.value)}
                placeholder="/app/data"
                required
                className="mono"
              />
            </Field>
          </div>
        </div>
      ))}
      {!mounts.length && (
        <div className="inline-empty">
          Containers are ephemeral. Add a volume for data you need to keep.
        </div>
      )}
      <Button
        type="button"
        variant="secondary"
        onClick={() =>
          setMounts((old) => [...old, { id: newId(), name: "", mountPath: "" }])
        }
      >
        <Plus size={16} />
        Add volume
      </Button>
    </EditorPanel>
  );
}
function ResourcesEditor({
  service,
  updated,
}: {
  service: Service;
  updated: () => void;
}) {
  const [resources, setResources] = useState({ ...service.resources });
  const [ports, setPorts] = useState<Port[]>(
    service.ports.map((p) => ({ ...p })),
  );
  const { save, busy, error } = useSave(service, updated);
  return (
    <EditorPanel
      title="Resources & networking"
      description="Set sensible limits and publish non-HTTP ports when needed."
      busy={busy}
      error={error}
      onSubmit={(e) => {
        e.preventDefault();
        void save({ resources, ports });
      }}
    >
      <div className="form-grid">
        <Field
          label="CPU limit (cores)"
          hint="Reserve a practical limit for this service."
        >
          <input
            type="number"
            min={0.1}
            max={128}
            step="0.1"
            value={resources.cpu}
            onChange={(e) =>
              setResources((r) => ({ ...r, cpu: Number(e.target.value) }))
            }
            required
          />
        </Field>
        <Field
          label="Memory limit (MB)"
          hint="Reserve a practical limit for this service."
        >
          <input
            type="number"
            min={16}
            max={1048576}
            value={resources.memoryMb}
            onChange={(e) =>
              setResources((r) => ({ ...r, memoryMb: Number(e.target.value) }))
            }
            required
          />
        </Field>
      </div>
      <div className="form-divider" />
      <h3 className="section-label">Published ports</h3>
      <p className="form-note">
        Use Domains for websites and HTTP APIs. Published ports expose a service
        directly on the host.
      </p>
      {ports.map((p, i) => (
        <div className="port-row" key={i}>
          <Field label={`Published port ${i + 1}`}>
            <input
              type="number"
              min={1024}
              max={65535}
              value={p.published}
              required
              onChange={(e) =>
                setPorts((old) =>
                  old.map((v, j) =>
                    j === i ? { ...v, published: Number(e.target.value) } : v,
                  ),
                )
              }
            />
          </Field>
          <Field label={`Container port ${i + 1}`}>
            <input
              type="number"
              min={1}
              max={65535}
              value={p.target}
              required
              onChange={(e) =>
                setPorts((old) =>
                  old.map((v, j) =>
                    j === i ? { ...v, target: Number(e.target.value) } : v,
                  ),
                )
              }
            />
          </Field>
          <Field label={`Protocol ${i + 1}`}>
            <select
              value={p.protocol}
              onChange={(e) =>
                setPorts((old) =>
                  old.map((v, j) =>
                    j === i
                      ? { ...v, protocol: e.target.value as Port["protocol"] }
                      : v,
                  ),
                )
              }
            >
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
            </select>
          </Field>
          <IconButton
            label={`Remove port ${i + 1}`}
            onClick={() => setPorts((old) => old.filter((_, j) => j !== i))}
          >
            <Trash2 size={16} />
          </IconButton>
        </div>
      ))}
      <Button
        type="button"
        variant="secondary"
        onClick={() =>
          setPorts((old) => [
            ...old,
            { published: 8080, target: 80, protocol: "tcp" },
          ])
        }
      >
        <Plus size={16} />
        Add port
      </Button>
    </EditorPanel>
  );
}
function ServiceDeployments({ service }: { service: Service }) {
  const canEdit = useAccess().canOperate(service.projectId);
  const q = useQuery<Deployment[]>(`/services/${service.id}/deployments`, 3000);
  return (
    <>
      <Panel
        title="Deployment history"
        description="Every build and release, with its own output."
        actions={
          <Button variant="ghost" onClick={q.reload}>
            <RefreshCw size={15} />
            Refresh
          </Button>
        }
      >
        <ErrorBox message={q.error} retry={q.reload} />
        {q.loading ? (
          <Loading />
        ) : (
          <DeploymentTable deployments={q.data || []} />
        )}
      </Panel>
      {canEdit && <DeploymentTrigger serviceId={service.id} />}
    </>
  );
}
function Logs({ service }: { service: Service }) {
  const [live, setLive] = useState(true);
  const [tail, setTail] = useState(200);
  const [search, setSearch] = useState("");
  const q = useQuery<{ logs: string }>(
    `/services/${service.id}/logs?tail=${tail}`,
    live ? 3000 : 0,
  );
  const output = q.data?.logs || "";
  const lines = search
    ? output
        .split("\n")
        .filter((line) => line.toLowerCase().includes(search.toLowerCase()))
        .join("\n")
    : output;
  return (
    <Panel
      title="Runtime logs"
      description="The most recent output from your service."
      actions={
        <span className={`live-indicator ${!live ? "paused" : ""}`}>
          <i />
          {live ? "Live · refreshes every 3s" : "Paused"}
        </span>
      }
    >
      <div className="logs-toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Filter log output…"
          label="Filter logs"
        />
        <div>
          <select
            value={tail}
            onChange={(e) => setTail(Number(e.target.value))}
            aria-label="Log line limit"
          >
            <option value={100}>100 lines</option>
            <option value={200}>200 lines</option>
            <option value={500}>500 lines</option>
            <option value={1000}>1,000 lines</option>
          </select>
          <IconButton
            label={live ? "Pause log updates" : "Resume log updates"}
            onClick={() => setLive(!live)}
          >
            {live ? <Pause size={17} /> : <Play size={17} />}
          </IconButton>
          <IconButton label="Refresh logs" onClick={q.reload}>
            <RefreshCw size={17} />
          </IconButton>
          <CopyButton value={output} />
        </div>
      </div>
      <ErrorBox message={q.error} retry={q.reload} />
      <pre className="terminal-output runtime-logs">
        {q.loading
          ? "Connecting to service logs…"
          : lines ||
            (search
              ? "No lines match your filter."
              : "No runtime output yet. Deploy the service to start collecting logs.")}
      </pre>
    </Panel>
  );
}
function ServiceBackups({ service }: { service: Service }) {
  const canEdit = useAccess().canOperate(service.projectId);
  const q = useQuery<Backup[]>(`/services/${service.id}/backups`, 4000);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function run() {
    setBusy(true);
    try {
      await post(`/services/${service.id}/backups`);
      toast("Backup started");
      q.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Notice>
        Backups stay on this server. Download a copy to an independent location
        and verify it before relying on it for recovery.
      </Notice>
      {canEdit && (
        <BackupSchedules serviceId={service.id} services={[service]} />
      )}
      <Panel
        title="Service backups"
        description="Manual snapshots of your persistent data."
        actions={
          canEdit && (
            <Button onClick={run} busy={busy}>
              <Plus size={16} />
              Run backup
            </Button>
          )
        }
      >
        <ErrorBox message={q.error} retry={q.reload} />
        {q.loading ? (
          <Loading />
        ) : (
          <BackupTable
            backups={q.data || []}
            projectId={service.projectId}
            targetServiceId={service.id}
          />
        )}
      </Panel>
      {canEdit && (
        <RestoreHistory serviceId={service.id} services={[service]} />
      )}
    </>
  );
}
function ServiceSettings({
  service,
  updated,
}: {
  service: Service;
  updated: () => void;
}) {
  const [notes, setNotes] = useState(service.notes);
  const [deleting, setDeleting] = useState(false);
  const { save, busy, error } = useSave(service, updated);
  const toast = useToast();
  return (
    <>
      <EditorPanel
        title="Service notes"
        description="Keep useful context close to your application."
        busy={busy}
        error={error}
        onSubmit={(e) => {
          e.preventDefault();
          void save({ notes });
        }}
      >
        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="A reminder for your future self…"
            rows={6}
            maxLength={5000}
          />
        </Field>
      </EditorPanel>
      <section className="danger-zone">
        <div>
          <h3>Delete this service</h3>
          <p>
            Remove its runtime and configuration. Named volumes are retained on
            the server.
          </p>
        </div>
        <Button variant="danger" onClick={() => setDeleting(true)}>
          <Trash2 size={16} />
          Delete service
        </Button>
      </section>
      {deleting && (
        <ConfirmDelete
          name={service.name}
          description="The running containers and service configuration will be removed. Named volumes are retained. This action cannot be undone."
          close={() => setDeleting(false)}
          onConfirm={async () => {
            await remove(`/services/${service.id}`);
            toast("Service deleted");
            navigate(`/projects/${service.projectId}`);
          }}
        />
      )}
    </>
  );
}

function DatabaseConnection({ service }: { service: Service }) {
  const [visible, setVisible] = useState(false);
  const e = service.env;
  const details =
    service.kind === "postgres"
      ? {
          scheme: "postgresql",
          port: 5432,
          username: e.POSTGRES_USER || "",
          password: e.POSTGRES_PASSWORD || "",
          database: e.POSTGRES_DB || "",
        }
      : service.kind === "mysql"
        ? {
            scheme: "mysql",
            port: 3306,
            username: e.MYSQL_USER || "root",
            password: e.MYSQL_PASSWORD || e.MYSQL_ROOT_PASSWORD || "",
            database: e.MYSQL_DATABASE || "",
          }
        : service.kind === "mariadb"
          ? {
              scheme: "mysql",
              port: 3306,
              username: e.MARIADB_USER || "root",
              password: e.MARIADB_PASSWORD || e.MARIADB_ROOT_PASSWORD || "",
              database: e.MARIADB_DATABASE || "",
            }
          : service.kind === "mongo"
            ? {
                scheme: "mongodb",
                port: 27017,
                username: e.MONGO_INITDB_ROOT_USERNAME || "",
                password: e.MONGO_INITDB_ROOT_PASSWORD || "",
                database: e.MONGO_INITDB_DATABASE || "",
              }
            : {
                scheme: "redis",
                port: 6379,
                username: "default",
                password: e.REDIS_PASSWORD || "",
                database: "0",
              };
  const credentials = `${encodeURIComponent(details.username)}:${encodeURIComponent(details.password)}`;
  const uri = `${details.scheme}://${credentials}@${service.name}:${details.port}/${encodeURIComponent(details.database)}${service.kind === "mongo" ? "?authSource=admin" : ""}`;
  const hiddenUri = `${details.scheme}://${details.username}:••••••••@${service.name}:${details.port}/${details.database}${service.kind === "mongo" ? "?authSource=admin" : ""}`;
  return (
    <Panel
      title="Private connection"
      description="Connect from applications inside this project’s Docker network."
      actions={
        <Button variant="ghost" onClick={() => setVisible(!visible)}>
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}{" "}
          {visible ? "Hide credentials" : "Reveal credentials"}
        </Button>
      }
    >
      <div className="form-panel connection-panel">
        <div className="connection-properties">
          <div>
            <span>HOSTNAME</span>
            <code>{service.name}</code>
          </div>
          <div>
            <span>PORT</span>
            <code>{details.port}</code>
          </div>
          <div>
            <span>DATABASE</span>
            <code>{details.database || "Not configured"}</code>
          </div>
          <div>
            <span>USERNAME</span>
            <code>{details.username || "Not configured"}</code>
          </div>
        </div>
        <Field label="Connection string">
          <div className="copy-field">
            <input
              aria-label="Database connection string"
              readOnly
              value={visible ? uri : hiddenUri}
              className="mono"
              autoComplete="off"
            />
            <CopyButton value={uri} label="Copy connection string" />
          </div>
        </Field>
        <p className="form-note">
          Copying includes the password. These saved credentials must match the
          initialized database; editing environment variables does not rotate an
          existing database’s users.
        </p>
      </div>
    </Panel>
  );
}

function ServiceReadView({
  service,
  section,
}: {
  service: Service;
  section: "source" | "storage" | "resources";
}) {
  if (section === "source")
    return (
      <Panel
        title="Application source"
        description="Read-only configuration for this service."
      >
        <dl className="property-list">
          <div>
            <dt>Source type</dt>
            <dd>{service.source.type}</dd>
          </div>
          {service.source.image && (
            <div>
              <dt>Image</dt>
              <dd>
                <code>{service.source.image}</code>
              </dd>
            </div>
          )}
          {service.source.repository && (
            <div>
              <dt>Repository</dt>
              <dd>
                <code>{service.source.repository}</code>
              </dd>
            </div>
          )}
          {service.source.branch && (
            <div>
              <dt>Branch</dt>
              <dd>{service.source.branch}</dd>
            </div>
          )}
        </dl>
        {["dockerfile", "compose"].includes(service.source.type) && (
          <p className="service-notes">
            Source contents are available to project operators.
          </p>
        )}
      </Panel>
    );
  if (section === "storage")
    return (
      <Panel
        title="Persistent storage"
        description="Read-only volume configuration."
      >
        {service.mounts.length ? (
          <dl className="property-list">
            {service.mounts.map((m) => (
              <div key={m.id}>
                <dt>{m.name}</dt>
                <dd>
                  <code>{m.mountPath}</code>
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="service-notes">No volumes configured.</p>
        )}
      </Panel>
    );
  return (
    <Panel
      title="Resources & networking"
      description="Read-only runtime limits and published ports."
    >
      <dl className="property-list">
        <div>
          <dt>CPU limit</dt>
          <dd>{service.resources.cpu} cores</dd>
        </div>
        <div>
          <dt>Memory limit</dt>
          <dd>{service.resources.memoryMb} MB</dd>
        </div>
        {service.ports.map((p, i) => (
          <div key={i}>
            <dt>{p.protocol.toUpperCase()} port</dt>
            <dd>
              {p.published} → {p.target}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
