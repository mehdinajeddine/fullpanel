import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  AlertCircle,
  Check,
  ChevronRight,
  CircleDashed,
  Container,
  Database,
  Layers,
  Loader2,
  Search,
  X,
} from "lucide-react";
import type { Service, ServiceKind } from "../shared/types";
import { navigate } from "./api";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <a className="brand" href="#/" aria-label="Harborlight home">
      <span className="brand-mark">
        <svg
          width="28"
          height="28"
          viewBox="0 0 32 32"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M11 25h10l-3-13h-4l-3 13Z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M12 8h8M16 3v2M4 12l5 2M28 12l-5 2M8 28h16"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </span>
      {!compact && (
        <span>
          harborlight<span className="brand-period">.</span>
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
export function Badge({ status }: { status: string }) {
  return (
    <span className={`badge status-${status}`}>
      <span />
      {status === "not-deployed" ? "Not deployed" : status.replace(/-/g, " ")}
    </span>
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
  return (
    <label className={`field ${className}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
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
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const old = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) || []),
      ].filter((el) => el.offsetParent !== null);
    const timer = window.setTimeout(
      () =>
        (
          ref.current?.querySelector<HTMLElement>(
            '[autofocus], input:not([type="hidden"]), select, textarea',
          ) ||
          focusable()[0] ||
          ref.current
        )?.focus(),
      20,
    );
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
        if (e.shiftKey && document.activeElement === first) {
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
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", key);
      old?.focus();
    };
  }, []);
  return (
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
    </div>
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
      <Badge status={service.status} />
      <ChevronRight size={17} className="muted" />
    </button>
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice">
      <CircleDashed size={17} />
      <p>{children}</p>
    </div>
  );
}
export function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}) {
  const toast = useToast();
  return (
    <Button
      variant="ghost"
      type="button"
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
