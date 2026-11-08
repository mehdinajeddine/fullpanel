import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Globe2,
  LockKeyhole,
  Plus,
  Save,
  ShieldCheck,
  Star,
  Trash2,
} from "lucide-react";
import type { Domain, Service } from "../shared/types";
import { api, newId, patch, useQuery } from "./api";
import { useAccess } from "./Access";
import {
  Badge,
  Button,
  ErrorBox,
  Field,
  IconButton,
  Modal,
  Notice,
  Panel,
  useToast,
} from "./ui";
export type RoutingDomain = Domain;
interface DomainAuthStatus {
  enabled: boolean;
  username?: string;
}
function sameRoute(a: RoutingDomain, b?: RoutingDomain) {
  return (
    !!b &&
    a.hostname === b.hostname &&
    a.port === b.port &&
    a.path === b.path &&
    a.https === b.https &&
    !!a.primary === !!b.primary &&
    (a.upstreamScheme || "http") === (b.upstreamScheme || "http") &&
    !!a.stripPrefix === !!b.stripPrefix &&
    !!a.redirectToHttps === !!b.redirectToHttps
  );
}
function DomainAuthentication({
  serviceId,
  domain,
  saved,
  updated,
}: {
  serviceId: string;
  domain: RoutingDomain;
  saved?: RoutingDomain;
  updated: () => void;
}) {
  const q = useQuery<DomainAuthStatus>(
    `/services/${serviceId}/domains/${domain.id}/auth`,
    0,
    !!saved,
  );
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState(false);
  const toast = useToast();
  const ready = sameRoute(domain, saved);
  useEffect(() => {
    if (q.data?.username)
      setUsername((current) => current || q.data?.username || "");
  }, [q.data?.username, q.data?.enabled]);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    if (
      new TextEncoder().encode(password).length > 72 ||
      password.includes("\0")
    ) {
      setError("Use 12–72 UTF-8 bytes without null characters.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api<DomainAuthStatus>(
        `/services/${serviceId}/domains/${domain.id}/auth`,
        { method: "PUT", body: JSON.stringify({ username, password }) },
      );
      q.setData(result);
      setPassword("");
      toast("Password protection saved. Deploy to apply it.");
      updated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    setBusy(true);
    setError("");
    try {
      const result = await api<DomainAuthStatus>(
        `/services/${serviceId}/domains/${domain.id}/auth`,
        { method: "DELETE" },
      );
      q.setData(result);
      setPassword("");
      setUsername("");
      setRevoking(false);
      toast("Password protection removed. Deploy to apply it.");
      updated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="domain-auth">
      <div className="domain-auth-heading">
        <h4>
          <LockKeyhole size={15} />
          Password protection
        </h4>
        {q.data && <Badge status={q.data.enabled ? "enabled" : "disabled"} />}
      </div>
      {!ready && (
        <p className="form-note">
          Save this route before changing its password protection.
        </p>
      )}
      <ErrorBox
        message={error || q.error}
        retry={q.error ? q.reload : undefined}
      />
      {!domain.https && (
        <p className="form-note">
          HTTP Basic authentication sends credentials with each request. Enable
          HTTPS before using real credentials.
        </p>
      )}
      <form onSubmit={save}>
        <fieldset className="plain-fieldset" disabled={!ready || busy}>
          <div className="form-grid">
            <Field label={`Username for ${domain.hostname || "domain"}`}>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                required
                maxLength={64}
              />
            </Field>
            <Field
              label={`Password for ${domain.hostname || "domain"}`}
              hint={
                q.data?.enabled
                  ? "Enter a new password to replace the current one."
                  : "12–72 UTF-8 bytes. Stored as a hash; never displayed again."
              }
            >
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={72}
              />
            </Field>
          </div>
        </fieldset>
        <div className="domain-auth-actions">
          {q.data?.enabled && (
            <Button
              type="button"
              variant="ghost"
              disabled={!ready || busy}
              onClick={() => setRevoking(true)}
            >
              <Trash2 size={14} />
              Remove protection
            </Button>
          )}
          <Button
            variant="secondary"
            busy={busy}
            disabled={!ready || !username || !password}
          >
            <ShieldCheck size={14} />
            {q.data?.enabled ? "Replace password" : "Protect domain"}
          </Button>
        </div>
      </form>
      {revoking && (
        <Modal
          title="Remove password protection?"
          description="After the next deployment, this domain will no longer require these credentials."
          close={() => {
            if (!busy) setRevoking(false);
          }}
        >
          <div className="modal-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setRevoking(false)}
            >
              Cancel
            </Button>
            <Button variant="danger" busy={busy} onClick={() => void revoke()}>
              Remove protection
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
export default function DomainsEditor({
  service,
  updated,
}: {
  service: Service;
  updated: () => void;
}) {
  const access = useAccess();
  const canEdit = access.canOperate(service.projectId);
  const [domains, setDomains] = useState<RoutingDomain[]>(
    service.domains.map((d) => ({ ...d })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  useEffect(() => {
    if (!canEdit) setDomains(service.domains.map((domain) => ({ ...domain })));
  }, [canEdit, service.domains]);
  const update = (id: string, values: Partial<RoutingDomain>) =>
    setDomains((old) =>
      old.map((d) =>
        d.id === id
          ? { ...d, ...values }
          : values.primary
            ? { ...d, primary: false }
            : d,
      ),
    );
  function hostname(id: string, value: string) {
    const wildcard = value.startsWith("*.");
    update(id, {
      hostname: value,
      ...(wildcard
        ? { https: false, redirectToHttps: false, primary: false }
        : {}),
    });
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canEdit) return;
    setBusy(true);
    setError("");
    try {
      const result = await patch<Service>(`/services/${service.id}`, {
        domains,
      });
      setDomains(result.domains.map((d) => ({ ...d })));
      updated();
      toast("Configuration saved. Deploy to apply runtime changes.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title="Domains & routing"
      description="Route HTTP traffic through your configured proxy."
    >
      <div className="form-panel">
        <ErrorBox message={error} />
        {canEdit && (
          <Notice>
            Point DNS to this server and enable the Traefik proxy. Save
            configuration first, then deploy to apply routing and password
            protection.
          </Notice>
        )}
        <form id={`domain-routes-${service.id}`} onSubmit={save} />
        {domains.map((domain, i) => {
          const wildcard = domain.hostname.startsWith("*.");
          const saved = service.domains.find((d) => d.id === domain.id);
          return (
            <section className="config-card domain-route" key={domain.id}>
              <div className="config-card-heading">
                <strong>
                  <Globe2 size={16} />
                  Domain {i + 1}
                  {domain.primary && (
                    <span className="primary-route-label">
                      <Star size={11} />
                      Primary
                    </span>
                  )}
                </strong>
                {canEdit && (
                  <IconButton
                    label={`Remove domain ${i + 1}`}
                    onClick={() =>
                      setDomains((old) => old.filter((d) => d.id !== domain.id))
                    }
                  >
                    <Trash2 size={16} />
                  </IconButton>
                )}
              </div>
              <fieldset className="plain-fieldset" disabled={!canEdit || busy}>
                <Field label={`Hostname ${i + 1}`}>
                  <input
                    form={`domain-routes-${service.id}`}
                    value={domain.hostname}
                    onChange={(e) => hostname(domain.id, e.target.value)}
                    placeholder="app.example.com"
                    required
                    maxLength={253}
                  />
                </Field>
                <div className="form-grid">
                  <Field label={`Target port ${i + 1}`}>
                    <input
                      form={`domain-routes-${service.id}`}
                      type="number"
                      min={1}
                      max={65535}
                      value={domain.port}
                      onChange={(e) =>
                        update(domain.id, { port: Number(e.target.value) })
                      }
                      required
                    />
                  </Field>
                  <Field label={`Path ${i + 1}`}>
                    <input
                      form={`domain-routes-${service.id}`}
                      value={domain.path}
                      onChange={(e) =>
                        update(domain.id, {
                          path: e.target.value,
                          ...(e.target.value === "/"
                            ? { stripPrefix: false }
                            : {}),
                        })
                      }
                      placeholder="/"
                      pattern="/.*"
                      required
                    />
                  </Field>
                </div>
                <div className="routing-toggles">
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={domain.https}
                      disabled={wildcard}
                      onChange={(e) =>
                        update(domain.id, {
                          https: e.target.checked,
                          ...(!e.target.checked
                            ? { redirectToHttps: false }
                            : {}),
                        })
                      }
                    />
                    <span>Enable HTTPS with automatic certificates</span>
                  </label>
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={!!domain.primary}
                      disabled={wildcard}
                      onChange={(e) =>
                        update(domain.id, { primary: e.target.checked })
                      }
                    />
                    <span>Use as the primary domain</span>
                  </label>
                </div>
                {wildcard && (
                  <p className="form-note wildcard-note">
                    Wildcard routes use HTTP with the bundled proxy. A wildcard
                    cannot be the primary domain.
                  </p>
                )}
                <details className="routing-advanced">
                  <summary>Advanced routing</summary>
                  <div className="routing-advanced-content">
                    <Field
                      label={`Upstream protocol ${i + 1}`}
                      hint="HTTPS verifies the upstream certificate. Invalid or self-signed certificates are rejected."
                    >
                      <select
                        value={domain.upstreamScheme || "http"}
                        onChange={(e) =>
                          update(domain.id, {
                            upstreamScheme: e.target.value as "http" | "https",
                          })
                        }
                      >
                        <option value="http">HTTP</option>
                        <option value="https">HTTPS</option>
                      </select>
                    </Field>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={!!domain.stripPrefix}
                        disabled={domain.path === "/"}
                        onChange={(e) =>
                          update(domain.id, { stripPrefix: e.target.checked })
                        }
                      />
                      <span>Strip the configured path before forwarding</span>
                    </label>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={!!domain.redirectToHttps}
                        disabled={!domain.https}
                        onChange={(e) =>
                          update(domain.id, {
                            redirectToHttps: e.target.checked,
                          })
                        }
                      />
                      <span>Redirect HTTP requests to HTTPS</span>
                    </label>
                  </div>
                </details>
              </fieldset>
              {canEdit && (
                <DomainAuthentication
                  serviceId={service.id}
                  domain={domain}
                  saved={saved}
                  updated={updated}
                />
              )}
            </section>
          );
        })}
        {!domains.length && (
          <div className="inline-empty">
            No domains configured. This service is available inside its project
            network.
          </div>
        )}
        {canEdit && (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={domains.length >= 20}
              onClick={() =>
                setDomains((old) => [
                  ...old,
                  {
                    id: newId(),
                    hostname: "",
                    port: 80,
                    path: "/",
                    https: true,
                    primary: old.length === 0,
                    upstreamScheme: "http",
                    stripPrefix: false,
                    redirectToHttps: false,
                  },
                ])
              }
            >
              <Plus size={16} />
              Add domain
            </Button>
            <div className="form-actions">
              <span className="form-note">
                Saved changes take effect on the next deployment.
              </span>
              <Button form={`domain-routes-${service.id}`} busy={busy}>
                <Save size={16} />
                Save changes
              </Button>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}

export function DomainLink({ domain }: { domain: RoutingDomain }) {
  const children = (
    <>
      <Globe2 size={17} />
      <span>
        {domain.hostname}
        {domain.path !== "/" ? domain.path : ""}
        <small>
          {domain.https ? "HTTPS" : "HTTP"} · port {domain.port}
          {domain.primary ? " · Primary" : ""}
        </small>
      </span>
      {!domain.hostname.startsWith("*.") && <ArrowUpRight size={16} />}
    </>
  );
  return domain.hostname.startsWith("*.") ? (
    <div className="domain-link-item">{children}</div>
  ) : (
    <a
      href={`${domain.https ? "https" : "http"}://${domain.hostname}${domain.path || "/"}`}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}
