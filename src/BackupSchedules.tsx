import { useState, type FormEvent } from "react";
import {
  CalendarClock,
  Clock3,
  Pencil,
  Play,
  Plus,
  Power,
  Trash2,
} from "lucide-react";
import type { Service } from "../shared/types";
import { api, patch, post, useQuery } from "./api";
import {
  Badge,
  Button,
  Empty,
  ErrorBox,
  Field,
  IconButton,
  Loading,
  Modal,
  Panel,
  useToast,
} from "./ui";
interface BackupSchedule {
  id: string;
  serviceId: string;
  frequency: "hourly" | "daily" | "weekly";
  minute: number;
  hour: number;
  weekday: number;
  retention: number;
  enabled: boolean;
  timezone: "UTC";
  createdAt: string;
  nextRunAt: string | null;
  lastRunAt?: string;
  lastBackupId?: string;
  lastStatus: "idle" | "running" | "success" | "failed" | "deferred";
  lastError?: string;
  retentionError?: string;
}
type ScheduleConfig = Pick<
  BackupSchedule,
  "frequency" | "minute" | "hour" | "weekday" | "retention" | "enabled"
>;
const weekdays = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const utc = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";
function recurrence(s: BackupSchedule) {
  const time = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
  return s.frequency === "hourly"
    ? `Hourly at :${String(s.minute).padStart(2, "0")}`
    : s.frequency === "daily"
      ? `Daily at ${time}`
      : `${weekdays[s.weekday]} at ${time}`;
}
function ScheduleEditor({
  schedule,
  serviceId,
  services,
  close,
  saved,
}: {
  schedule?: BackupSchedule;
  serviceId?: string;
  services: Service[];
  close: () => void;
  saved: () => void;
}) {
  const [target, setTarget] = useState(
    schedule?.serviceId || serviceId || services[0]?.id || "",
  );
  const [config, setConfig] = useState<ScheduleConfig>(
    schedule
      ? {
          frequency: schedule.frequency,
          minute: schedule.minute,
          hour: schedule.hour,
          weekday: schedule.weekday,
          retention: schedule.retention,
          enabled: schedule.enabled,
        }
      : {
          frequency: "daily",
          minute: 0,
          hour: 2,
          weekday: 0,
          retention: 7,
          enabled: true,
        },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (schedule) await patch(`/backup-schedules/${schedule.id}`, config);
      else await post(`/services/${target}/backup-schedules`, config);
      toast(schedule ? "Backup schedule updated" : "Backup schedule created");
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
      title={schedule ? "Edit backup schedule" : "Schedule a backup"}
      description="Automatic local backups, with a retention policy you control."
      close={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={submit}>
        <ErrorBox message={error} />
        {!serviceId && !schedule && (
          <Field label="Service">
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              required
            >
              <option value="">Choose a service</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Frequency">
          <select
            value={config.frequency}
            onChange={(e) =>
              setConfig((c) => ({
                ...c,
                frequency: e.target.value as ScheduleConfig["frequency"],
              }))
            }
          >
            <option value="hourly">Every hour</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
          </select>
        </Field>
        {config.frequency === "weekly" && (
          <Field label="Day of the week">
            <select
              value={config.weekday}
              onChange={(e) =>
                setConfig((c) => ({ ...c, weekday: Number(e.target.value) }))
              }
            >
              {weekdays.map((day, i) => (
                <option value={i} key={day}>
                  {day}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="form-grid">
          {config.frequency !== "hourly" && (
            <Field label="Hour (UTC)">
              <input
                type="number"
                min={0}
                max={23}
                required
                value={config.hour}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, hour: Number(e.target.value) }))
                }
              />
            </Field>
          )}
          <Field label="Minute">
            <input
              type="number"
              min={0}
              max={59}
              required
              value={config.minute}
              onChange={(e) =>
                setConfig((c) => ({ ...c, minute: Number(e.target.value) }))
              }
            />
          </Field>
        </div>
        <Field
          label="Successful backups to retain"
          hint="Only successful backups created by this schedule are pruned. Manual backups remain untouched."
        >
          <input
            type="number"
            min={1}
            max={100}
            required
            value={config.retention}
            onChange={(e) =>
              setConfig((c) => ({ ...c, retention: Number(e.target.value) }))
            }
          />
        </Field>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) =>
              setConfig((c) => ({ ...c, enabled: e.target.checked }))
            }
          />
          <span>Enable this schedule</span>
        </label>
        <div className="schedule-timezone-note">
          <Clock3 size={14} />
          All schedule times use UTC. Your local time zone is not applied.
        </div>
        <div className="modal-actions">
          <Button
            variant="secondary"
            type="button"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button busy={busy}>
            {schedule ? "Save schedule" : "Create schedule"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export default function BackupSchedules({
  serviceId,
  services,
}: {
  serviceId?: string;
  services: Service[];
}) {
  const q = useQuery<BackupSchedule[]>(
    serviceId ? `/services/${serviceId}/backup-schedules` : "/backup-schedules",
    7000,
  );
  const [editing, setEditing] = useState<BackupSchedule | "new">();
  const [deleting, setDeleting] = useState<BackupSchedule>();
  const [busy, setBusy] = useState("");
  const toast = useToast();
  const eligible = services.filter(
    (s) => s.kind !== "compose" && (s.kind !== "app" || s.mounts.length > 0),
  );
  async function action(s: BackupSchedule, kind: "run" | "toggle" | "delete") {
    setBusy(s.id);
    try {
      if (kind === "run") {
        await post(`/backup-schedules/${s.id}/run`);
        toast("Scheduled backup started");
      } else if (kind === "toggle") {
        await patch(`/backup-schedules/${s.id}`, { enabled: !s.enabled });
        toast(s.enabled ? "Backup schedule paused" : "Backup schedule enabled");
      } else {
        await api(`/backup-schedules/${s.id}`, { method: "DELETE" });
        toast("Schedule removed. Existing backup files are retained.");
        setDeleting(undefined);
      }
      q.reload();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy("");
    }
  }
  return (
    <>
      <Panel
        title="Backup schedules"
        description="Recurring local backups. All times are shown in UTC."
        actions={
          <Button
            variant="secondary"
            disabled={!eligible.length}
            onClick={() => setEditing("new")}
          >
            <Plus size={15} />
            Add schedule
          </Button>
        }
      >
        <ErrorBox message={q.error} retry={q.reload} />
        {q.loading ? (
          <Loading label="Loading backup schedules" />
        ) : q.data?.length ? (
          <div className="schedule-list">
            {q.data.map((s) => (
              <article className="schedule-row" key={s.id}>
                <span className="event-symbol">
                  <CalendarClock size={18} />
                </span>
                <div className="schedule-info">
                  <h3>
                    {recurrence(s)} <span>UTC</span>
                  </h3>
                  <p>
                    {!serviceId &&
                      `${services.find((x) => x.id === s.serviceId)?.name || "Service"} · `}
                    Keep {s.retention} successful backups
                  </p>
                  <small>
                    {s.nextRunAt
                      ? `Next: ${utc(s.nextRunAt)}`
                      : "Schedule paused"}
                  </small>
                  {s.lastError && (
                    <p className="schedule-error">{s.lastError}</p>
                  )}
                  {s.retentionError && (
                    <p className="schedule-error">
                      Retention: {s.retentionError}
                    </p>
                  )}
                </div>
                <div className="schedule-meta">
                  <Badge
                    status={
                      s.enabled
                        ? s.lastStatus === "idle"
                          ? "scheduled"
                          : s.lastStatus
                        : "paused"
                    }
                  />
                  {s.lastRunAt && (
                    <span title={utc(s.lastRunAt)}>
                      Last run {utc(s.lastRunAt)}
                    </span>
                  )}
                </div>
                <div className="schedule-actions">
                  <IconButton
                    label="Run scheduled backup now"
                    disabled={!!busy || s.lastStatus === "running"}
                    onClick={() => void action(s, "run")}
                  >
                    <Play size={15} />
                  </IconButton>
                  <IconButton
                    label={s.enabled ? "Pause schedule" : "Enable schedule"}
                    disabled={!!busy}
                    onClick={() => void action(s, "toggle")}
                  >
                    <Power size={15} />
                  </IconButton>
                  <IconButton
                    label="Edit backup schedule"
                    disabled={!!busy}
                    onClick={() => setEditing(s)}
                  >
                    <Pencil size={15} />
                  </IconButton>
                  <IconButton
                    label="Delete backup schedule"
                    disabled={!!busy}
                    onClick={() => setDeleting(s)}
                  >
                    <Trash2 size={15} />
                  </IconButton>
                </div>
              </article>
            ))}
          </div>
        ) : !q.error ? (
          <Empty
            icon={<CalendarClock size={25} />}
            title="Give backups a rhythm"
            description="Choose when to back up your service and how many successful copies to keep."
            action={
              eligible.length ? (
                <Button variant="secondary" onClick={() => setEditing("new")}>
                  <Plus size={15} />
                  Create your first schedule
                </Button>
              ) : undefined
            }
          />
        ) : null}
      </Panel>
      {editing && (
        <ScheduleEditor
          schedule={editing === "new" ? undefined : editing}
          serviceId={serviceId}
          services={eligible}
          close={() => setEditing(undefined)}
          saved={q.reload}
        />
      )}{" "}
      {deleting && (
        <Modal
          title="Delete backup schedule?"
          description="Future automatic runs will stop. Existing backup files are retained."
          close={() => {
            if (!busy) setDeleting(undefined);
          }}
        >
          <div className="modal-actions">
            <Button
              variant="secondary"
              onClick={() => setDeleting(undefined)}
              disabled={!!busy}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              busy={busy === deleting.id}
              onClick={() => void action(deleting, "delete")}
            >
              Delete schedule
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
