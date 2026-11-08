import {
  Component,
  useEffect,
  useState,
  type ErrorInfo,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowRight,
  Box,
  ChevronRight,
  Folder,
  HardDrive,
  KeyRound,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Menu,
  Package,
  Rocket,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import type { Project, Service, Session, Settings } from "../shared/types";
import { navigate, post, useQuery, useRoute } from "./api";
import {
  Brand,
  Button,
  Empty,
  ErrorBox,
  Field,
  IconButton,
  Loading,
  Modal,
  ServiceIcon,
  ToastProvider,
  useToast,
} from "./ui";
import Dashboard from "./Dashboard";
import { ProjectsPage } from "./Projects";
import ServicePage from "./Service";
import { AccessProvider, accessFor, useAccess } from "./Access";
import { AccountsPage, ApiKeysPage } from "./Accounts";
import {
  ActivityPage,
  BackupsPage,
  DeploymentsPage,
  SettingsPage,
  TemplatesPage,
} from "./Operations";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: string }
> {
  state = { error: "" };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("FullPanel interface error", error, info.componentStack);
  }
  render() {
    return this.state.error ? (
      <div className="fatal-error">
        <Brand />
        <h1>Something interrupted this view.</h1>
        <p>Your data stays on your server. Reload the page to reconnect.</p>
        <Button onClick={() => window.location.reload()}>
          Reload workspace
        </Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function Auth({
  session,
  authenticated,
}: {
  session: Session;
  authenticated: (session: Session) => void;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = "light";
  }, []);
  const setup = session.setupRequired;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const result = await post<Session>(
        setup ? "/auth/setup" : "/auth/login",
        { ...(setup ? { name } : {}), email, password },
      );
      authenticated(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <aside className="auth-story">
        <Brand />
        <div className="auth-story-content">
          <span className="eyebrow">A HOME FOR WHAT YOU BUILD</span>
          <h1>
            Your infrastructure.
            <br />
            In good hands.
          </h1>
          <p>
            Deploy your ideas. Keep your independence.
            <br />A calmer way to manage your own server.
          </p>
          <div className="auth-illustration" aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="orbit orbit-three" />
            <div className="auth-product-mark">
              <img
                src="/assets/fullpanel-logo.png"
                alt=""
                width="132"
                height="132"
              />
            </div>
            <span className="floating-service floating-one">
              <Box size={23} />
            </span>
            <span className="floating-service floating-two">
              <Server size={23} />
            </span>
            <span className="floating-service floating-three">
              <ShieldCheck size={23} />
            </span>
          </div>
        </div>
        <div className="auth-story-footer">
          <span>
            <span className="tiny-dot" />
            Independent by design.
          </span>
          <span>OPEN SOURCE · APACHE-2.0</span>
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-mobile-brand">
          <Brand />
        </div>
        <div className="auth-form-wrap">
          <div className="auth-lock">
            <LockKeyhole size={23} />
          </div>
          <span className="eyebrow">
            {setup ? "YOUR WORKSPACE STARTS HERE" : "WELCOME BACK"}
          </span>
          <h2>
            {setup ? "Let’s make this yours." : "A good place to return to."}
          </h2>
          <p>
            {setup
              ? "Create the owner account for this FullPanel server."
              : "Sign in to your FullPanel workspace."}
          </p>
          {session.mode === "demo" && (
            <div className="demo-auth-note">
              Demo workspace · Runtime actions are simulated.
            </div>
          )}
          <form onSubmit={submit}>
            <ErrorBox message={error} />
            {setup && (
              <Field label="Your name">
                <input
                  name="name"
                  autoComplete="name"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={80}
                  placeholder="Alex Morgan"
                />
              </Field>
            )}
            <Field label="Email address">
              <input
                name="email"
                type="email"
                autoComplete="email"
                autoFocus={!setup}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@example.com"
              />
            </Field>
            <Field
              label="Password"
              hint={setup ? "Use at least 12 characters." : undefined}
            >
              <input
                name="password"
                type="password"
                autoComplete={setup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={setup ? 12 : undefined}
                placeholder={
                  setup ? "Make it long and memorable" : "Your password"
                }
              />
            </Field>
            <Button busy={busy} className="auth-submit">
              {setup ? "Create owner account" : "Sign in"}
              <ArrowRight size={17} />
            </Button>
          </form>
          <p className="auth-bottom-note">
            <ShieldCheck size={15} />
            Your server. Your applications. Your data.
          </p>
        </div>
        <span className="auth-version">FULLPANEL / V0.1.0</span>
      </main>
    </div>
  );
}
const nav = [
  { path: "/", label: "Overview", icon: LayoutDashboard },
  { path: "/projects", label: "Projects", icon: Folder },
  { path: "/templates", label: "Templates", icon: Package },
  { path: "/deployments", label: "Deployments", icon: Rocket },
  { path: "/backups", label: "Backups", icon: HardDrive },
  { path: "/activity", label: "Activity", icon: Activity },
];
function CommandPalette({ close }: { close: () => void }) {
  const access = useAccess();
  const [search, setSearch] = useState("");
  const projects = useQuery<Project[]>("/projects");
  const services = useQuery<Service[]>("/services");
  const q = search.toLowerCase();
  const destinations = [
    ...nav,
    { path: "/api-keys", label: "API keys", icon: KeyRound },
    ...(access.isAdmin
      ? [
          { path: "/users", label: "Team & access", icon: Users },
          { path: "/settings", label: "Settings", icon: Settings2 },
        ]
      : []),
  ].filter((i) => i.label.toLowerCase().includes(q));
  const filteredProjects = (projects.data || [])
    .filter((p) => p.name.toLowerCase().includes(q))
    .slice(0, 5);
  const filteredServices = (services.data || [])
    .filter((s) => s.name.toLowerCase().includes(q))
    .slice(0, 7);
  function go(path: string) {
    navigate(path);
    close();
  }
  return (
    <Modal title="Find your way" close={close}>
      <div className="command-search">
        <Search size={19} />
        <input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search projects, services, and pages…"
          aria-label="Search workspace"
        />
      </div>
      <ErrorBox message={projects.error || services.error} />
      <div className="command-results">
        {!!filteredServices.length && (
          <div className="command-group">
            <h3>SERVICES</h3>
            {filteredServices.map((s) => (
              <button key={s.id} onClick={() => go(`/services/${s.id}`)}>
                <ServiceIcon kind={s.kind} size={16} />
                <span>{s.name}</span>
                <small>
                  {projects.data?.find((p) => p.id === s.projectId)?.name}
                </small>
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
        )}
        {!!filteredProjects.length && (
          <div className="command-group">
            <h3>PROJECTS</h3>
            {filteredProjects.map((p) => (
              <button key={p.id} onClick={() => go(`/projects/${p.id}`)}>
                <Folder size={17} />
                <span>{p.name}</span>
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
        )}
        {!!destinations.length && (
          <div className="command-group">
            <h3>GO TO</h3>
            {destinations.map((d) => (
              <button key={d.path} onClick={() => go(d.path)}>
                <d.icon size={17} />
                <span>{d.label}</span>
                <ArrowRight size={14} />
              </button>
            ))}
          </div>
        )}
        {!destinations.length &&
          !filteredProjects.length &&
          !filteredServices.length &&
          !projects.loading &&
          !services.loading && (
            <Empty
              title="No matches"
              description="Try a project, service, or page name."
            />
          )}
      </div>
    </Modal>
  );
}
function Workspace({
  session,
  onLogout,
}: {
  session: Session;
  onLogout: () => void;
}) {
  const access = accessFor(session.user, session.mode);
  const route = useRoute();
  const [mobile, setMobile] = useState(false);
  const [command, setCommand] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const settings = useQuery<Settings>("/settings", 0, access.isAdmin);
  const toast = useToast();
  useEffect(() => {
    setMobile(false);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [route]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommand((old) => !old);
      }
      if (e.key === "Escape") setMobile(false);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  useEffect(() => {
    const listener = () => settings.reload();
    window.addEventListener("harborlight:settings", listener);
    return () => window.removeEventListener("harborlight:settings", listener);
  }, [settings.reload]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const theme = settings.data?.theme || "light";
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.data?.theme]);
  async function logout() {
    setLoggingOut(true);
    try {
      await post("/auth/logout");
      onLogout();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setLoggingOut(false);
    }
  }
  const segments = route.split("/").filter(Boolean);
  const page = segments[0] || "overview";
  const title =
    page === "services" ? "Projects" : page[0].toUpperCase() + page.slice(1);
  const activePath =
    page === "services" ? "/projects" : page === "overview" ? "/" : `/${page}`;
  let content: ReactNode;
  if (page === "overview") content = <Dashboard name={session.user?.name} />;
  else if (page === "projects")
    content = <ProjectsPage projectId={segments[1]} section={segments[2]} />;
  else if (page === "services" && segments[1])
    content = <ServicePage id={segments[1]} tab={segments[2]} />;
  else if (page === "templates") content = <TemplatesPage />;
  else if (page === "deployments")
    content = <DeploymentsPage deploymentId={segments[1]} />;
  else if (page === "backups") content = <BackupsPage />;
  else if (page === "activity") content = <ActivityPage />;
  else if (page === "users") content = <AccountsPage />;
  else if (page === "api-keys") content = <ApiKeysPage />;
  else if (page === "settings")
    content = access.isAdmin ? (
      <SettingsPage />
    ) : (
      <Empty
        title="Administrator access required"
        description="Only administrators can configure this server."
      />
    );
  else
    content = (
      <Empty
        title="This page is off the map"
        description="Head back to your overview to find your way."
        action={<Button onClick={() => navigate("/")}>Go to overview</Button>}
      />
    );
  return (
    <AccessProvider user={session.user} mode={session.mode}>
      <div className="app-shell">
        <a
          className="skip-link"
          href="#main-content"
          onClick={(e) => {
            e.preventDefault();
            document.getElementById("main-content")?.focus();
          }}
        >
          Skip to content
        </a>
        {mobile && (
          <button
            aria-label="Close navigation"
            className="sidebar-scrim"
            onClick={() => setMobile(false)}
          />
        )}
        <aside
          className={`sidebar ${mobile ? "sidebar-open" : ""}`}
          aria-label="Main navigation"
        >
          <div className="sidebar-brand">
            <Brand />
            <IconButton
              label="Close navigation"
              className="mobile-close"
              onClick={() => setMobile(false)}
            >
              <X size={20} />
            </IconButton>
          </div>
          <div className="server-selector">
            <span className="server-selector-icon">
              <Server size={18} />
            </span>
            <div>
              <strong>{settings.data?.serverName || "My workspace"}</strong>
              <small>
                <i />
                {session.mode === "demo"
                  ? "Demo environment"
                  : "Self-hosted workspace"}
              </small>
            </div>
          </div>
          <span className="sidebar-label">WORKSPACE</span>
          <nav>
            {nav.map((n) => (
              <a
                href={`#${n.path}`}
                className={`nav-item ${activePath === n.path ? "active" : ""}`}
                key={n.path}
                aria-current={activePath === n.path ? "page" : undefined}
              >
                <n.icon size={18} />
                <span>{n.label}</span>
                {activePath === n.path && <span className="nav-active-dot" />}
              </a>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <a
              href="#/api-keys"
              className={`nav-item ${activePath === "/api-keys" ? "active" : ""}`}
              aria-current={activePath === "/api-keys" ? "page" : undefined}
            >
              <KeyRound size={18} />
              <span>API keys</span>
            </a>
            {access.isAdmin && (
              <>
                <a
                  href="#/users"
                  className={`nav-item ${activePath === "/users" ? "active" : ""}`}
                  aria-current={activePath === "/users" ? "page" : undefined}
                >
                  <Users size={18} />
                  <span>Team & access</span>
                </a>
                <a
                  href="#/settings"
                  className={`nav-item ${activePath === "/settings" ? "active" : ""}`}
                  aria-current={activePath === "/settings" ? "page" : undefined}
                >
                  <Settings2 size={18} />
                  <span>Settings</span>
                </a>
              </>
            )}
            <div className="open-source-note">
              <span className="open-source-icon">
                <CodeMark />
              </span>
              <p>
                Yours to build on.<small>Open source. Always yours.</small>
              </p>
              <span>↗</span>
            </div>
            <div className="sidebar-user">
              <span className="avatar">
                {(session.user?.name || "O").slice(0, 1).toUpperCase()}
              </span>
              <div>
                <strong>{session.user?.name || "Owner"}</strong>
                <small>
                  {access.user?.role === "owner"
                    ? "Workspace owner"
                    : access.user?.role === "admin"
                      ? "Administrator"
                      : "Workspace member"}
                </small>
              </div>
              <IconButton
                label="Sign out"
                disabled={loggingOut}
                onClick={logout}
              >
                <LogOut size={17} />
              </IconButton>
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div>
              <IconButton
                label="Open navigation"
                className="mobile-menu"
                onClick={() => setMobile(true)}
              >
                <Menu size={20} />
              </IconButton>
              <span className="mobile-product-brand"><Brand compact /></span>
              <span className="topbar-workspace">Workspace</span>
              <ChevronRight size={13} />
              <span>{title}</span>
            </div>
            <div>
              <button
                className="topbar-search"
                onClick={() => setCommand(true)}
                aria-label="Search workspace"
              >
                <Search size={16} />
                <span>Search anything…</span>
                <kbd>⌘ K</kbd>
              </button>
              <span className="topbar-divider" />
              <span className="version-pill">ALPHA 0.1</span>
              <span className="topbar-avatar">
                {(session.user?.name || "O").slice(0, 1).toUpperCase()}
              </span>
            </div>
          </header>
          {session.mode === "demo" && (
            <div className="demo-banner">
              <span>
                <span className="tiny-dot" />
                <strong>Demo workspace</strong> Runtime actions and metrics are
                simulated.
              </span>
              <span>Your changes are saved locally.</span>
            </div>
          )}
          <main className="page-content" id="main-content" tabIndex={-1}>
            {content}
          </main>
        </div>
        {command && <CommandPalette close={() => setCommand(false)} />}
      </div>
    </AccessProvider>
  );
}
function CodeMark() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="m6 5-4 5 4 5m8-10 4 5-4 5m-3-13-2 16"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function AppContent() {
  const session = useQuery<Session>("/auth/session", 30000);
  useEffect(() => {
    const handle = () => session.reload();
    window.addEventListener("harborlight:unauthorized", handle);
    window.addEventListener("harborlight:identity", handle);
    return () => {
      window.removeEventListener("harborlight:unauthorized", handle);
      window.removeEventListener("harborlight:identity", handle);
    };
  }, [session.reload]);
  if (session.loading)
    return (
      <div className="initial-loading">
        <Brand />
        <Loading label="Finding your workspace…" />
      </div>
    );
  if (!session.data)
    return (
      <div className="initial-loading">
        <Brand />
        <ErrorBox message={session.error} retry={session.reload} />
      </div>
    );
  return session.data.authenticated ? (
    <Workspace session={session.data} onLogout={session.reload} />
  ) : (
    <Auth session={session.data} authenticated={session.setData} />
  );
}
export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </ErrorBoundary>
  );
}
