import { useState, type FormEvent } from "react";
import {
  ArrowDownToLine,
  Eye,
  EyeOff,
  FileInput,
  KeyRound,
  Layers,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import type { Project, Service } from "../shared/types";
import {
  environmentValueError,
  parseEnvironmentText,
} from "../shared/environment";
import { api, patch, newId, useQuery } from "./api";
import { useAccess } from "./Access";
import {
  Button,
  Empty,
  ErrorBox,
  Field,
  IconButton,
  Loading,
  Modal,
  Notice,
  Panel,
  useToast,
} from "./ui";

type Environment = Record<string, string>;
interface VariableRow {
  id: string;
  key: string;
  value: string;
}
interface ResolvedEnvironment {
  inherited: Environment;
  overrides: Environment;
  effective: Environment;
}
const rowsFrom = (env: Environment): VariableRow[] =>
  Object.entries(env).map(([key, value]) => ({ id: newId(), key, value }));
function rowError(rows: VariableRow[]): string {
  const names = rows.map((row) => row.key);
  if (new Set(names).size !== names.length)
    return "Environment variable names must be unique.";
  if (rows.length > 200) return "Keep at most 200 environment variables.";
  for (let index = 0; index < rows.length; index++) {
    const issue = environmentValueError(rows[index].key, rows[index].value);
    if (issue) return `Variable ${index + 1}: ${issue}`;
  }
  return "";
}
function ImportEnvironment({
  existingKeys,
  apply,
  close,
}: {
  existingKeys: string[];
  apply: (env: Environment, mode: "merge" | "replace") => void;
  close: () => void;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] =
    useState<ReturnType<typeof parseEnvironmentText>>();
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [visible, setVisible] = useState(false);
  const entries = preview ? Object.entries(preview.env) : [];
  const conflicts = entries.filter(([key]) =>
    existingKeys.includes(key),
  ).length;
  const resultingCount =
    mode === "replace"
      ? entries.length
      : existingKeys.length +
        entries.filter(([key]) => !existingKeys.includes(key)).length;
  function parse(e: FormEvent) {
    e.preventDefault();
    setPreview(parseEnvironmentText(text));
    setVisible(false);
  }
  return (
    <Modal
      title="Import .env variables"
      description="Parse locally, review the changes, then apply them to your unsaved draft."
      close={close}
      wide
    >
      <form onSubmit={parse}>
        <Field
          label="Paste .env contents"
          hint="Comments, export prefixes, quoted values, and empty values are supported. Variable references remain literal; no commands are executed."
        >
          <textarea
            className="code-editor env-import-text"
            autoFocus
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(undefined);
            }}
            spellCheck={false}
            rows={8}
            maxLength={262144}
            placeholder={
              'APP_ENV=production\nPUBLIC_URL="https://app.example.com"\n# Add your variables here'
            }
          />
        </Field>
        <div className="env-import-parse">
          <span className="form-note">
            Contents stay in this browser until you save the variables.
          </span>
          <Button variant="secondary" disabled={!text.trim()}>
            <FileInput size={15} />
            Preview import
          </Button>
        </div>
      </form>
      {preview && (
        <div className="env-import-preview">
          {preview.errors.length ? (
            <div className="import-errors" role="alert">
              <strong>Resolve these errors before importing.</strong>
              <ul>
                {preview.errors.map((error, index) => (
                  <li key={index}>
                    {error.line ? `Line ${error.line}: ` : ""}
                    {error.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <div className="editor-toolbar">
                <span className="count-label">
                  {entries.length} variables · {conflicts} existing{" "}
                  {conflicts === 1 ? "key" : "keys"}
                </span>
                <Button variant="ghost" onClick={() => setVisible(!visible)}>
                  {visible ? <EyeOff size={15} /> : <Eye size={15} />}{" "}
                  {visible ? "Hide preview values" : "Reveal preview values"}
                </Button>
              </div>
              <div className="env-preview-list">
                {entries.map(([key, value]) => (
                  <div key={key}>
                    <code>{key}</code>
                    <span className="mono">
                      {visible ? value || "(empty)" : "••••••••"}
                    </span>
                    {existingKeys.includes(key) && (
                      <small>replaces draft value</small>
                    )}
                  </div>
                ))}
                {!entries.length && (
                  <p className="form-note">No variables found in this text.</p>
                )}
              </div>
              <Field label="Import behavior">
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as typeof mode)}
                >
                  <option value="merge">
                    Merge — update matching keys and keep the rest
                  </option>
                  <option value="replace">
                    Replace — use only the imported variables
                  </option>
                </select>
              </Field>
              {resultingCount > 200 && (
                <ErrorBox message="This import would exceed the limit of 200 variables. Use Replace or reduce the imported keys." />
              )}
              {mode === "replace" && (
                <Notice>
                  Applying this import removes every existing draft variable not
                  present in the imported text. Nothing is saved until you
                  select Save.
                </Notice>
              )}
            </>
          )}
        </div>
      )}
      <div className="modal-actions">
        <Button variant="secondary" onClick={close}>
          Cancel
        </Button>
        <Button
          disabled={
            !preview ||
            preview.errors.length > 0 ||
            !entries.length ||
            resultingCount > 200
          }
          onClick={() => {
            if (preview && !preview.errors.length) {
              apply(preview.env, mode);
              close();
            }
          }}
        >
          <ArrowDownToLine size={15} />
          Apply to draft
        </Button>
      </div>
    </Modal>
  );
}
function VariableRows({
  rows,
  setRows,
  visible,
}: {
  rows: VariableRow[];
  setRows: React.Dispatch<React.SetStateAction<VariableRow[]>>;
  visible: boolean;
}) {
  return rows.length ? (
    <div className="env-table">
      <div className="env-table-head">
        <span>KEY</span>
        <span>VALUE</span>
        <span />
      </div>
      {rows.map((row, index) => (
        <div className="env-row" key={row.id}>
          <input
            aria-label={`Variable ${index + 1} name`}
            value={row.key}
            onChange={(e) =>
              setRows((old) =>
                old.map((r) =>
                  r.id === row.id ? { ...r, key: e.target.value } : r,
                ),
              )
            }
            className="mono"
            placeholder="VARIABLE_NAME"
            pattern="[a-zA-Z_][a-zA-Z0-9_]*"
            required
            autoComplete="off"
          />
          <input
            aria-label={`Variable ${index + 1} value`}
            type={visible ? "text" : "password"}
            value={row.value}
            onChange={(e) =>
              setRows((old) =>
                old.map((r) =>
                  r.id === row.id ? { ...r, value: e.target.value } : r,
                ),
              )
            }
            className="mono"
            placeholder="value"
            autoComplete="new-password"
            maxLength={16000}
          />
          <IconButton
            label={`Remove variable ${row.key || index + 1}`}
            onClick={() => setRows((old) => old.filter((r) => r.id !== row.id))}
          >
            <Trash2 size={16} />
          </IconButton>
        </div>
      ))}
    </div>
  ) : (
    <div className="inline-empty">No variables configured here yet.</div>
  );
}
function EnvironmentForm({
  initial,
  inherited = {},
  scope,
  service,
  onSave,
  refreshInherited,
}: {
  initial: Environment;
  inherited?: Environment;
  scope: "project" | "service";
  service?: Service;
  project?: Project;
  onSave: (env: Environment) => Promise<void>;
  refreshInherited?: () => void;
}) {
  const [rows, setRows] = useState(() => rowsFrom(initial));
  const [visible, setVisible] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const inheritedRows = Object.entries(inherited);
  const inheritedOverrides = inheritedRows.filter(([key]) =>
    rows.some((row) => row.key === key),
  );
  async function save(e: FormEvent) {
    e.preventDefault();
    const invalid = rowError(rows);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave(Object.fromEntries(rows.map((row) => [row.key, row.value])));
      toast(
        scope === "project"
          ? "Project variables saved. Redeploy affected services to apply them."
          : "Configuration saved. Deploy to apply runtime changes.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function apply(env: Environment, mode: "merge" | "replace") {
    setRows((old) =>
      mode === "replace"
        ? rowsFrom(env)
        : [
            ...old.map((row) =>
              Object.hasOwn(env, row.key)
                ? { ...row, value: env[row.key] }
                : row,
            ),
            ...rowsFrom(
              Object.fromEntries(
                Object.entries(env).filter(
                  ([key]) => !old.some((row) => row.key === key),
                ),
              ),
            ),
          ],
    );
    setError("");
    toast("Variables added to the draft. Save to persist them.");
  }
  return (
    <>
      <Panel
        title={
          scope === "project" ? "Project environment" : "Environment variables"
        }
        description={
          scope === "project"
            ? "Shared configuration inherited by services in this project."
            : "Service values override inherited project values with the same name."
        }
      >
        <form className="form-panel" onSubmit={save}>
          <ErrorBox message={error} />
          {scope === "project" ? (
            <Notice>
              Saving these variables marks this project’s services as having
              configuration changes. Redeploy each affected service to apply the
              values. Existing service overrides take precedence.
            </Notice>
          ) : service && !["app", "compose"].includes(service.kind) ? (
            <Notice>
              Database credentials initialize a new data volume. Changing them
              here does not rotate credentials in an existing database; update
              the database user first.
            </Notice>
          ) : null}
          {service?.kind === "compose" && (
            <Notice>
              For Compose workloads, service overrides take precedence. Explicit
              container values in the Compose file override project defaults.
            </Notice>
          )}
          <div className="editor-toolbar">
            <span className="count-label">
              {rows.length}{" "}
              {scope === "project" ? "shared variables" : "service overrides"}
            </span>
            <div className="environment-tools">
              <Button
                variant="ghost"
                type="button"
                onClick={() => setImporting(true)}
              >
                <FileInput size={15} />
                Import .env
              </Button>
              <Button
                variant="ghost"
                type="button"
                onClick={() => setVisible(!visible)}
              >
                {visible ? <EyeOff size={16} /> : <Eye size={16} />}{" "}
                {visible ? "Hide values" : "Show values"}
              </Button>
            </div>
          </div>
          <VariableRows rows={rows} setRows={setRows} visible={visible} />
          <Button
            variant="secondary"
            type="button"
            disabled={rows.length >= 200}
            onClick={() =>
              setRows((old) => [...old, { id: newId(), key: "", value: "" }])
            }
          >
            <Plus size={16} />
            Add variable
          </Button>
          {scope === "service" && (
            <p className="form-note override-hint">
              Removing a service override restores the inherited project value
              on the next deployment.
            </p>
          )}
          <div className="form-actions">
            <span className="form-note">
              {scope === "project"
                ? "Services keep running with their current environment until redeployed."
                : "Save first, then deploy to apply."}
            </span>
            <Button busy={busy}>
              <Save size={16} />
              {scope === "project" ? "Save project variables" : "Save changes"}
            </Button>
          </div>
        </form>
      </Panel>
      {scope === "service" && (
        <Panel
          title="Inherited from project"
          description={`${inheritedRows.length} shared variables · ${inheritedOverrides.length} overridden in this draft`}
          actions={
            refreshInherited && (
              <Button variant="ghost" onClick={refreshInherited}>
                <RefreshCw size={14} />
                Refresh inherited
              </Button>
            )
          }
        >
          {inheritedRows.length ? (
            <div className="inherited-variables">
              {inheritedRows.map(([key, value]) => {
                const overridden = rows.some((row) => row.key === key);
                return (
                  <div className="inherited-variable-row" key={key}>
                    <div>
                      <code>{key}</code>
                      <span
                        className={`inheritance-label ${overridden ? "is-overridden" : ""}`}
                      >
                        {overridden ? "Overridden" : "Inherited"}
                      </span>
                    </div>
                    <input
                      readOnly
                      value={value}
                      type={visible ? "text" : "password"}
                      aria-label={`Inherited ${key} value`}
                      autoComplete="off"
                      className="mono"
                    />
                    {!overridden ? (
                      <Button
                        variant="ghost"
                        aria-label={`Override ${key}`}
                        disabled={rows.length >= 200}
                        onClick={() =>
                          setRows((old) => [
                            ...old,
                            { id: newId(), key, value },
                          ])
                        }
                      >
                        <Plus size={14} />
                        Override
                      </Button>
                    ) : (
                      <span className="inheritance-edit-note">
                        Using the service value
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="quiet-state">
              <Layers size={23} />
              <p>This project does not define any shared variables.</p>
            </div>
          )}
          <div className="inherited-footer">
            <p className="form-note">
              Project values stay read-only here. Manage shared values in the
              project’s Environment tab.
            </p>
            <a
              href={`#/projects/${service?.projectId}/environment`}
              className="text-link"
            >
              Manage project variables
              <ArrowDownToLine size={14} />
            </a>
          </div>
        </Panel>
      )}
      {importing && (
        <ImportEnvironment
          existingKeys={rows.map((row) => row.key)}
          apply={apply}
          close={() => setImporting(false)}
        />
      )}
    </>
  );
}
export function ProjectEnvironment({ project }: { project: Project }) {
  const access = useAccess();
  const allowed = access.canOperate(project.id);
  const q = useQuery<{ env: Environment }>(
    `/projects/${project.id}/environment`,
    0,
    allowed,
  );
  if (!allowed)
    return (
      <Empty
        icon={<KeyRound size={26} />}
        title="Operator access required"
        description="Project variables may contain secrets and are available only to operators."
      />
    );
  if (q.loading) return <Loading label="Loading project variables" />;
  if (!q.data) return <ErrorBox message={q.error} retry={q.reload} />;
  return (
    <>
      <ErrorBox message={q.error} retry={q.error ? q.reload : undefined} />
      <EnvironmentForm
        key={project.id}
        scope="project"
        project={project}
        initial={q.data.env}
        onSave={async (env) => {
          const result = await api<{ env: Environment }>(
            `/projects/${project.id}/environment`,
            { method: "PUT", body: JSON.stringify({ env }) },
          );
          q.setData(result);
        }}
      />
    </>
  );
}
export function ServiceEnvironment({
  service,
  updated,
}: {
  service: Service;
  updated: () => void;
}) {
  const access = useAccess();
  const allowed = access.canOperate(service.projectId);
  const q = useQuery<ResolvedEnvironment>(
    `/services/${service.id}/environment`,
    0,
    allowed,
  );
  if (!allowed)
    return (
      <Empty
        icon={<KeyRound size={26} />}
        title="Operator access required"
        description="Environment values are available only to operators."
      />
    );
  if (q.loading) return <Loading label="Resolving environment variables" />;
  if (!q.data) return <ErrorBox message={q.error} retry={q.reload} />;
  return (
    <>
      <ErrorBox message={q.error} retry={q.error ? q.reload : undefined} />
      <EnvironmentForm
        key={service.id}
        scope="service"
        service={service}
        initial={q.data.overrides}
        inherited={q.data.inherited}
        refreshInherited={q.reload}
        onSave={async (env) => {
          await patch(`/services/${service.id}`, { env });
          updated();
          q.reload();
        }}
      />
    </>
  );
}
