import { useState, type FormEvent } from "react";
import { KeyRound, Pencil, Plus, Shield, Trash2, Users } from "lucide-react";
import type { Project, ApiKey } from "../shared/types";
import { api, date, patch, post, useQuery } from "./api";
import { useAccess, type Identity, type Membership } from "./Access";
import {
  Badge,
  Button,
  ConfirmDelete,
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
  useToast,
} from "./ui";

function MembershipPicker({
  projects,
  value,
  onChange,
}: {
  projects: Project[];
  value: Membership[];
  onChange: (value: Membership[]) => void;
}) {
  return (
    <fieldset className="membership-picker">
      <legend>Project access</legend>
      <p>
        Operators can configure and deploy services. Viewers can inspect project
        status without secrets, runtime logs, or backup downloads.
      </p>
      {projects.length ? (
        projects.map((project) => {
          const membership = value.find((m) => m.projectId === project.id);
          return (
            <div className="membership-row" key={project.id}>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={!!membership}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...value, { projectId: project.id, role: "viewer" }]
                        : value.filter((m) => m.projectId !== project.id),
                    )
                  }
                />
                <span>{project.name}</span>
              </label>
              {membership && (
                <select
                  aria-label={`Access to ${project.name}`}
                  value={membership.role}
                  onChange={(e) =>
                    onChange(
                      value.map((m) =>
                        m.projectId === project.id
                          ? { ...m, role: e.target.value as Membership["role"] }
                          : m,
                      ),
                    )
                  }
                >
                  <option value="viewer">Viewer</option>
                  <option value="operator">Operator</option>
                </select>
              )}
            </div>
          );
        })
      ) : (
        <div className="inline-empty">
          Create a project before granting project access.
        </div>
      )}
    </fieldset>
  );
}
function UserEditor({
  user,
  projects,
  close,
  saved,
}: {
  user?: Identity;
  projects: Project[];
  close: () => void;
  saved: () => void;
}) {
  const [name, setName] = useState(user?.name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "member">(
    user?.role === "admin" ? "admin" : "member",
  );
  const [memberships, setMemberships] = useState<Membership[]>(
    user?.memberships || [],
  );
  const [disabled, setDisabled] = useState(user?.disabled || false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = {
        name,
        email,
        role,
        memberships: role === "member" ? memberships : [],
      };
      if (user) await patch(`/users/${user.id}`, { ...body, disabled });
      else await post("/users", { ...body, password });
      toast(user ? "Account updated" : "Account created");
      saved();
      close();
      window.dispatchEvent(new Event("harborlight:identity"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={user ? "Edit account" : "Create an account"}
      description={
        user
          ? "Manage this person’s role and project access."
          : "Add someone to this FullPanel workspace."
      }
      close={() => {
        if (!busy) close();
      }}
      wide
    >
      <form onSubmit={submit}>
        <ErrorBox message={error} />
        <div className="form-grid">
          <Field label="Full name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              autoComplete="off"
              autoFocus
            />
          </Field>
          <Field label="Account email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              maxLength={254}
              autoComplete="off"
            />
          </Field>
        </div>
        {!user && (
          <Field
            label="Initial password"
            hint="At least 12 characters. Share it securely; FullPanel does not send email invitations."
          >
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
              maxLength={200}
              autoComplete="new-password"
            />
          </Field>
        )}
        <Field label="Workspace role">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
          >
            <option value="member">Member — access to selected projects</option>
            <option value="admin">Administrator — full server access</option>
          </select>
        </Field>
        {role === "member" ? (
          <MembershipPicker
            projects={projects}
            value={memberships}
            onChange={setMemberships}
          />
        ) : (
          <Notice>
            Administrators can manage every project, server settings, and other
            accounts.
          </Notice>
        )}
        {user && (
          <label className="checkbox-field account-disabled">
            <input
              type="checkbox"
              checked={disabled}
              onChange={(e) => setDisabled(e.target.checked)}
            />
            <span>Disable this account and revoke its active access</span>
          </label>
        )}
        <div className="modal-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </Button>
          <Button busy={busy}>
            {user ? "Save account" : "Create account"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function ResetPassword({
  user,
  close,
  saved,
}: {
  user: Identity;
  close: () => void;
  saved: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirmation) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await post(`/users/${user.id}/password`, { password });
      toast("Password reset. Previous sessions and API keys were revoked.");
      saved();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Reset ${user.name}’s password`}
      description="This ends the account’s existing sessions and revokes its API keys."
      close={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={submit}>
        <ErrorBox message={error} />
        <Field label="New password">
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={12}
            maxLength={200}
            required
            autoFocus
          />
        </Field>
        <Field label="Confirm new password">
          <input
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            minLength={12}
            maxLength={200}
            required
          />
        </Field>
        <div className="modal-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button busy={busy}>Reset password</Button>
        </div>
      </form>
    </Modal>
  );
}
export function AccountsPage() {
  const access = useAccess();
  const users = useQuery<Identity[]>("/users", 0, access.isAdmin);
  const projects = useQuery<Project[]>("/projects", 0, access.isAdmin);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Identity | "new">();
  const [resetting, setResetting] = useState<Identity>();
  const [deleting, setDeleting] = useState<Identity>();
  const toast = useToast();
  if (!access.isAdmin)
    return (
      <Empty
        icon={<Shield size={26} />}
        title="Administrator access required"
        description="Only the workspace owner and administrators can manage accounts."
      />
    );
  const list = (users.data || []).filter((u) =>
    `${u.name} ${u.email}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        eyebrow="THE PEOPLE BEHIND THE PROJECTS"
        title="Team & access"
        description="Give each person the access they need, project by project."
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus size={16} />
            Add account
          </Button>
        }
      />
      <div className="toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Find a person…"
          label="Search accounts"
        />
        <span className="count-label">{users.data?.length || 0} accounts</span>
      </div>
      <ErrorBox
        message={users.error || projects.error}
        retry={() => {
          users.reload();
          projects.reload();
        }}
      />
      <Panel>
        {users.loading ? (
          <Loading label="Loading accounts" />
        ) : list.length ? (
          <div className="account-list">
            {list.map((user) => (
              <article className="account-row" key={user.id}>
                <span className="account-avatar">
                  {user.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="account-identity">
                  <h3>
                    {user.name}
                    {user.id === access.user?.id && <span>You</span>}
                  </h3>
                  <p>{user.email}</p>
                  <small>
                    {user.role === "member"
                      ? `${user.memberships.length} project${user.memberships.length === 1 ? "" : "s"}`
                      : "All projects"}
                  </small>
                </div>
                <Badge status={user.disabled ? "disabled" : user.role} />
                <div className="account-actions">
                  {user.role !== "owner" && user.id !== access.user?.id ? (
                    <>
                      <IconButton
                        label={`Edit ${user.name}`}
                        onClick={() => setEditing(user)}
                      >
                        <Pencil size={16} />
                      </IconButton>
                      <IconButton
                        label={`Reset password for ${user.name}`}
                        onClick={() => setResetting(user)}
                      >
                        <KeyRound size={16} />
                      </IconButton>
                      <IconButton
                        label={`Delete ${user.name}`}
                        onClick={() => setDeleting(user)}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </>
                  ) : (
                    <span className="protected-account">
                      <Shield size={14} />
                      {user.role === "owner"
                        ? "Protected owner"
                        : "Your account"}
                    </span>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            icon={<Users size={26} />}
            title="No matching accounts"
            description="Try searching by name or email address."
          />
        )}
      </Panel>
      {editing && (
        <UserEditor
          user={editing === "new" ? undefined : editing}
          projects={projects.data || []}
          close={() => setEditing(undefined)}
          saved={users.reload}
        />
      )}{" "}
      {resetting && (
        <ResetPassword
          user={resetting}
          close={() => setResetting(undefined)}
          saved={users.reload}
        />
      )}{" "}
      {deleting && (
        <ConfirmDelete
          name={deleting.name}
          description="This removes the account and revokes its sessions and API keys. Project services and data remain on the server."
          close={() => setDeleting(undefined)}
          onConfirm={async () => {
            await api(`/users/${deleting.id}`, { method: "DELETE" });
            toast("Account removed");
            users.reload();
          }}
        />
      )}
    </>
  );
}
function ApiKeyEditor({
  projects,
  close,
  created,
}: {
  projects: Project[];
  close: () => void;
  created: (key: ApiKey & { token: string }) => void;
}) {
  const access = useAccess();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [permission, setPermission] = useState<"read" | "write">("read");
  const [expiresInDays, setExpiresInDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canWrite =
    selected.length > 0 && selected.every((id) => access.canOperate(id));
  function toggle(id: string, checked: boolean) {
    const next = checked ? [...selected, id] : selected.filter((p) => p !== id);
    setSelected(next);
    if (next.some((p) => !access.canOperate(p))) setPermission("read");
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!selected.length) {
      setError("Select at least one project.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await post<ApiKey & { token: string }>("/api-keys", {
        name,
        projectIds: selected,
        permission,
        expiresInDays,
      });
      created(result);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Create an API key"
      description="A personal credential scoped to selected projects."
      close={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={submit}>
        <ErrorBox message={error} />
        <Field label="Key name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={80}
            placeholder="CI deployment"
            autoFocus
          />
        </Field>
        <fieldset className="membership-picker">
          <legend>Projects</legend>
          {projects.map((p) => (
            <div key={p.id} className="membership-row">
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={selected.includes(p.id)}
                  onChange={(e) => toggle(p.id, e.target.checked)}
                />
                <span>{p.name}</span>
              </label>
              <span className="scope-label">
                {access.canOperate(p.id) ? "Operator access" : "Read only"}
              </span>
            </div>
          ))}
          {!projects.length && (
            <p>No projects are available to your account yet.</p>
          )}
        </fieldset>
        <Field label="Permission">
          <select
            value={permission}
            onChange={(e) => setPermission(e.target.value as typeof permission)}
          >
            <option value="read">Read only</option>
            <option value="write" disabled={!canWrite}>
              Read, configure & deploy
            </option>
          </select>
        </Field>
        <Field
          label="Expires in (days)"
          hint="1–365 days. Access also depends on your current account and project permissions."
        >
          <input
            type="number"
            min={1}
            max={365}
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(Number(e.target.value))}
            required
          />
        </Field>
        <Notice>
          API keys cannot manage accounts, server settings, or other API keys.
          The secret is shown only once.
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
          <Button busy={busy} disabled={!projects.length}>
            Create API key
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function ApiKeysPage() {
  const keys = useQuery<ApiKey[]>("/api-keys");
  const projects = useQuery<Project[]>("/projects");
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<ApiKey & { token: string }>();
  const [deleting, setDeleting] = useState<ApiKey>();
  const toast = useToast();
  return (
    <>
      <PageHeader
        eyebrow="CONNECT YOUR WORKFLOW"
        title="Your API keys"
        description="Personal access for scripts and trusted integrations."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} />
            New API key
          </Button>
        }
      />
      <ErrorBox
        message={keys.error || projects.error}
        retry={() => {
          keys.reload();
          projects.reload();
        }}
      />
      <Notice>
        These are your keys. Their permissions never exceed your current project
        access. Send tokens in the Authorization: Bearer header, never in a URL.
      </Notice>
      <Panel title="Personal credentials">
        {keys.loading ? (
          <Loading label="Loading API keys" />
        ) : keys.data?.length ? (
          <div className="api-key-list">
            {keys.data.map((key) => (
              <article className="api-key-row" key={key.id}>
                <span className="event-symbol">
                  <KeyRound size={18} />
                </span>
                <div className="api-key-info">
                  <h3>{key.name}</h3>
                  <p>
                    <code>{key.prefix}…</code>
                    <span>·</span>
                    {key.permission === "write" ? "Read & write" : "Read only"}
                    <span>·</span>
                    {key.projectIds
                      .map(
                        (id) =>
                          projects.data?.find((p) => p.id === id)?.name ||
                          "Unavailable project",
                      )
                      .join(", ")}
                  </p>
                  <small>Expires {date(key.expiresAt)}</small>
                </div>
                <Badge
                  status={
                    new Date(key.expiresAt).getTime() <= Date.now()
                      ? "expired"
                      : "active"
                  }
                />
                <IconButton
                  label={`Revoke ${key.name}`}
                  onClick={() => setDeleting(key)}
                >
                  <Trash2 size={16} />
                </IconButton>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            icon={<KeyRound size={26} />}
            title="Keep your tools connected"
            description="Create a scoped key for automation without sharing your account password."
            action={
              <Button variant="secondary" onClick={() => setCreating(true)}>
                <Plus size={15} />
                Create your first key
              </Button>
            }
          />
        )}
      </Panel>
      {creating && (
        <ApiKeyEditor
          projects={projects.data || []}
          close={() => setCreating(false)}
          created={(key) => {
            setNewKey(key);
            keys.reload();
            toast("API key created");
          }}
        />
      )}
      {newKey && (
        <Modal
          title="Save your API key"
          description="This is the only time FullPanel will display the secret."
          close={() => setNewKey(undefined)}
        >
          <Field label="New API key token">
            <div className="copy-field">
              <input
                value={newKey.token}
                readOnly
                className="mono"
                autoComplete="off"
              />
              <CopyButton value={newKey.token} label="Copy API key" />
            </div>
          </Field>
          <Notice>
            Store this token in your secret manager or CI secrets. Closing this
            dialog removes it from this view.
          </Notice>
          <div className="modal-actions">
            <Button onClick={() => setNewKey(undefined)}>
              I’ve saved the key
            </Button>
          </div>
        </Modal>
      )}
      {deleting && (
        <ConfirmDelete
          name={deleting.name}
          description="Any script using this key will lose access immediately. Create a replacement before revoking it if needed."
          close={() => setDeleting(undefined)}
          onConfirm={async () => {
            await api(`/api-keys/${deleting.id}`, { method: "DELETE" });
            toast("API key revoked");
            keys.reload();
          }}
        />
      )}
    </>
  );
}
