import { useState } from "react";
import { KeyRound, X } from "lucide-react";
import { api, post, useQuery } from "./api";
import {
  Badge,
  Button,
  CopyButton,
  ErrorBox,
  Field,
  Modal,
  Notice,
  Panel,
  useToast,
} from "./ui";
interface TriggerStatus {
  enabled: boolean;
  endpoint: string;
  method: "POST";
  authorization: "Bearer";
  tokenVisibleOnce: true;
}
export default function DeploymentTrigger({
  serviceId,
}: {
  serviceId: string;
}) {
  const query = useQuery<TriggerStatus>(`/services/${serviceId}/trigger`);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"rotate" | "revoke">();
  const toast = useToast();
  const endpoint = query.data
    ? new URL(query.data.endpoint, window.location.origin).href
    : "";
  async function rotate() {
    setBusy(true);
    try {
      const result = await post<TriggerStatus & { token: string }>(
        `/services/${serviceId}/trigger/rotate`,
      );
      setToken(result.token);
      query.setData(result);
      toast("Deployment token generated. Save it now; it is shown once.");
      setConfirm(undefined);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    setBusy(true);
    try {
      const result = await api<TriggerStatus>(
        `/services/${serviceId}/trigger`,
        { method: "DELETE" },
      );
      query.setData(result);
      setToken("");
      toast("Deployment token revoked");
      setConfirm(undefined);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel
      title="CI deployment trigger"
      description="Use a Bearer token from your own CI job or trusted automation."
      actions={
        query.data && (
          <Badge status={query.data.enabled ? "enabled" : "disabled"} />
        )
      }
    >
      <div className="form-panel">
        <ErrorBox message={query.error} retry={query.reload} />
        {query.data && (
          <>
            <p className="form-note trigger-description">
              Send a POST request to this endpoint with an Authorization: Bearer
              token header. This credential can deploy only this service.
              Native GitHub webhooks use the separate signed endpoint in Source.
            </p>
            <Field label="Trigger endpoint">
              <div className="copy-field">
                <input readOnly value={endpoint} className="mono" />
                <CopyButton value={endpoint} />
              </div>
            </Field>
            {token && (
              <div className="new-token">
                <Notice>
                  This token is visible only now. Copy it to your CI secret
                  store before leaving this page.
                </Notice>
                <Field label="New deployment token">
                  <div className="copy-field">
                    <input readOnly value={token} className="mono" />
                    <CopyButton value={token} label="Copy token" />
                  </div>
                </Field>
              </div>
            )}
            <Field label="Example request">
              <pre className="request-example">{`curl --request POST '${endpoint}' \\\n  --header 'Authorization: Bearer YOUR_DEPLOYMENT_TOKEN'`}</pre>
            </Field>
            <div className="trigger-actions">
              <Button
                variant="secondary"
                busy={busy}
                onClick={() =>
                  query.data?.enabled ? setConfirm("rotate") : void rotate()
                }
              >
                <KeyRound size={15} />
                {query.data.enabled ? "Rotate token" : "Generate token"}
              </Button>
              {query.data.enabled && (
                <Button
                  variant="ghost"
                  onClick={() => setConfirm("revoke")}
                  disabled={busy}
                >
                  <X size={15} />
                  Revoke token
                </Button>
              )}
            </div>
          </>
        )}
        {confirm && (
          <Modal
            title={
              confirm === "rotate"
                ? "Rotate deployment token?"
                : "Revoke deployment token?"
            }
            description={
              confirm === "rotate"
                ? "The current token will stop working immediately. Update every integration with the new token."
                : "Existing CI jobs and integrations will no longer be able to deploy this service with this token."
            }
            close={() => {
              if (!busy) setConfirm(undefined);
            }}
          >
            <div className="modal-actions">
              <Button
                variant="secondary"
                onClick={() => setConfirm(undefined)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant={confirm === "revoke" ? "danger" : "primary"}
                busy={busy}
                onClick={() =>
                  void (confirm === "rotate" ? rotate() : revoke())
                }
              >
                {confirm === "rotate" ? "Rotate token" : "Revoke token"}
              </Button>
            </div>
          </Modal>
        )}
      </div>
    </Panel>
  );
}
