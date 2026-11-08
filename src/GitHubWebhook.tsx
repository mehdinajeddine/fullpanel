import { useState } from "react";
import {
  ArrowUpRight,
  GitBranch,
  Github,
  KeyRound,
  ShieldCheck,
  X,
} from "lucide-react";
import type { GitHubWebhookStatus, Service } from "../shared/types";
import { api, date, post, useQuery } from "./api";
import {
  Badge,
  Button,
  CopyButton,
  ErrorBox,
  Field,
  Loading,
  Modal,
  Notice,
  Panel,
  useToast,
} from "./ui";

export default function GitHubWebhook({
  service,
  sourceSaved,
}: {
  service: Service;
  sourceSaved: boolean;
}) {
  const query = useQuery<GitHubWebhookStatus>(
    `/services/${service.id}/github-webhook`,
    5000,
  );
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<"rotate" | "revoke">();
  const toast = useToast();
  const status = query.data;
  const endpoint = status
    ? new URL(status.endpoint, window.location.origin).href
    : "";

  async function change(action: "rotate" | "revoke") {
    setBusy(true);
    setError("");
    try {
      if (action === "rotate") {
        const { secret: generated, ...metadata } = await post<
          GitHubWebhookStatus & { secret: string }
        >(`/services/${service.id}/github-webhook/rotate`);
        setSecret(generated);
        query.setData(metadata);
        toast("GitHub secret generated. Save it in your repository webhook.");
      } else {
        query.setData(
          await api<GitHubWebhookStatus>(
            `/services/${service.id}/github-webhook`,
            { method: "DELETE" },
          ),
        );
        setSecret("");
        toast("GitHub webhook revoked");
      }
      setConfirm(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="GitHub auto-deploy"
      description="Deploy this branch when GitHub sends a verified push event."
      actions={
        status && <Badge status={status.enabled ? "enabled" : "disabled"} />
      }
    >
      <div className="form-panel github-webhook">
        <ErrorBox
          message={query.error || (!confirm ? error : "")}
          retry={query.error ? query.reload : undefined}
        />
        {query.loading ? (
          <Loading label="Loading GitHub webhook" />
        ) : (
          status && (
            <>
              {!sourceSaved && (
                <Notice>
                  Save the repository and branch above before generating a
                  webhook secret. This panel refers to the saved source.
                </Notice>
              )}
              {!status.supported ? (
                <Notice>
                  {status.reason ||
                    "Use a GitHub.com HTTPS Git repository in Docker mode to configure a native webhook."}
                </Notice>
              ) : (
                <>
                  <div className="integration-identity">
                    <span className="integration-symbol">
                      <Github size={23} />
                    </span>
                    <div>
                      <strong>{status.repository}</strong>
                      <span>
                        <GitBranch size={13} />
                        {status.branch || "main"}
                      </span>
                    </div>
                    <ShieldCheck
                      size={19}
                      aria-label="Signed GitHub deliveries"
                    />
                  </div>
                  {status.reason && <Notice>{status.reason}</Notice>}
                  <Field
                    label="GitHub payload URL"
                    hint="Use this server’s public address. GitHub must be able to reach the endpoint."
                  >
                    <div className="copy-field">
                      <input readOnly value={endpoint} className="mono" />
                      <CopyButton
                        value={endpoint}
                        label="Copy URL"
                        ariaLabel="Copy GitHub payload URL"
                      />
                    </div>
                  </Field>
                  {secret && (
                    <div className="new-token github-new-secret">
                      <Notice>
                        This secret is visible only now. Save it in GitHub
                        before leaving this page. Generating a new secret
                        invalidates the previous one immediately.
                      </Notice>
                      <Field label="New GitHub webhook secret">
                        <div className="copy-field">
                          <input
                            readOnly
                            value={secret}
                            className="mono"
                            autoComplete="off"
                          />
                          <CopyButton
                            value={secret}
                            label="Copy secret"
                            ariaLabel="Copy GitHub webhook secret"
                          />
                        </div>
                      </Field>
                      <Button variant="ghost" onClick={() => setSecret("")}>
                        I’ve saved the GitHub secret
                      </Button>
                    </div>
                  )}
                  <div className="webhook-instructions">
                    <h3>Connect your repository</h3>
                    <ol>
                      <li>
                        Open your repository’s{" "}
                        <strong>Settings → Webhooks</strong> and add or edit a
                        webhook.
                      </li>
                      <li>
                        Set <strong>Payload URL</strong> to the address above
                        and <strong>Content type</strong> to{" "}
                        <code>application/json</code>.
                      </li>
                      <li>
                        Paste the generated value into <strong>Secret</strong>,
                        select <strong>Just the push event</strong>, and keep
                        the webhook active.
                      </li>
                    </ol>
                    <p>
                      Only pushes for the saved repository and branch can deploy
                      this service. Changing either revokes this configuration
                      until you generate a new secret.
                    </p>
                  </div>
                  {status.lastDelivery && (
                    <div className="webhook-delivery">
                      <div>
                        <strong>Last accepted push</strong>
                        <small>{date(status.lastDelivery.receivedAt)}</small>
                      </div>
                      <a
                        className="text-link"
                        href={`#/deployments/${status.lastDelivery.deploymentId}`}
                      >
                        View deployment
                        <ArrowUpRight size={14} />
                      </a>
                    </div>
                  )}
                  <div className="trigger-actions">
                    <Button
                      variant="secondary"
                      busy={busy}
                      disabled={!sourceSaved}
                      onClick={() =>
                        status.configured
                          ? setConfirm("rotate")
                          : void change("rotate")
                      }
                    >
                      <KeyRound size={15} />
                      {status.configured
                        ? "Rotate GitHub secret"
                        : "Generate GitHub secret"}
                    </Button>
                    {status.configured && (
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setConfirm("revoke")}
                      >
                        <X size={15} />
                        Revoke GitHub webhook
                      </Button>
                    )}
                  </div>
                </>
              )}
            </>
          )
        )}
      </div>
      {confirm && (
        <Modal
          title={
            confirm === "rotate"
              ? "Rotate GitHub secret?"
              : "Revoke GitHub webhook?"
          }
          description={
            confirm === "rotate"
              ? "The previous secret stops working immediately. Update the Secret field in GitHub with the new value."
              : "GitHub deliveries will no longer deploy this service. Remove or disable the webhook in GitHub too."
          }
          close={() => {
            if (!busy) {
              setConfirm(undefined);
              setError("");
            }
          }}
        >
          <ErrorBox message={error} />
          <div className="modal-actions">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setConfirm(undefined);
                setError("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant={confirm === "revoke" ? "danger" : "primary"}
              busy={busy}
              onClick={() => void change(confirm)}
            >
              {confirm === "rotate"
                ? "Rotate GitHub secret"
                : "Revoke GitHub webhook"}
            </Button>
          </div>
        </Modal>
      )}
    </Panel>
  );
}
