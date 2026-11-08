import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clock3,
  Container,
  Database,
  Layers,
  Loader2,
  Info,
  PauseCircle,
  Search,
  X,
} from "lucide-react";
import type { Service, ServiceKind } from "../shared/types";
import { navigate } from "./api";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <a className="brand" href="#/" aria-label="FullPanel home">
      <span className="brand-mark">
        <img src="/assets/fullpanel-logo.png" alt="" width="40" height="40" />
      </span>
      {!compact && (
        <span>
          Full<span className="brand-accent">Panel</span>
        </span>
      )}
    </a>
  );
}
export function Button({
  children,
  variant = "primary",
  busy,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      className={`btn btn-${variant} ${className}`}
      disabled={props.disabled || busy}
    >
      {busy && <Loader2 size={16} className="spin" />}
      {children}
    </button>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      {...props}
      type={props.type || "button"}
      className={`icon-button ${props.className || ""}`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}
export type StatusTone = "positive" | "warning" | "danger" | "neutral" | "info";
function statusAppearance(status: string): {
  tone: StatusTone;
  Icon: typeof CheckCircle2;
  label: string;
} {
  const label =
    status === "not-deployed"
      ? "Not deployed"
      : status.replace(/-/g, " ").replace(/^./, (value) => value.toUpperCase());
  if (["failed", "error"].includes(status))
    return { tone: "danger", Icon: AlertCircle, label };
  if (["running", "success", "enabled", "active"].includes(status))
    return { tone: "positive", Icon: CheckCircle2, label };
  if (
    [
      "deploying",
      "queued",
      "restoring",
      "pending",
      "deferred",
      "pending-changes",
    ].includes(status)
  )
    return {
      tone: "warning",
      Icon: ["deploying", "restoring"].includes(status) ? Loader2 : Clock3,
      label,
    };
  if (["stopped", "paused", "disabled"].includes(status))
    return { tone: "neutral", Icon: PauseCircle, label };
  if (
    ["not-deployed", "not configured", "not-configured", "idle"].includes(
      status,
    )
  )
    return { tone: "neutral", Icon: CircleDashed, label };
  return { tone: "info", Icon: Info, label };
}
export function Badge({
  status,
  label,
  tone,
}: {
  status: string;
  label?: string;
  tone?: StatusTone;
}) {
  const appearance = statusAppearance(status);
  return (
    <span
      className={`badge status-${status.replace(/\s+/g, "-")}`}
      data-tone={tone || appearance.tone}
    >
      <appearance.Icon
        size={12}
        aria-hidden="true"
        className={
          status === "deploying" || status === "restoring" ? "spin" : undefined
        }
      />
      {label || appearance.label}
    </span>
  );
}
export function hasPendingConfiguration(service: Service) {
  return (
    service.runtimeUncertain ||
    (service.pendingChanges ??
      (!!service.deployedAt &&
        Date.parse(service.updatedAt) > Date.parse(service.deployedAt)))
  );
}
export function ConfigurationBadge({ service }: { service: Service }) {
  return service.runtimeUncertain ? (
    <Badge status="pending-changes" label="Runtime uncertain" tone="warning" />
  ) : !service.deployedAt ? (
    <Badge status="not-deployed" label="Awaiting first deploy" />
  ) : hasPendingConfiguration(service) ? (
    <Badge status="pending-changes" label="Saved changes" />
  ) : (
    <Badge status="configured" label="Configuration applied" />
  );
}
export function ServiceStateSummary({ services }: { services: Service[] }) {
  return (
    <div
      className="service-state-summary"
      role="list"
      aria-label="Service states"
    >
      {["running", "deploying", "failed", "stopped", "not-deployed"].map(
        (status) => {
          const count = services.filter(
            (service) => service.status === status,
          ).length;
          return (
            <div
              role="listitem"
              key={status}
              data-empty={!count}
              aria-label={`${count} ${status.replace(/-/g, " ")} services`}
            >
              <strong>{count}</strong>
              <Badge status={status} tone={count ? undefined : "neutral"} />
            </div>
          );
        },
      )}
    </div>
  );
}
export function SetupProgress({
  label,
  steps,
}: {
  label: string;
  steps: {
    label: string;
    detail: string;
    state: "complete" | "current" | "pending";
  }[];
}) {
  return (
    <ol className="setup-progress" aria-label={label}>
      {steps.map((step, index) => (
        <li key={step.label} data-state={step.state}>
          <span className="setup-progress-marker" aria-hidden="true">
            {step.state === "complete" ? <Check size={15} /> : index + 1}
          </span>
          <div>
            <strong>
              {step.label}
              <span className="sr-only">
                {" "}
                —{" "}
                {step.state === "complete"
                  ? "Complete"
                  : step.state === "current"
                    ? "Next step"
                    : "Pending"}
              </span>
            </strong>
            <small>{step.detail}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}
export function ServiceIcon({
  kind,
  size = 20,
}: {
  kind: ServiceKind;
  size?: number;
}) {
  const Icon =
    kind === "app" ? Container : kind === "compose" ? Layers : Database;
  return (
    <span className={`service-icon kind-${kind}`}>
      <Icon size={size} />
    </span>
  );
}
export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  let targetId: string | undefined;
  const connect = (node: ReactNode): ReactNode => {
    if (
      !isValidElement<{
        id?: string;
        children?: ReactNode;
        "aria-describedby"?: string;
      }>(node)
    )
      return node;
    if (
      !targetId &&
      typeof node.type === "string" &&
      ["input", "select", "textarea"].includes(node.type)
    ) {
      targetId = node.props.id || id;
      return cloneElement(node, {
        id: targetId,
        "aria-describedby":
          [node.props["aria-describedby"], hint ? hintId : undefined]
            .filter(Boolean)
            .join(" ") || undefined,
      });
    }
    return node.props.children
      ? cloneElement(node, {}, Children.map(node.props.children, connect))
      : node;
  };
  const controls = Children.map(children, connect);
  return (
    <div className={`field ${className}`}>
      {targetId ? (
        <label htmlFor={targetId} className="field-label">
          {label}
        </label>
      ) : (
        <span className="field-label">{label}</span>
      )}
      {controls}
      {hint && (
        <span id={hintId} className="field-hint">
          {hint}
        </span>
      )}
    </div>
  );
}
export function ErrorBox({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  if (!message) return null;
  return (
    <div className="error-box" role="alert">
      <AlertCircle size={18} />
      <span>{message}</span>
      {retry && <button onClick={retry}>Try again</button>}
    </div>
  );
}
export function Loading({
  label = "Loading your workspace",
}: {
  label?: string;
}) {
  return (
    <div className="loading-state" role="status">
      <Loader2 size={24} className="spin" />
      {label}
    </div>
  );
}
export function Empty({
  icon = <Layers size={26} />,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}
export function Panel({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="panel-heading">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
export function SearchInput({
  value,
  onChange,
  placeholder = "Search…",
  label = "Search",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
}) {
  return (
    <div className="search-input">
      <Search size={17} />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
      />
    </div>
  );
}
export function Modal({
  title,
  description,
  children,
  close,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef(document.activeElement as HTMLElement | null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    const old = returnFocusRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) || []),
      ].filter((el) => el.offsetParent !== null);
    // Establish focus before paint, and preserve a child's own autofocus.
    // A delayed focus would steal text input from someone already editing.
    if (!ref.current?.contains(document.activeElement)) {
      (
        ref.current?.querySelector<HTMLElement>(
          '[autofocus], input:not([type="hidden"]), select, textarea',
        ) ||
        focusable()[0] ||
        ref.current
      )?.focus();
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const els = focusable();
        const first = els[0],
          last = els.at(-1);
        if (!first) {
          e.preventDefault();
          return;
        }
        if (!ref.current?.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", key);
      if (old?.isConnected) old.focus();
      else document.getElementById("main-content")?.focus();
    };
  }, []);
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        tabIndex={-1}
        className={`modal ${wide ? "modal-wide" : ""}`}
      >
        <div className="modal-heading">
          <div>
            <h2 id={id}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <IconButton label="Close dialog" onClick={close}>
            <X size={19} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
export function ConfirmDelete({
  name,
  description,
  onConfirm,
  close,
}: {
  name: string;
  description: string;
  onConfirm: () => Promise<void>;
  close: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await onConfirm();
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Delete ${name}?`}
      description={description}
      close={() => {
        if (!busy) close();
      }}
    >
      <form onSubmit={submit}>
        <ErrorBox message={error} />
        <Field label={`Type “${name}” to confirm`}>
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="off"
          />
        </Field>
        <div className="modal-actions">
          <Button
            variant="secondary"
            type="button"
            onClick={close}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button variant="danger" busy={busy} disabled={value !== name}>
            Delete permanently
          </Button>
        </div>
      </form>
    </Modal>
  );
}
const ToastContext = createContext<
  (message: string, kind?: "success" | "error") => void
>(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<
    { id: number; message: string; kind: string }[]
  >([]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);
  function toast(message: string, kind = "success") {
    const id = Date.now() + Math.random();
    setToasts((old) => [...old.slice(-2), { id, message, kind }]);
    timers.current.push(
      window.setTimeout(
        () => setToasts((old) => old.filter((t) => t.id !== id)),
        5000,
      ),
    );
  }
  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === "error" ? (
              <AlertCircle size={18} />
            ) : (
              <Check size={18} />
            )}
            <span>{t.message}</span>
            <IconButton
              label="Dismiss notification"
              onClick={() =>
                setToasts((old) => old.filter((x) => x.id !== t.id))
              }
            >
              <X size={15} />
            </IconButton>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
export function ServiceRow({
  service,
  showProject,
}: {
  service: Service;
  showProject?: string;
}) {
  return (
    <button
      className="service-row"
      onClick={() => navigate(`/services/${service.id}`)}
    >
      <ServiceIcon kind={service.kind} />
      <span className="service-row-name">
        <strong>{service.name}</strong>
        <small>
          {showProject ? `${showProject} / ` : ""}
          {service.source.image || service.source.repository || service.kind}
        </small>
      </span>
      <span className="service-row-states">
        <Badge status={service.status} />
        {hasPendingConfiguration(service) && (
          <ConfigurationBadge service={service} />
        )}
      </span>
      <ChevronRight size={17} className="muted" />
    </button>
  );
}
export function Notice({
  children,
  tone = "info",
  title,
}: {
  children: ReactNode;
  tone?: StatusTone;
  title?: string;
}) {
  const Icon =
    tone === "warning"
      ? AlertTriangle
      : tone === "positive"
        ? CheckCircle2
        : tone === "danger"
          ? AlertCircle
          : Info;
  return (
    <div className="notice" data-tone={tone}>
      <Icon size={18} aria-hidden="true" />
      <div>
        {title && <strong className="notice-title">{title}</strong>}
        <p>{children}</p>
      </div>
    </div>
  );
}
export function CopyButton({
  value,
  label = "Copy",
  ariaLabel = label,
}: {
  value: string;
  label?: string;
  ariaLabel?: string;
}) {
  const toast = useToast();
  return (
    <Button
      variant="ghost"
      type="button"
      aria-label={ariaLabel}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast("Copied to clipboard");
        } catch {
          toast("Clipboard access unavailable", "error");
        }
      }}
    >
      {label}
    </Button>
  );
}
