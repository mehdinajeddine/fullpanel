import { useEffect, useState, type FormEvent } from "react";
import {
  Activity as ActivityIcon,
  ArrowLeft,
  ArrowUpRight,
  Download,
  HardDrive,
  Package,
  Plus,
  RefreshCw,
  Rocket,
  Save,
  Search,
  Server,
} from "lucide-react";
import type {
  Activity,
  Backup,
  Deployment,
  Project,
  Service,
  Settings,
  Template,
} from "../shared/types";
import {
  bytes,
  date,
  navigate,
  patch,
  post,
  relative,
  slug,
  useQuery,
} from "./api";
import {
  Badge,
  Button,
  CopyButton,
  Empty,
  ErrorBox,
  Field,
  IconButton,
  Loading,
  Modal,
  Notice,
  PageHeader,
  Panel,
  SearchInput,
  ServiceIcon,
  useToast,
} from "./ui";
import { CreateProject } from "./Projects";
import BackupSchedules from "./BackupSchedules";
import { useAccess } from "./Access";
import { RestoreAction, RestoreHistory } from "./Restores";

function InstallTemplate({
  template,
  projects,
  close,
}: {
  template: Template;
  projects: Project[];
  close: () => void;
}) {
  const [projectId, setProjectId] = useState(projects[0]?.id || "");
  const [name, setName] = useState(slug(template.name));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const s = await post<Service>(`/templates/${template.id}/install`, {
        projectId,
        name,
      });
      toast("Template added. Review its configuration, then deploy.");
      close();
      navigate(`/services/${s.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Add ${template.name}`}
      description="Create a configured service in your project."
      close={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={submit}>
        <ErrorBox message={error} />
        <Field label="Project">
          <select
            required
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Service name">
          <input
            required
            value={name}
            onChange={(e) => setName(slug(e.target.value))}
            maxLength={48}
          />
        </Field>
        <div className="template-summary">
          <ServiceIcon kind={template.kind} />
          <div>
            <strong>{template.name}</strong>
            <code>{template.image}</code>
          </div>
        </div>
        <Notice>
          Review generated credentials, environment variables, and storage
          before your first deployment.
        </Notice>
        <div className="modal-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button busy={busy}>
            <Plus size={16} />
            Add to project
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function TemplatesPage() {
  const access = useAccess();
  const templates = useQuery<Template[]>("/templates");
  const projects = useQuery<Project[]>("/projects");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All templates");
  const [install, setInstall] = useState<Template>();
  const [pendingTemplate, setPendingTemplate] = useState<Template>();
  const [create, setCreate] = useState(false);
  const availableProjects = (projects.data || []).filter((project) =>
    access.canOperate(project.id),
  );
  const categories = [
    "All templates",
    ...new Set(templates.data?.map((t) => t.category) || []),
  ];
  const list = (templates.data || []).filter(
    (t) =>
      (category === "All templates" || t.category === category) &&
      `${t.name} ${t.description} ${t.category}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="THE STARTING LINE"
        title="Good tools. Ready to go."
        description="A thoughtfully curated collection for your next project."
      />
      <div className="template-banner">
        <div className="template-banner-icon">
          <Package size={30} />
        </div>
        <div>
          <h2>From idea to running service.</h2>
          <p>
            Choose a template, make it yours, and deploy on your own
            infrastructure.
          </p>
        </div>
        <span className="tag">YOUR SERVER. YOUR RULES.</span>
      </div>
      <div className="toolbar">
        <div className="filter-pills">
          {categories.map((c) => (
            <button
              key={c}
              className={c === category ? "active" : ""}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Find your next tool…"
          label="Search templates"
        />
      </div>
      <ErrorBox
        message={templates.error || projects.error}
        retry={() => {
          templates.reload();
          projects.reload();
        }}
      />
      {templates.loading ? (
        <Loading label="Loading templates" />
      ) : (
        <div className="template-grid">
          {list.map((t) => (
            <article key={t.id} className="template-card">
              <div className="template-card-top">
                <span className={`template-monogram kind-${t.kind}`}>
                  {t.name.slice(0, 2)}
                </span>
                <span className="category-tag">{t.category}</span>
              </div>
              <h3>{t.name}</h3>
              <p>{t.description}</p>
              <div className="template-card-footer">
                {t.website && (
                  <a
                    href={t.website}
                    target="_blank"
                    rel="noreferrer"
                    className="text-link"
                  >
                    Website
                    <ArrowUpRight size={13} />
                  </a>
                )}
                {(access.isAdmin || availableProjects.length > 0) && (
                  <Button
                    variant="secondary"
                    disabled={projects.loading || !!projects.error}
                    onClick={() => {
                      if (availableProjects.length) setInstall(t);
                      else {
                        setPendingTemplate(t);
                        setCreate(true);
                      }
                    }}
                  >
                    <Plus size={15} />
                    Use template
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {!templates.loading && !list.length && !templates.error && (
        <Empty
          icon={<Search size={24} />}
          title="Nothing here just yet"
          description="Try a different search or category."
        />
      )}
      {install && (
        <InstallTemplate
          template={install}
          projects={availableProjects}
          close={() => setInstall(undefined)}
        />
      )}
      {create && access.isAdmin && (
        <CreateProject
          close={() => setCreate(false)}
          created={(project) => {
            projects.setData((old) => [...(old || []), project]);
            if (pendingTemplate) setInstall(pendingTemplate);
            setPendingTemplate(undefined);
            projects.reload();
          }}
        />
      )}
    </>
  );
}
export function DeploymentTable({
  deployments,
  services,
}: {
  deployments: Deployment[];
  services?: Service[];
  compact?: boolean;
}) {
  if (!deployments.length)
    return (
      <Empty
        icon={<Rocket size={26} />}
        title="No deployments yet"
        description="Deploy a service to see its build output and history here."
      />
    );
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>{services ? "Service" : "Deployment"}</th>
            <th>Status</th>
            <th>Trigger</th>
            <th>Started</th>
            <th>Duration</th>
            <th>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((d) => (
            <tr key={d.id}>
              <td>
                <button
                  className="table-title"
                  onClick={() => navigate(`/deployments/${d.id}`)}
                >
                  <span className="small-icon">
                    <Rocket size={15} />
                  </span>
                  {services?.find((s) => s.id === d.serviceId)?.name ||
                    d.id.slice(0, 8)}
                </button>
              </td>
              <td>
                <Badge status={d.status} />
              </td>
              <td className="muted">{d.trigger || "Manual"}</td>
              <td>
                <time title={date(d.createdAt)}>{relative(d.createdAt)}</time>
              </td>
              <td className="mono muted">
                {d.finishedAt
                  ? `${Math.max(0, (new Date(d.finishedAt).getTime() - new Date(d.createdAt).getTime()) / 1000).toFixed(1)}s`
                  : "—"}
              </td>
              <td>
                <IconButton
                  label={`View deployment ${d.id.slice(0, 8)}`}
                  onClick={() => navigate(`/deployments/${d.id}`)}
                >
                  <ArrowUpRight size={17} />
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function DeploymentsPage({ deploymentId }: { deploymentId?: string }) {
  const deployments = useQuery<Deployment[]>("/deployments", 4000);
  const services = useQuery<Service[]>("/services");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  if (deploymentId) return <DeploymentDetail id={deploymentId} />;
  const list = (deployments.data || []).filter(
    (d) =>
      (filter === "all" || d.status === filter) &&
      `${d.id} ${services.data?.find((s) => s.id === d.serviceId)?.name || ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="EVERY LAUNCH, ONE PLACE"
        title="Deployments"
        description="Follow your changes from build to running service."
        actions={
          <Button variant="secondary" onClick={deployments.reload}>
            <RefreshCw size={16} />
            Refresh
          </Button>
        }
      />
      <div className="toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Find a deployment…"
          label="Search deployments"
        />
        <select
          className="filter-select"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter deployment status"
        >
          <option value="all">All statuses</option>
          <option value="success">Successful</option>
          <option value="failed">Failed</option>
          <option value="running">Running</option>
          <option value="queued">Queued</option>
        </select>
      </div>
      <ErrorBox
        message={deployments.error || services.error}
        retry={() => {
          deployments.reload();
          services.reload();
        }}
      />
      <Panel>
        {deployments.loading ? (
          <Loading />
        ) : (
          <DeploymentTable deployments={list} services={services.data} />
        )}
      </Panel>
    </>
  );
}
export function DeploymentDetail({ id }: { id: string }) {
  const access = useAccess();
  const deployment = useQuery<Deployment>(
    `/deployments/${encodeURIComponent(id)}`,
    2500,
  );
  const services = useQuery<Service[]>("/services");
  const d = deployment.data;
  const s = services.data?.find((s) => s.id === d?.serviceId);
  return (
    <>
      <a href="#/deployments" className="back-link">
        <ArrowLeft size={15} />
        All deployments
      </a>
      <PageHeader
        eyebrow="DEPLOYMENT DETAILS"
        title={s ? `${s.name} deployment` : "Deployment output"}
        description={d ? `Started ${date(d.createdAt)}` : undefined}
        actions={
          s && (
            <Button
              variant="secondary"
              onClick={() => navigate(`/services/${s.id}`)}
            >
              View service
              <ArrowUpRight size={16} />
            </Button>
          )
        }
      />
      <ErrorBox message={deployment.error} retry={deployment.reload} />
      {d ? (
        <>
          <div className="detail-summary">
            <Badge status={d.status} />
            <span className="mono">{d.id.slice(0, 12)}</span>
            <span>{d.trigger}</span>
            {(d as Deployment & { commit?: string }).commit && (
              <code title={(d as Deployment & { commit?: string }).commit}>
                commit{" "}
                {(d as Deployment & { commit?: string }).commit?.slice(0, 12)}
              </code>
            )}
            {d.finishedAt && <span>Finished {date(d.finishedAt)}</span>}
          </div>
          {access.isAdmin || access.canOperate(s?.projectId || d.projectId) ? (
            <Panel
              title="Build & deployment output"
              actions={<CopyButton value={d.output} label="Copy output" />}
            >
              <pre
                className="terminal-output"
                aria-live={d.status === "running" ? "polite" : "off"}
              >
                {d.output || "Waiting for the deployment worker…"}
                {["running", "queued"].includes(d.status) && (
                  <span className="terminal-cursor" />
                )}
              </pre>
            </Panel>
          ) : (
            <Notice>
              Deployment output is available to project operators. You can view
              deployment status and timing here.
            </Notice>
          )}
        </>
      ) : deployment.loading ? (
        <Loading />
      ) : null}
    </>
  );
}
export function BackupTable({
  backups,
  services,
  projectId,
  targetServiceId,
}: {
  backups: Backup[];
  services?: Service[];
  projectId?: string;
  targetServiceId?: string;
}) {
  const access = useAccess();
  if (!backups.length)
    return (
      <Empty
        icon={<HardDrive size={26} />}
        title="A little peace of mind"
        description="Run your first backup from a service to protect its data."
      />
    );
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>{services ? "Service" : "Backup"}</th>
            <th>Status</th>
            <th>Created</th>
            <th>Size</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {backups.map((b) => (
            <tr key={b.id}>
              <td>
                <span className="table-title">
                  <span className="small-icon">
                    <HardDrive size={15} />
                  </span>
                  {services?.find((s) => s.id === b.serviceId)?.name ||
                    b.filename ||
                    b.id.slice(0, 8)}
                </span>
                {b.error && <small className="cell-error">{b.error}</small>}
              </td>
              <td>
                <Badge status={b.status} />
              </td>
              <td>
                <time title={date(b.createdAt)}>{relative(b.createdAt)}</time>
              </td>
              <td className="mono">
                {b.status === "success" ? bytes(b.sizeBytes) : "—"}
              </td>
              <td>
                <div className="backup-row-actions">
                  {b.status === "success" &&
                  access.canOperate(
                    projectId ||
                      services?.find((s) => s.id === b.serviceId)?.projectId ||
                      b.projectId,
                  ) ? (
                    <a
                      className="download-link"
                      href={`/api/backups/${encodeURIComponent(b.id)}/download`}
                      download
                    >
                      <Download size={16} />
                      <span>Download</span>
                    </a>
                  ) : (
                    <span className="muted">—</span>
                  )}
                  <RestoreAction
                    backup={b}
                    projectId={
                      projectId ||
                      services?.find((service) => service.id === b.serviceId)
                        ?.projectId ||
                      b.projectId
                    }
                    preferredTargetId={targetServiceId}
                  />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export function BackupsPage() {
  const access = useAccess();
  const backups = useQuery<Backup[]>("/backups", 5000);
  const services = useQuery<Service[]>("/services");
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function run() {
    if (!selected) return;
    setBusy(true);
    try {
      await post(`/services/${selected}/backups`);
      toast("Backup started");
      backups.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="KEEP WHAT MATTERS"
        title="Backups"
        description="Keep a recoverable copy of your application data."
      />
      <Notice>
        {access.mode === "demo"
          ? "Demo backups are illustrative. Restore is available in Docker mode."
          : "Backups are stored on this server. Download a copy to a separate location for disaster recovery. Verified backups can be restored to a compatible running service."}
      </Notice>
      {(services.data || []).some((s) => access.canOperate(s.projectId)) && (
        <div className="backup-action">
          <div>
            <h3>Create a backup</h3>
            <p>Export a database or archive a service’s persistent volumes.</p>
          </div>
          <div>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              aria-label="Service to back up"
            >
              <option value="">Choose a service</option>
              {services.data
                ?.filter(
                  (s) =>
                    access.canOperate(s.projectId) &&
                    s.kind !== "compose" &&
                    (s.kind !== "app" || s.mounts.length > 0),
                )
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
            <Button onClick={run} busy={busy} disabled={!selected}>
              <Plus size={16} />
              Run backup
            </Button>
          </div>
        </div>
      )}
      <ErrorBox
        message={backups.error || services.error}
        retry={() => {
          backups.reload();
          services.reload();
        }}
      />
      {(services.data || []).some((s) => access.canOperate(s.projectId)) && (
        <BackupSchedules services={services.data || []} />
      )}
      <Panel
        title="Backup history"
        actions={
          <Button variant="ghost" onClick={backups.reload}>
            <RefreshCw size={15} />
            Refresh
          </Button>
        }
      >
        {backups.loading ? (
          <Loading />
        ) : (
          <BackupTable backups={backups.data || []} services={services.data} />
        )}
      </Panel>
      <RestoreHistory services={services.data || []} />
    </>
  );
}
export function ActivityPage() {
  const { data, error, loading, reload } = useQuery<Activity[]>(
    "/activity",
    8000,
  );
  const [search, setSearch] = useState("");
  const list = (data || []).filter((a) =>
    `${a.action} ${a.resource} ${a.detail || ""}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="THE WORKSPACE JOURNAL"
        title="Activity"
        description="A clear record of changes across your infrastructure."
        actions={
          <Button variant="secondary" onClick={reload}>
            <RefreshCw size={16} />
            Refresh
          </Button>
        }
      />
      <div className="toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search workspace activity…"
          label="Search activity"
        />
        <span className="count-label">{list.length} events</span>
      </div>
      <ErrorBox message={error} retry={reload} />
      <Panel>
        {loading ? (
          <Loading />
        ) : list.length ? (
          <div className="activity-list">
            {list.map((a) => (
              <div className="activity-full" key={a.id}>
                <span className="event-symbol">
                  <ActivityIcon size={17} />
                </span>
                <div>
                  <strong>{a.action.replace(/\./g, " ")}</strong>
                  <p>
                    {a.resource}
                    {a.detail && <span> · {a.detail}</span>}
                  </p>
                </div>
                <time title={date(a.createdAt)}>{relative(a.createdAt)}</time>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={<ActivityIcon size={26} />}
            title="A clean slate"
            description="Workspace changes will appear here as you work."
          />
        )}
      </Panel>
    </>
  );
}
export function SettingsPage() {
  const query = useQuery<Settings>("/settings");
  const [values, setValues] = useState<Settings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  useEffect(() => {
    if (query.data) setValues(query.data);
  }, [query.data]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!values) return;
    setBusy(true);
    setError("");
    try {
      const saved = await patch<Settings>("/settings", values);
      setValues(saved);
      window.dispatchEvent(
        new CustomEvent("harborlight:settings", { detail: saved }),
      );
      toast("Workspace settings saved");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="MAKE IT YOURS"
        title="Settings"
        description="A few thoughtful defaults for your workspace."
      />
      <ErrorBox
        message={query.error || error}
        retry={query.error ? query.reload : undefined}
      />
      {values ? (
        <form onSubmit={save} className="settings-layout">
          <div className="settings-intro">
            <Server size={26} />
            <h2>Your server</h2>
            <p>Give this workspace a name and configure its domain defaults.</p>
          </div>
          <Panel>
            <div className="form-panel">
              <Field label="Server name">
                <input
                  value={values.serverName}
                  onChange={(e) =>
                    setValues({ ...values, serverName: e.target.value })
                  }
                  required
                  maxLength={80}
                />
              </Field>
              <Field
                label="Base domain"
                hint="Used for new application hostnames. Existing services keep their domains. Review the target port before deploying."
              >
                <input
                  value={values.baseDomain}
                  onChange={(e) =>
                    setValues({ ...values, baseDomain: e.target.value })
                  }
                  placeholder="apps.example.com"
                />
              </Field>
              <Notice>
                Configure the proxy’s certificate contact with ACME_EMAIL in
                your deployment environment. DNS must point to this server
                before HTTPS can work.
              </Notice>
              <Field label="Appearance">
                <select
                  value={values.theme}
                  onChange={(e) =>
                    setValues({
                      ...values,
                      theme: e.target.value as Settings["theme"],
                    })
                  }
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                  <option value="system">Follow system</option>
                </select>
              </Field>
              <div className="form-actions">
                <Button busy={busy}>
                  <Save size={16} />
                  Save settings
                </Button>
              </div>
            </div>
          </Panel>
        </form>
      ) : query.loading ? (
        <Loading />
      ) : null}
      <div className="about-panel">
        <div>
          <h3>
            Harborlight <span className="version-label">v0.1.0</span>
          </h3>
          <p>Independent. Open source. Built to give your ideas a home.</p>
        </div>
        <span className="category-tag">Apache-2.0</span>
      </div>
    </>
  );
}
