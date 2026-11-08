import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  KeyRound,
  Info,
  RefreshCw,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { Service, SourceCredentialStatus } from "../shared/types";
import { api, date, useQuery } from "./api";
import { useAccess } from "./Access";
import { githubHostKeyCheckedAt, githubHostKeySource } from "./github-host-key";
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
  SetupProgress,
  useToast,
} from "./ui";

export const isSshRepository = (repository: string) =>
  /^ssh:\/\//i.test(repository.trim()) ||
  /^[^@\s/]+@[^/]+:/.test(repository.trim());
function hostEntry(repository: string) {
  try {
    if (repository.startsWith("ssh://")) {
      const url = new URL(repository);
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      return url.port && url.port !== "22"
        ? `[${hostname}]:${url.port}`
        : hostname;
    }
    return (
      repository
        .match(/^[^@\s]+@(\[[^\]]+\]|[^:\s]+):/)?.[1]
        .replace(/^\[|\]$/g, "") || "your-git-host"
    );
  } catch {
    return "your-git-host";
  }
}
const githubKeys =
  "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints";
const gitlabKeys =
  "https://docs.gitlab.com/user/gitlab_com/#ssh-host-keys-fingerprints";

export default function SshCredentials({
  service,
  sourceSaved,
  updated,
}: {
  service: Service;
  sourceSaved: boolean;
  updated: () => void;
}) {
  const access = useAccess();
  const allowed = access.canOperate(service.projectId);
  const query = useQuery<SourceCredentialStatus>(
    `/services/${service.id}/source-credentials`,
    0,
    allowed,
  );
  const status = query.data?.ssh;
  const [knownHosts, setKnownHosts] = useState("");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [errorLocation, setErrorLocation] = useState("");
  const [dialog, setDialog] = useState<
    "rotate" | "revoke" | "host" | undefined
  >();
  const toast = useToast();
  const expectedHost = hostEntry(service.source.repository || "");
  const isGithubHost = expectedHost === "github.com";
  const automaticGithub = isGithubHost && (!status?.configured || status.hostKeySource === "github-published");
  const canChange = sourceSaved && !busy && !!status;
  const hostChanged = knownHosts.trim() !== (status?.knownHosts || "").trim();
  useEffect(() => {
    setKnownHosts(query.data?.ssh?.knownHosts || "");
    setVerified(false);
  }, [query.data?.ssh?.knownHosts]);

  async function mutate(action: "generate" | "rotate" | "host" | "revoke") {
    if (
      !sourceSaved ||
      !allowed ||
      busy ||
      (action === "host" && (!verified || !hostChanged))
    )
      return;
    setBusy(action);
    setError("");
    const savingHost = action === "host";
    setErrorLocation(savingHost ? "host" : action);
    try {
      const value = await api<SourceCredentialStatus>(
        `/services/${service.id}/source-credentials/ssh${savingHost ? "/host-key" : action === "revoke" ? "" : "/rotate"}`,
        {
          method:
            action === "revoke" ? "DELETE" : savingHost ? "PUT" : "POST",
          ...(action !== "revoke"
            ? { body: JSON.stringify(savingHost ? { knownHosts } : {}) }
            : {}),
        },
      );
      query.setData(value);
      setDialog(undefined);
      if (savingHost || action === "revoke") {
        setKnownHosts(value.ssh.knownHosts || "");
        setVerified(false);
      }
      updated();
      toast(
        action === "revoke"
          ? "SSH access removed from this service"
          : savingHost
            ? "Trusted server keys saved. They will be checked on the next deployment."
            : "SSH deploy key generated. Add its public key to your repository.",
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  }
  function saveHost(event: FormEvent) {
    event.preventDefault();
    if (!canChange || !verified || !hostChanged) return;
    setError("");
    if (status?.hostKeyConfigured) setDialog("host");
    else void mutate("host");
  }
  if (!allowed) return null;
  return (
    <div className="ssh-credentials">
      <Panel
        title="SSH deploy key"
        description="Give this service read-only access to its saved Git repository."
        actions={
          status && (
            <Badge
              status={
                !sourceSaved
                  ? "pending-changes"
                  : !status.configured
                    ? "not-configured"
                    : !status.hostKeyConfigured
                      ? "pending"
                      : "configured"
              }
              label={
                !sourceSaved
                  ? "Save source first"
                  : !status.configured
                    ? "Deploy key needed"
                    : !status.hostKeyConfigured
                      ? "Server keys needed"
                      : "SSH configured"
              }
            />
          )
        }
      >
        <div className="form-panel">
          {status && (
            <SetupProgress
              label="SSH configuration progress"
              steps={[
                {
                  label: "Source",
                  detail: sourceSaved
                    ? "Repository saved"
                    : "Save your changes",
                  state: sourceSaved ? "complete" : "current",
                },
                {
                  label: "Deploy key",
                  detail:
                    sourceSaved && status.configured
                      ? "Public key generated"
                      : "Generate a key pair",
                  state:
                    sourceSaved && status.configured
                      ? "complete"
                      : sourceSaved
                        ? "current"
                        : "pending",
                },
                ...(!automaticGithub ? [{
                  label: "Server trust",
                  detail:
                    sourceSaved && status.hostKeyConfigured
                      ? "Host keys pinned"
                      : "Verify and pin host keys",
                  state:
                    sourceSaved && status.hostKeyConfigured
                      ? "complete" as const
                      : sourceSaved && status.configured
                        ? "current" as const
                        : "pending" as const,
                }] : []),
              ]}
            />
          )}
          <ErrorBox
            message={(errorLocation !== "host" ? error : "") || query.error}
            retry={query.error ? query.reload : undefined}
          />
          {!sourceSaved && (
            <Notice tone="warning" title="Save your repository first">
              Save the source before changing SSH access. Keys are scoped to the
              exact saved repository.
            </Notice>
          )}
          {sourceSaved && status?.configured && !status.hostKeyConfigured && (
            <Notice tone="warning" title="Next: verify the Git server">
              A deploy key is ready. Pin the server’s trusted host keys before
              FullPanel can clone the repository.
              <Button
                variant="ghost"
                onClick={() => {
                  const section = document
                    .getElementById(`ssh-host-${service.id}`)
                    ?.closest("section");
                  section?.scrollIntoView({
                    block: "start",
                    behavior: "smooth",
                  });
                  section
                    ?.querySelector<HTMLElement>("summary, textarea")
                    ?.focus({ preventScroll: true });
                }}
              >
                Go to server keys <ArrowUpRight size={13} />
              </Button>
            </Notice>
          )}
          {sourceSaved && status?.configured && status.hostKeyConfigured && (
            <p className="configuration-disclaimer">
              <Info size={14} aria-hidden="true" />
              Configuration saved; repository access is checked during cloning.
            </p>
          )}
          {access.mode === "demo" && (
            <div className="ssh-demo-note">
              <Info size={15} aria-hidden="true" />
              <p>
                Demo mode generates and stores real SSH keys. Cloning and
                deployments are simulated; repository access is not checked.
              </p>
            </div>
          )}
          {query.loading ? (
            <Loading label="Loading SSH access" />
          ) : (
            status && (
              <>
                <section
                  className="ssh-setup-step"
                  aria-labelledby={`ssh-key-${service.id}`}
                >
                  <div className="ssh-step-heading">
                    <span data-complete={!!status.configured}>
                      {status.configured ? (
                        <CheckCircle2 size={17} aria-hidden="true" />
                      ) : (
                        "01"
                      )}
                    </span>
                    <div>
                      <h3 id={`ssh-key-${service.id}`}>
                        Authorize this service
                      </h3>
                      <p>
                        The private key stays on this server and is never
                        displayed.
                      </p>
                    </div>
                    <KeyRound size={19} />
                  </div>
                  <div className="ssh-repository">
                    <span>Saved repository</span>
                    <code>
                      {status.repository || service.source.repository}
                    </code>
                  </div>
                  {status.configured && status.publicKey ? (
                    <>
                      <Field
                        label="Public deploy key"
                        hint="Add this public key to your repository’s Deploy keys with read-only access."
                      >
                        <textarea
                          readOnly
                          value={status.publicKey}
                          className="mono ssh-public-key"
                          rows={3}
                          spellCheck={false}
                        />
                      </Field>
                      <div className="ssh-copy-actions">
                        <CopyButton
                          value={status.publicKey}
                          label="Copy public key"
                          ariaLabel="Copy SSH public key"
                        />
                        <span>
                          {status.updatedAt &&
                            `Generated ${date(status.updatedAt)}`}
                        </span>
                      </div>
                      {status.fingerprint && (
                        <div className="ssh-fingerprint">
                          <div>
                            <span>Deploy key fingerprint</span>
                            <code>{status.fingerprint}</code>
                          </div>
                          <CopyButton
                            value={status.fingerprint}
                            label="Copy fingerprint"
                            ariaLabel="Copy deploy key fingerprint"
                          />
                        </div>
                      )}
                      <div className="ssh-instructions">
                        <h4>Connect it to your repository</h4>
                        <ol>
                          <li>
                            Open the repository settings and add a deploy key
                            using the public key above.
                          </li>
                          <li>
                            Leave write access disabled. FullPanel only needs to
                            read the repository.
                          </li>
                          <li>
                            {automaticGithub
                              ? "Deploy your service. GitHub’s server identity is checked automatically."
                              : "Pin the server’s host key below, then deploy your service."}
                          </li>
                        </ol>
                        <a
                          href="https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          GitHub deploy key guide <ArrowUpRight size={13} />
                        </a>
                      </div>
                      <div className="ssh-key-actions">
                        <Button
                          variant="ghost"
                          disabled={!canChange}
                          onClick={() => {
                            setError("");
                            setDialog("revoke");
                          }}
                        >
                          <Trash2 size={14} />
                          Remove SSH access
                        </Button>
                        <Button
                          variant="secondary"
                          disabled={!canChange}
                          onClick={() => {
                            setError("");
                            setDialog("rotate");
                          }}
                        >
                          <RefreshCw size={14} />
                          Rotate deploy key
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="ssh-key-empty">
                      <p>
                        Generate a dedicated key pair, then authorize the public
                        key with your Git provider. This does not contact or
                        authorize the repository automatically.
                      </p>
                      <Button
                        busy={busy === "generate"}
                        disabled={!canChange}
                        onClick={() => void mutate("generate")}
                      >
                        <KeyRound size={15} />
                        Generate SSH deploy key
                      </Button>
                    </div>
                  )}
                </section>
                <section
                  className="ssh-setup-step"
                  aria-labelledby={`ssh-host-${service.id}`}
                >
                  {automaticGithub ? (
                    <div className="github-host-trust" role="region" aria-label="GitHub server identity">
                      <div className="github-host-heading">
                        <ShieldCheck size={20} aria-hidden="true" />
                        <h3 id={`ssh-host-${service.id}`}>GitHub server verification is automatic</h3>
                        <Badge status="configured" label="Official GitHub key" />
                      </div>
                      <p>FullPanel checks <strong>github.com:22</strong> against GitHub’s published server key when cloning. No manual server-key setup is needed. Add your deploy public key to GitHub, then deploy.</p>
                      <details className="github-host-details">
                        <summary>View official key details</summary>
                        <dl>
                          {!!status.hostFingerprints?.length && <div><dt>Published server fingerprint</dt><dd>{status.hostFingerprints.map(fingerprint => <code key={fingerprint}>{fingerprint}</code>)}</dd></div>}
                          <div><dt>Source checked</dt><dd><time dateTime={githubHostKeyCheckedAt}>{githubHostKeyCheckedAt}</time> · <a href={githubHostKeySource} target="_blank" rel="noopener noreferrer">Official GitHub documentation <ArrowUpRight size={13} /></a></dd></div>
                        </dl>
                        <p className="form-note">The pinned identity is checked on each clone. This does not confirm repository access or a successful network connection.</p>
                      </details>
                    </div>
                  ) : <>
                    <div className="ssh-step-heading">
                      <span data-complete={!!status.hostKeyConfigured}>{status.hostKeyConfigured ? <CheckCircle2 size={17} aria-hidden="true" /> : "02"}</span>
                      <div><h3 id={`ssh-host-${service.id}`}>Verify the Git server</h3><p>Trust only host keys checked with the provider or server administrator.</p></div>
                      <ShieldCheck size={19} />
                    </div>
                    <div className="ssh-host-status">
                      <Badge status={status.hostKeyConfigured ? "configured" : "pending"} label={status.hostKeyConfigured ? "Server keys pinned" : "Server keys required before cloning"} />
                      {status.hostKeyUpdatedAt && <span>Updated {date(status.hostKeyUpdatedAt)}</span>}
                    </div>
                    {!!status.hostFingerprints?.length && <div className="ssh-host-fingerprints"><span>Trusted server fingerprints</span>{status.hostFingerprints.map(fingerprint => <div className="ssh-fingerprint" key={fingerprint}><code>{fingerprint}</code><CopyButton value={fingerprint} label="Copy" ariaLabel={`Copy server fingerprint ${fingerprint}`} /></div>)}</div>}
                    {isGithubHost && status.hostKeySource === "manual" && <Notice title="Custom GitHub server keys are pinned">Your explicitly saved server keys take precedence over FullPanel’s published GitHub default. They are preserved until you replace or remove them.</Notice>}
                  </>}
                  <ErrorBox message={errorLocation === "host" ? error : ""} />
                  <details className="ssh-manual-trust" open={!isGithubHost}>
                    <summary>{isGithubHost ? "Advanced: enter host keys manually" : "Enter verified server keys"}</summary>
                  <form onSubmit={saveHost}>
                    <fieldset
                      className="plain-fieldset"
                      disabled={!canChange || !status.configured}
                    >
                      <Field
                        label="Trusted server host keys (known_hosts)"
                        hint={`Paste complete OpenSSH known_hosts lines for ${expectedHost}. Use the exact host and port; wildcards and hashed hostnames are not accepted.`}
                      >
                        <textarea
                          value={knownHosts}
                          onChange={(event) => {
                            setKnownHosts(event.target.value);
                            setVerified(false);
                          }}
                          className="code-editor ssh-known-hosts"
                          rows={4}
                          maxLength={16000}
                          spellCheck={false}
                          autoComplete="off"
                          required
                          placeholder={`${expectedHost} ssh-ed25519 <verified-server-public-key>`}
                        />
                      </Field>
                      <label className="checkbox-field ssh-verification">
                        <input
                          type="checkbox"
                          checked={verified}
                          onChange={(event) =>
                            setVerified(event.target.checked)
                          }
                        />
                        <span>
                          I verified these server keys against a trusted
                          provider or administrator.
                        </span>
                      </label>
                      <div className="ssh-host-save">
                        <Button
                          type="submit"
                          busy={busy === "host"}
                          disabled={
                            !verified || !hostChanged || !knownHosts.trim()
                          }
                        >
                          <ShieldCheck size={15} />
                          {status.hostKeyConfigured
                            ? "Replace pinned host keys"
                            : "Pin server host keys"}
                        </Button>
                      </div>
                    </fieldset>
                  </form>
                  </details>
                  {!automaticGithub && !status.configured && (
                    <p className="form-note">
                      Generate a deploy key before saving trusted server keys.
                    </p>
                  )}
                  {!automaticGithub && <div className="ssh-trust-guidance">
                    <p>
                      Get the public host keys from the provider’s trusted
                      documentation or your administrator. FullPanel does not
                      scan for or automatically trust custom server keys.
                    </p>
                    <div>
                      <a
                        href={githubKeys}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        GitHub host keys <ArrowUpRight size={13} />
                      </a>
                      <a
                        href={gitlabKeys}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        GitLab.com host keys <ArrowUpRight size={13} />
                      </a>
                    </div>
                    <p>
                      If a deployment reports a changed host key, verify the
                      change with the provider before replacing the pinned keys.
                    </p>
                  </div>}
                </section>
                <p className="form-note ssh-scope-note">
                  Changing the saved repository removes its deploy key and
                  trusted server keys. A branch change keeps them. Existing
                  running containers are not changed by key management.
                </p>
              </>
            )
          )}
        </div>
      </Panel>
      {dialog && (
        <Modal
          title={
            dialog === "rotate"
              ? "Rotate SSH deploy key?"
              : dialog === "revoke"
                ? "Remove SSH access?"
                : "Replace trusted server keys?"
          }
          description={
            dialog === "rotate"
              ? "The current private key will be replaced immediately. Add the new public key at your Git provider before deploying again. Pinned server keys are preserved."
              : dialog === "revoke"
                ? "This removes the service’s private deploy key and pinned server keys. Future SSH deployments require new credentials. Running containers keep running."
                : `Replace the trusted identity for ${expectedHost}. Continue only after independently verifying the new server keys.`
          }
          close={() => {
            if (!busy) setDialog(undefined);
          }}
        >
          <ErrorBox message={error} />
          {dialog === "rotate" || dialog === "revoke" ? (
            <Notice>
              Remove the old public deploy key from your Git provider
              separately. FullPanel cannot revoke permissions in the provider’s
              repository settings.
            </Notice>
          ) : (
            <div className="ssh-host-preview">
              <span>New trusted host entries</span>
              <pre>{knownHosts}</pre>
            </div>
          )}
          <div className="modal-actions">
            <Button
              variant="secondary"
              disabled={!!busy}
              onClick={() => setDialog(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant={dialog === "revoke" ? "danger" : "primary"}
              busy={!!busy}
              disabled={!sourceSaved}
              onClick={() => void mutate(dialog)}
            >
              {dialog === "rotate"
                ? "Rotate deploy key"
                : dialog === "revoke"
                  ? "Remove SSH access"
                  : "Replace trusted keys"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
