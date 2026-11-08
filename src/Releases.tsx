import { useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  Box,
  GitCommitHorizontal,
  History,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import type {
  Deployment,
  Release,
  ReleasesResponse,
  Service,
} from "../shared/types";
import { date, navigate, post, relative, useQuery } from "./api";
import { useAccess } from "./Access";
import {
  Button,
  CopyButton,
  Empty,
  ErrorBox,
  Field,
  Loading,
  Modal,
  Notice,
  Panel,
  useToast,
} from "./ui";

function RollbackDialog({
  service,
  release,
  close,
}: {
  service: Service;
  release: Release;
  close: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (confirmation !== service.name) return;
    setBusy(true);
    setError("");
    try {
      const deployment = await post<Deployment>(
        `/services/${service.id}/rollback`,
        { releaseId: release.id, confirmationName: confirmation },
      );
      toast("Rollback queued. Follow its deployment output for the result.");
      close();
      navigate(`/deployments/${deployment.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Roll back application"
      description={`Deploy release ${release.id.slice(0, 8)} to ${service.name}.`}
      close={() => {
        if (!busy) close();
      }}
      wide
    >
      <form onSubmit={submit}>
        <ErrorBox message={error} />
        <div className="release-selection">
          <Box size={22} />
          <div>
            <strong>{release.image}</strong>
            <code>{release.imageId}</code>
            <small>
              {date(release.createdAt)}
              {release.commit ? ` · commit ${release.commit.slice(0, 12)}` : ""}
            </small>
          </div>
        </div>
        <div className="restore-impact">
          <h3>
            <RotateCcw size={17} />
            Return the runtime to this release
          </h3>
          <ul>
            <li>
              The recorded image and runtime configuration are deployed again,
              including that release’s environment variables.
            </li>
            <li>
              Saved configuration stays unchanged. If it differs from this
              release, Deploy applies those saved changes later.
            </li>
            <li>
              Persistent volumes keep their current data. This does not restore
              a database or reverse data migrations.
            </li>
            <li>
              The current container briefly stops during replacement. If the
              image is unavailable, the rollback is refused.
            </li>
          </ul>
        </div>
        <Field
          label={`Type “${service.name}” to confirm`}
          hint="Confirm the application receiving this release."
        >
          <input
            autoComplete="off"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            required
          />
        </Field>
        <div className="modal-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            busy={busy}
            disabled={confirmation !== service.name}
          >
            <RotateCcw size={16} />
            Roll back application
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function Releases({ service }: { service: Service }) {
  const query = useQuery<ReleasesResponse>(
    `/services/${service.id}/releases`,
    5000,
  );
  const [selected, setSelected] = useState<Release>();
  const canOperate = useAccess().canOperate(service.projectId);
  return (
    <>
      <Panel
        title="Application releases"
        description="Recorded images and runtime configurations from successful deployments."
        actions={
          <Button variant="ghost" onClick={query.reload}>
            <RefreshCw size={15} />
            Refresh releases
          </Button>
        }
      >
        <ErrorBox message={query.error} retry={query.reload} />
        {query.loading ? (
          <Loading label="Loading application releases" />
        ) : (
          query.data &&
          (!query.data.supported ? (
            <Empty
              icon={<History size={25} />}
              title="Release rollback is unavailable"
              description={
                query.data.reason ||
                "Release rollback requires an application running in Docker mode."
              }
            />
          ) : !query.data.releases.length ? (
            <Empty
              icon={<Box size={26} />}
              title="No recorded releases yet"
              description="Deploy this application to record a recoverable release. Older deployments without a saved image and runtime configuration cannot be rolled back."
            />
          ) : (
            <>
              <div className="release-history-note">
                <Notice>
                  Rollback changes the running image and configuration.
                  Persistent data stays current. Saved configuration and secrets
                  are not displayed in this history.
                </Notice>
              </div>
              <div className="release-list">
                {query.data.releases.map((release) => {
                  const active = query.data?.activeReleaseId === release.id;
                  return (
                    <article
                      className={`release-card ${active ? "release-active" : ""}`}
                      key={release.id}
                      aria-label={`Release ${release.id.slice(0, 8)}`}
                    >
                      <div className="release-card-heading">
                        <span className="release-symbol">
                          <Box size={20} />
                        </span>
                        <div className="release-card-title">
                          <strong>
                            Release <code>{release.id.slice(0, 8)}</code>
                          </strong>
                          <time
                            dateTime={release.createdAt}
                            title={date(release.createdAt)}
                          >
                            {relative(release.createdAt)} ·{" "}
                            {date(release.createdAt)}
                          </time>
                        </div>
                        {active && (
                          <span className="badge status-running">
                            <span />
                            Active
                          </span>
                        )}
                        {release.rollbackOf && (
                          <span className="release-origin">Rollback</span>
                        )}
                      </div>
                      <dl className="release-facts">
                        <div>
                          <dt>Image</dt>
                          <dd>{release.image}</dd>
                        </div>
                        <div>
                          <dt>Image ID</dt>
                          <dd className="release-image-id">
                            <code>{release.imageId}</code>
                            <CopyButton
                              value={release.imageId}
                              label="Copy"
                              ariaLabel={`Copy image ID for release ${release.id.slice(0, 8)}`}
                            />
                          </dd>
                        </div>
                        <div>
                          <dt>Source</dt>
                          <dd>
                            {release.sourceType === "git"
                              ? "Git repository"
                              : release.sourceType === "dockerfile"
                                ? "Dockerfile"
                                : release.sourceType === "image"
                                  ? "Container image"
                                  : "Compose"}
                          </dd>
                        </div>
                        {release.commit && (
                          <div>
                            <dt>Commit</dt>
                            <dd>
                              <GitCommitHorizontal size={14} />
                              <code title={release.commit}>
                                {release.commit.slice(0, 12)}
                              </code>
                              <CopyButton
                                value={release.commit}
                                label="Copy"
                                ariaLabel={`Copy commit for release ${release.id.slice(0, 8)}`}
                              />
                            </dd>
                          </div>
                        )}
                        <div>
                          <dt>Trigger</dt>
                          <dd>{release.trigger}</dd>
                        </div>
                      </dl>
                      <div className="release-card-footer">
                        <a
                          className="text-link"
                          href={`#/deployments/${release.deploymentId}`}
                        >
                          View deployment
                          <ArrowUpRight size={14} />
                        </a>
                        {canOperate && release.canRollback && !active ? (
                          <Button
                            variant="secondary"
                            disabled={service.status === "deploying"}
                            onClick={() => setSelected(release)}
                          >
                            <RotateCcw size={15} />
                            Roll back
                          </Button>
                        ) : !active && release.rollbackReason ? (
                          <small>{release.rollbackReason}</small>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          ))
        )}
      </Panel>
      {selected && (
        <RollbackDialog
          service={service}
          release={selected}
          close={() => setSelected(undefined)}
        />
      )}
    </>
  );
}
