import { useState, type FormEvent } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Box,
  Folder,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import type { Project, Service, ServiceKind } from "../shared/types";
import { navigate, post, patch, remove, slug, useQuery } from "./api";
import { useAccess } from "./Access";
import {
  Button,
  ConfirmDelete,
  Empty,
  ErrorBox,
  Field,
  IconButton,
  Loading,
  Modal,
  PageHeader,
  Panel,
  SearchInput,
  ServiceIcon,
  ServiceRow,
  useToast,
} from "./ui";

const colors = [
  "#56785d",
  "#487ea4",
  "#9772b8",
  "#b47b4e",
  "#bd6f83",
  "#7380b5",
];
export function CreateProject({
  close,
  created,
  project,
}: {
  close: () => void;
  created?: (p: Project) => void;
  project?: Project;
}) {
  const [name, setName] = useState(project?.name || "");
  const [description, setDescription] = useState(project?.description || "");
  const [color, setColor] = useState(project?.color || colors[0]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const saved = project
        ? await patch<Project>(`/projects/${project.id}`, {
            name,
            description,
            color,
          })
        : await post<Project>("/projects", { name, description, color });
      toast(project ? "Project updated" : "Project created");
      created?.(saved);
      close();
      if (!created) navigate(`/projects/${saved.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={project ? "Edit project" : "Create a project"}
      description="A dedicated home for related applications and databases."
      close={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={submit}>
        <ErrorBox message={error} />
        <Field
          label="Project name"
          hint="Lowercase letters, numbers, and hyphens."
        >
          <input
            name="name"
            autoFocus
            required
            value={name}
            onChange={(e) => setName(slug(e.target.value))}
            placeholder="my-project"
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            maxLength={48}
          />
        </Field>
        <Field label="Description">
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What are you building?"
            maxLength={500}
          />
        </Field>
        <fieldset className="color-field">
          <legend>Project color</legend>
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              className={`color-choice ${color === c ? "selected" : ""}`}
              style={{ backgroundColor: c }}
              onClick={() => setColor(c)}
              aria-label={`Color ${c}`}
              aria-pressed={color === c}
            />
          ))}
        </fieldset>
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
            {project ? <Pencil size={16} /> : <Plus size={16} />}
            {project ? "Save project" : "Create project"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
const kinds: { id: ServiceKind; label: string; description: string }[] = [
  {
    id: "app",
    label: "Application",
    description: "Docker image, Git, or Dockerfile",
  },
  {
    id: "compose",
    label: "Compose",
    description: "A multi-container application",
  },
  { id: "postgres", label: "PostgreSQL", description: "Relational database" },
  { id: "mysql", label: "MySQL", description: "Relational database" },
  { id: "mariadb", label: "MariaDB", description: "MySQL-compatible database" },
  { id: "mongo", label: "MongoDB", description: "Document database" },
  { id: "redis", label: "Redis", description: "In-memory data store" },
];
export function CreateService({
  projectId,
  close,
  created,
}: {
  projectId: string;
  close: () => void;
  created?: () => void;
}) {
  const [kind, setKind] = useState<ServiceKind>("app");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const service = await post<Service>("/services", {
        projectId,
        name,
        kind,
      });
      toast("Service created. Configure its source, then deploy.");
      created?.();
      close();
      navigate(`/services/${service.id}${kind === "app" ? "/source" : ""}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Add a service"
      description="Start with an application, a database, or a Compose stack."
      close={() => {
        if (!busy) close();
      }}
      wide
    >
      <form onSubmit={submit}>
        <ErrorBox message={error} />
        <div className="kind-grid">
          {kinds.map((k) => (
            <button
              type="button"
              className={`kind-card ${kind === k.id ? "selected" : ""}`}
              key={k.id}
              onClick={() => setKind(k.id)}
              aria-pressed={kind === k.id}
            >
              <ServiceIcon kind={k.id} />
              <span>
                <strong>{k.label}</strong>
                <small>{k.description}</small>
              </span>
              <span className="radio-indicator" />
            </button>
          ))}
        </div>
        <Field
          label="Service name"
          hint="Unique within this project. Lowercase letters, numbers, and hyphens."
        >
          <input
            name="name"
            autoFocus
            required
            value={name}
            onChange={(e) => setName(slug(e.target.value))}
            placeholder={kind === "app" ? "web" : kind}
            maxLength={48}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
          />
        </Field>
        {!["app", "compose"].includes(kind) && (
          <p className="form-note">
            Credentials and a persistent volume are generated automatically. The
            database remains private unless you publish a port.
          </p>
        )}
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
            Create service
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function ProjectsPage({ projectId }: { projectId?: string }) {
  const access = useAccess();
  const projects = useQuery<Project[]>("/projects");
  const services = useQuery<Service[]>(
    projectId
      ? `/services?projectId=${encodeURIComponent(projectId)}`
      : "/services",
    8000,
  );
  const [search, setSearch] = useState("");
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState(false);
  const [addService, setAddService] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  if (projects.loading || services.loading) return <Loading />;
  if (projects.error || services.error)
    return (
      <ErrorBox
        message={projects.error || services.error}
        retry={() => {
          projects.reload();
          services.reload();
        }}
      />
    );
  const project = projects.data?.find((p) => p.id === projectId);
  if (projectId && !project)
    return (
      <Empty
        title="Project not found"
        description="It may have been removed."
        action={
          <Button onClick={() => navigate("/projects")}>
            Back to projects
          </Button>
        }
      />
    );
  const list = (services.data || []).filter(
    (s) => !projectId || s.projectId === projectId,
  );
  return (
    <>
      {project && (
        <a className="back-link" href="#/projects">
          <ArrowLeft size={15} />
          All projects
        </a>
      )}
      <PageHeader
        eyebrow={project ? "PROJECT WORKSPACE" : "YOUR WORKSPACE"}
        title={project?.name || "Projects"}
        description={
          project?.description || "Everything you build, with room to grow."
        }
        actions={
          <>
            {project && access.isAdmin && (
              <IconButton label="Edit project" onClick={() => setEdit(true)}>
                <Pencil size={17} />
              </IconButton>
            )}
            {project && access.isAdmin && (
              <IconButton
                label="Delete project"
                onClick={() => setDeleting(true)}
              >
                <Trash2 size={17} />
              </IconButton>
            )}
            {(project ? access.canOperate(project.id) : access.isAdmin) && (
              <Button
                onClick={() =>
                  project ? setAddService(true) : setCreate(true)
                }
              >
                <Plus size={17} />
                {project ? "Add service" : "New project"}
              </Button>
            )}
          </>
        }
      />
      <div className="toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={project ? "Find a service…" : "Find a project…"}
          label={project ? "Search services" : "Search projects"}
        />
        <span className="count-label">
          {project
            ? `${list.length} services`
            : `${projects.data?.length || 0} projects`}
        </span>
      </div>
      {project ? (
        <Panel>
          {list
            .filter((s) => s.name.toLowerCase().includes(search.toLowerCase()))
            .map((s) => (
              <ServiceRow key={s.id} service={s} />
            ))}
          {!list.length && (
            <Empty
              icon={<Box size={27} />}
              title="A fresh space for your next idea"
              description={
                access.canOperate(project.id)
                  ? "Add your first service to start building this project."
                  : "Services will appear here when an operator adds them."
              }
              action={
                access.canOperate(project.id) && (
                  <Button onClick={() => setAddService(true)}>
                    <Plus size={16} />
                    Add service
                  </Button>
                )
              }
            />
          )}{" "}
          {!!list.length &&
            !list.some((s) =>
              s.name.toLowerCase().includes(search.toLowerCase()),
            ) && (
              <Empty
                title="No matching services"
                description="Try a different service name."
              />
            )}
        </Panel>
      ) : (
        <div className="project-grid">
          {projects.data
            ?.filter((p) =>
              `${p.name} ${p.description}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((p) => {
              const items = list.filter((s) => s.projectId === p.id);
              const running = items.filter(
                (s) => s.status === "running",
              ).length;
              return (
                <button
                  className="project-card"
                  key={p.id}
                  onClick={() => navigate(`/projects/${p.id}`)}
                >
                  <div className="project-card-top">
                    <span
                      className="project-symbol"
                      style={{
                        color: p.color,
                        backgroundColor: `${p.color}15`,
                      }}
                    >
                      <Folder size={23} />
                    </span>
                    <ArrowUpRight size={19} />
                  </div>
                  <h3>{p.name}</h3>
                  <p>{p.description || "Your next great thing starts here."}</p>
                  <div className="project-services">
                    {items.slice(0, 5).map((s) => (
                      <ServiceIcon key={s.id} kind={s.kind} size={16} />
                    ))}
                    {!items.length && (
                      <span className="muted">No services yet</span>
                    )}
                    {items.length > 5 && <span>+{items.length - 5}</span>}
                  </div>
                  <div className="project-card-footer">
                    <span>
                      {items.length}{" "}
                      {items.length === 1 ? "service" : "services"}
                    </span>
                    <span className={running ? "online-label" : "muted"}>
                      {running > 0 && <i />}
                      {running} running
                    </span>
                  </div>
                </button>
              );
            })}
          {access.isAdmin && (
            <button
              className="project-card new-project-card"
              onClick={() => setCreate(true)}
            >
              <span>
                <Plus size={24} />
              </span>
              <h3>Create a project</h3>
              <p>A new home for your applications.</p>
            </button>
          )}
        </div>
      )}
      {create && access.isAdmin && (
        <CreateProject
          close={() => setCreate(false)}
          created={(p) => {
            projects.reload();
            navigate(`/projects/${p.id}`);
          }}
        />
      )}
      {edit && project && access.isAdmin && (
        <CreateProject
          project={project}
          close={() => setEdit(false)}
          created={() => projects.reload()}
        />
      )}
      {addService && project && access.canOperate(project.id) && (
        <CreateService
          projectId={project.id}
          close={() => setAddService(false)}
          created={services.reload}
        />
      )}
      {deleting && project && access.isAdmin && (
        <ConfirmDelete
          name={project.name}
          description="Only empty projects can be deleted. Remove its services first."
          close={() => setDeleting(false)}
          onConfirm={async () => {
            await remove(`/projects/${project.id}`);
            toast("Project deleted");
            projects.reload();
            navigate("/projects");
          }}
        />
      )}
    </>
  );
}
