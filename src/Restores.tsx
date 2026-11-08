import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowUpRight,
  CheckCircle2,
  Download,
  HardDrive,
  History,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import type { Backup, Project, RestoreJob, Service } from "../shared/types";
import { date, post, relative, useQuery } from "./api";
import { useAccess } from "./Access";
import {
  Badge,
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

const phases: Record<RestoreJob["phase"], string> = {
  validating: "Validating backup",
  "pre-backup": "Creating recovery backup",
  restoring: "Restoring into new volumes",
  finished: "Finished",
};
const isActive = (job: RestoreJob) =>
  ["queued", "running"].includes(job.status);
function unavailableReason(
  backup: Backup,
  mode: "demo" | "docker",
): string | undefined {
  if (mode === "demo")
    return "Restore is available only in Docker mode. Demo backups contain no recoverable application data.";
  if (backup.status !== "success")
    return "Only successful backups can be restored.";
  if (!backup.metadata || backup.metadata.schemaVersion !== 1 || !backup.sha256)
    return "Create a new backup to enable verified restores. This backup lacks recovery metadata.";
  if (backup.metadata.kind === "compose")
    return "Compose restoration is not supported.";
  if (backup.metadata.format === "demo")
    return "A demo backup cannot be restored into a real Docker service.";
  return undefined;
}
function RestoreDialog({
  backup,
  preferredTargetId,
  close,
  queued,
}: {
  backup: Backup;
  preferredTargetId?: string;
  close: () => void;
  queued: (job: RestoreJob) => void;
}) {
  const access = useAccess();
  const services = useQuery<Service[]>("/services");
  const projects = useQuery<Project[]>("/projects");
  const [targetId, setTargetId] = useState(
    preferredTargetId || backup.serviceId,
  );
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const candidates = (services.data || []).filter(
    (service) =>
      access.canOperate(service.projectId) &&
      service.kind === backup.metadata?.kind &&
      service.status === "running" &&
      !!service.deployedAt,
  );
  const target = candidates.find((service) => service.id === targetId);
  const project = projects.data?.find(
    (project) => project.id === target?.projectId,
  );
  const reason = unavailableReason(backup, access.mode);
  const database =
    backup.metadata && !["app", "compose"].includes(backup.metadata.kind);
  async function restore(e: FormEvent) {
    e.preventDefault();
    if (!target || confirmation !== target.name || reason) return;
    setBusy(true);
    setError("");
    try {
      const job = await post<RestoreJob>(`/services/${target.id}/restore`, {
        backupId: backup.id,
        confirmationName: confirmation,
      });
      queued(job);
      close();
      window.dispatchEvent(new Event("harborlight:restore-queued"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Restore a backup"
      description="Replace a running service’s data after backup and compatibility checks."
      close={() => {
        if (!busy) close();
      }}
      wide
    >
      <form onSubmit={restore}>
        <ErrorBox
          message={error || services.error || projects.error || reason || ""}
        />
        <div className="restore-source">
          <span className="event-symbol">
            <HardDrive size={21} />
          </span>
          <div>
            <strong>{backup.filename}</strong>
            <p>
              {backup.metadata?.kind} · {date(backup.createdAt)}
              {backup.metadata?.engineVersion
                ? ` · engine ${backup.metadata.engineVersion}`
                : ""}
            </p>
          </div>
        </div>
        {services.loading || projects.loading ? (
          <Loading label="Finding compatible services" />
        ) : (
          <Field
            label="Destination service"
            hint="Only running services of the same kind, with operator access, are listed. Engine and volume compatibility are validated on the server."
          >
            <select
              value={target?.id || ""}
              onChange={(e) => {
                setTargetId(e.target.value);
                setConfirmation("");
              }}
              required
            >
              <option value="">Choose a destination</option>
              {projects.data
                ?.filter((p) => candidates.some((s) => s.projectId === p.id))
                .map((p) => (
                  <optgroup label={p.name} key={p.id}>
                    {candidates
                      .filter((s) => s.projectId === p.id)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {p.name} / {s.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
            </select>
          </Field>
        )}
        {!services.loading && !candidates.length && !services.error && (
          <Notice>
            No compatible running services are available. Deploy a service of
            the same kind before restoring this backup.
          </Notice>
        )}
        {target && (
          <>
            <div className="restore-impact">
              <h3>
                <RotateCcw size={17} />
                Replace data in {project?.name || "project"} / {target.name}
              </h3>
              <ul>
                <li>
                  A pre-restore backup is created before changing the
                  destination.
                </li>
                <li>
                  Data is imported into candidate volumes and verified. Existing
                  volumes are retained.
                </li>
                <li>
                  The destination briefly stops while the new container takes
                  over.
                </li>
                {database && (
                  <li>
                    Database credentials from this backup replace the
                    destination’s database credentials. Update connected
                    applications if their credentials differ.
                  </li>
                )}
              </ul>
            </div>
            <Field
              label={`Type “${target.name}” to confirm`}
              hint="This confirms the destination shown above. The restore cannot be canceled once it starts."
            >
              <input
                autoComplete="off"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                required
              />
            </Field>
          </>
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
          <Button
            variant="danger"
            busy={busy}
            disabled={
              !target ||
              confirmation !== target.name ||
              !!reason ||
              !!services.error ||
              !!projects.error
            }
          >
            <RotateCcw size={16} />
            Restore backup
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function RestoreJobDialog({
  id,
  close,
}: {
  id: string;
  close: () => void;
}) {
  const [finished, setFinished] = useState(false);
  const query = useQuery<RestoreJob>(`/restores/${id}`, finished ? 0 : 2000);
  const job = query.data;
  const recoveryBackups = useQuery<Backup[]>(
    "/backups",
    0,
    !!job?.preRestoreBackupId &&
      !["validating", "pre-backup"].includes(job.phase),
  );
  const recoveryBackup = recoveryBackups.data?.find(
    (backup) =>
      backup.id === job?.preRestoreBackupId && backup.status === "success",
  );
  useEffect(() => {
    if (job && !isActive(job)) setFinished(true);
  }, [job]);
  return (
    <Modal
      title="Restore progress"
      description={
        job ? `Requested ${date(job.createdAt)}` : "Loading the recovery job."
      }
      close={close}
      wide
    >
      <ErrorBox
        message={query.error || job?.error || ""}
        retry={query.error ? query.reload : undefined}
      />
      {query.loading ? (
        <Loading label="Loading restore progress" />
      ) : (
        job && (
          <>
            <div className="restore-progress-heading" role="status">
              <Badge status={job.status} />
              <strong>
                {job.status === "success"
                  ? "Restore completed"
                  : job.status === "failed"
                    ? "Restore failed"
                    : phases[job.phase]}
              </strong>
              <code>{job.id.slice(0, 8)}</code>
            </div>
            <div className="restore-steps" aria-label="Restore phases">
              {(
                ["validating", "pre-backup", "restoring", "finished"] as const
              ).map((phase, index) => {
                const current = [
                  "validating",
                  "pre-backup",
                  "restoring",
                  "finished",
                ].indexOf(job.phase);
                return (
                  <div
                    className={`${(index < current && job.status !== "failed") || job.status === "success" ? "complete" : ""} ${index === current ? "current" : ""}`}
                    key={phase}
                  >
                    <span>
                      {(index < current && job.status !== "failed") ||
                      job.status === "success" ? (
                        <CheckCircle2 size={14} />
                      ) : (
                        index + 1
                      )}
                    </span>
                    <small>{phases[phase]}</small>
                  </div>
                );
              })}
            </div>
            {isActive(job) && (
              <Notice>
                The restore continues on the server if you close this dialog.
                Follow its progress in Backup history’s restore journal.
              </Notice>
            )}
            <div className="restore-output-heading">
              <span>Recovery journal</span>
              <CopyButton value={job.output} label="Copy journal" />
            </div>
            <pre className="terminal-output restore-output" aria-live="off">
              {job.output ||
                (isActive(job)
                  ? "Waiting for validation to begin…"
                  : "No journal output was recorded.")}
            </pre>
            <div className="restore-result-links">
              <a
                className="text-link"
                href={`#/services/${job.targetServiceId}/backups`}
                onClick={close}
              >
                View destination service
                <ArrowUpRight size={14} />
              </a>
              {recoveryBackup && (
                <a
                  className="download-link"
                  href={`/api/backups/${job.preRestoreBackupId}/download`}
                  download
                >
                  <Download size={14} />
                  Pre-restore backup
                </a>
              )}
            </div>
          </>
        )
      )}
      <div className="modal-actions">
        <Button variant="secondary" onClick={close}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
export function RestoreAction({
  backup,
  projectId,
  preferredTargetId,
}: {
  backup: Backup;
  projectId?: string;
  preferredTargetId?: string;
}) {
  const access = useAccess();
  const [choosing, setChoosing] = useState(false);
  const [jobId, setJobId] = useState<string>();
  const toast = useToast();
  const allowed = access.canOperate(projectId || backup.projectId);
  const reason = unavailableReason(backup, access.mode);
  if (!allowed) return null;
  return (
    <>
      {reason ? (
        <span
          className="restore-unavailable"
          title={reason}
          aria-label={reason}
        >
          Download only
        </span>
      ) : (
        <Button
          variant="ghost"
          className="restore-row-button"
          onClick={() => setChoosing(true)}
        >
          <RotateCcw size={14} />
          Restore
        </Button>
      )}
      {choosing && (
        <RestoreDialog
          backup={backup}
          preferredTargetId={preferredTargetId}
          close={() => setChoosing(false)}
          queued={(job) => {
            setJobId(job.id);
            toast(
              "Restore queued. Follow the recovery journal for its outcome.",
            );
          }}
        />
      )}
      {jobId && (
        <RestoreJobDialog id={jobId} close={() => setJobId(undefined)} />
      )}
    </>
  );
}
export function RestoreHistory({
  services,
  serviceId,
}: {
  services: Service[];
  serviceId?: string;
}) {
  const access = useAccess();
  const allowed = serviceId
    ? access.canOperate(services.find((s) => s.id === serviceId)?.projectId)
    : services.some((s) => access.canOperate(s.projectId)) || access.isAdmin;
  const query = useQuery<RestoreJob[]>(
    serviceId ? `/services/${serviceId}/restores` : "/restores",
    4000,
    allowed,
  );
  const [jobId, setJobId] = useState<string>();
  useEffect(() => {
    const refresh = () => query.reload();
    window.addEventListener("harborlight:restore-queued", refresh);
    return () =>
      window.removeEventListener("harborlight:restore-queued", refresh);
  }, [query.reload]);
  if (!allowed) return null;
  const jobs = (query.data || []).filter((job) =>
    access.canOperate(job.targetProjectId),
  );
  return (
    <>
      <Panel
        title="Restore journal"
        description="Validated recovery jobs and their final outcomes."
        actions={
          <Button variant="ghost" onClick={query.reload}>
            <RefreshCw size={14} />
            Refresh
          </Button>
        }
      >
        <ErrorBox message={query.error} retry={query.reload} />
        {query.loading ? (
          <Loading label="Loading restore history" />
        ) : jobs.length ? (
          <div className="restore-history">
            {jobs.map((job) => (
              <button
                className="restore-history-row"
                key={job.id}
                onClick={() => setJobId(job.id)}
              >
                <span className="event-symbol">
                  <History size={18} />
                </span>
                <span className="restore-history-info">
                  <strong>
                    {services.find(
                      (service) => service.id === job.targetServiceId,
                    )?.name || `Service ${job.targetServiceId.slice(0, 8)}`}
                  </strong>
                  <small>
                    {phases[job.phase]} · {relative(job.createdAt)}
                  </small>
                </span>
                <Badge status={job.status} />
                <ArrowUpRight size={16} />
              </button>
            ))}
          </div>
        ) : !query.error ? (
          <Empty
            icon={<History size={25} />}
            title={
              access.mode === "demo"
                ? "Restoration needs Docker mode"
                : "No restores yet"
            }
            description={
              access.mode === "demo"
                ? "Demo backups are illustrative. Run FullPanel with Docker to restore real application data."
                : "Restore a backup to see its validation and recovery progress here."
            }
          />
        ) : null}
      </Panel>
      {jobId && (
        <RestoreJobDialog id={jobId} close={() => setJobId(undefined)} />
      )}
    </>
  );
}
