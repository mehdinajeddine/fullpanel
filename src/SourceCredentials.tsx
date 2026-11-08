import { useEffect, useState, type FormEvent } from "react";
import { KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import type { Service, SourceCredentialStatus } from "../shared/types";
import { api, date, useQuery } from "./api";
import { useAccess } from "./Access";
import SshCredentials, { isSshRepository } from "./SshCredentials";
import {
  Badge,
  Button,
  ErrorBox,
  Field,
  Modal,
  Notice,
  Panel,
  useToast,
} from "./ui";
export default function SourceCredentials({
  service,
  sourceSaved,
  updated,
}: {
  service: Service;
  sourceSaved: boolean;
  updated: () => void;
}) {
  const access = useAccess();
  if (!access.canOperate(service.projectId)) return null;
  if (
    service.source.type === "git" &&
    isSshRepository(service.source.repository || "")
  )
    return (
      <SshCredentials
        service={service}
        sourceSaved={sourceSaved}
        updated={updated}
      />
    );
  return (
    <TokenCredentials
      service={service}
      sourceSaved={sourceSaved}
      updated={updated}
    />
  );
}
function TokenCredentials({
  service,
  sourceSaved,
  updated,
}: {
  service: Service;
  sourceSaved: boolean;
  updated: () => void;
}) {
  const access = useAccess();
  const kind = service.source.type === "git" ? "git" : "registry";
  const allowed =
    access.canOperate(service.projectId) &&
    ["git", "image"].includes(service.source.type);
  const query = useQuery<SourceCredentialStatus>(
    `/services/${service.id}/source-credentials`,
    0,
    allowed,
  );
  const status = query.data?.[kind];
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState(false);
  const toast = useToast();
  useEffect(() => {
    if (status?.username)
      setUsername((current) => current || status.username || "");
  }, [
    status?.username,
    status?.updatedAt,
    service.source.repository,
    service.source.image,
  ]);
  if (!allowed) return null;
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!sourceSaved) return;
    setBusy(true);
    setError("");
    try {
      const value = await api<SourceCredentialStatus>(
        `/services/${service.id}/source-credentials/${kind}`,
        {
          method: "PUT",
          body: JSON.stringify(
            kind === "git"
              ? { username, token: secret }
              : { username, password: secret },
          ),
        },
      );
      query.setData(value);
      setSecret("");
      updated();
      toast(
        "Source credential stored. It will be used on the next deployment.",
      );
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
      const value = await api<SourceCredentialStatus>(
        `/services/${service.id}/source-credentials/${kind}`,
        { method: "DELETE" },
      );
      query.setData(value);
      setSecret("");
      setUsername("");
      updated();
      setRevoking(false);
      toast("Source credential removed");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title={kind === "git" ? "Private Git access" : "Private registry access"}
      description={
        kind === "git"
          ? "Use an HTTPS token for this saved repository."
          : "Authenticate when pulling this saved image repository."
      }
      actions={
        status && (
          <Badge status={status.configured ? "configured" : "not configured"} />
        )
      }
    >
      <form className="form-panel" onSubmit={save}>
        <ErrorBox
          message={error || query.error}
          retry={query.error ? query.reload : undefined}
        />
        {!sourceSaved && (
          <Notice>
            Save the source before updating its credential. Credentials are
            scoped to the exact saved repository.
          </Notice>
        )}
        {status?.configured && (
          <div className="credential-status">
            <ShieldCheck size={18} />
            <div>
              <strong>Credential stored for {status.username}</strong>
              <p>
                <code>
                  {kind === "git"
                    ? query.data?.git.repository
                    : query.data?.registry.imageRepository ||
                      query.data?.registry.registry}
                </code>
                {status.updatedAt && (
                  <span>Updated {date(status.updatedAt)}</span>
                )}
              </p>
            </div>
          </div>
        )}
        <fieldset disabled={!sourceSaved || busy} className="plain-fieldset">
          <div className="form-grid">
            <Field
              label={kind === "git" ? "Git username" : "Registry username"}
            >
              <input
                autoComplete="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                maxLength={128}
                placeholder={
                  kind === "git" ? "x-access-token" : "Registry account"
                }
              />
            </Field>
            <Field
              label={
                kind === "git"
                  ? "Git access token"
                  : "Registry password or token"
              }
              hint={
                status?.configured
                  ? "Enter a replacement to rotate the saved credential."
                  : "Stored securely; never returned by the API."
              }
            >
              <input
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                required
                maxLength={16000}
              />
            </Field>
          </div>
        </fieldset>
        <p className="form-note">
          Changing the repository revokes its stored credential. Registry
          credentials apply to pulled images; authenticated base images for
          Dockerfile builds are not supported.
        </p>
        <div className="form-actions">
          <span>
            {status?.configured && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy || !sourceSaved}
                onClick={() => setRevoking(true)}
              >
                <Trash2 size={15} />
                Remove credential
              </Button>
            )}
          </span>
          <Button busy={busy} disabled={!sourceSaved || !username || !secret}>
            <KeyRound size={15} />
            {status?.configured ? "Replace credential" : "Save credential"}
          </Button>
        </div>
      </form>
      {revoking && (
        <Modal
          title="Remove source credential?"
          description="Future deployments will use public access. Existing running containers are not changed."
          close={() => {
            if (!busy) setRevoking(false);
          }}
        >
          <div className="modal-actions">
            <Button
              variant="secondary"
              onClick={() => setRevoking(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void revoke()} busy={busy}>
              Remove credential
            </Button>
          </div>
        </Modal>
      )}
    </Panel>
  );
}
