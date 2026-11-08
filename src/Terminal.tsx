import { useEffect, useId, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  CircleStop,
  CornerDownLeft,
  Loader2,
  Plug,
  RefreshCw,
  SquareTerminal,
  Unplug,
} from "lucide-react";
import type {
  Service,
  TerminalCapabilities,
  TerminalClientFrame,
  TerminalServerFrame,
  TerminalShell,
} from "../shared/types";
import { useQuery } from "./api";
import { useAccess } from "./Access";
import { Button, Empty, ErrorBox, Field, Loading, Notice, Panel } from "./ui";

type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "exited"
  | "error";
const statusLabels: Record<ConnectionState, string> = {
  idle: "Not connected",
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Disconnected",
  exited: "Shell exited",
  error: "Connection closed",
};
const inputEncoder = new TextEncoder();
const outputBacklogLimit = 512 * 1024;

function decodeOutput(data: string): Uint8Array {
  if (data.length > 48 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
    throw new Error("Invalid terminal output frame.");
  const binary = atob(data);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export default function ServiceTerminal({ service }: { service: Service }) {
  const access = useAccess();
  const allowed = access.canOperate(service.projectId);
  const capabilities = useQuery<TerminalCapabilities>(
    `/services/${service.id}/terminal`,
    10000,
    allowed,
  );
  const [state, setState] = useState<ConnectionState>("idle");
  const [targetId, setTargetId] = useState("main");
  const [shell, setShell] = useState<TerminalShell>("sh");
  const [error, setError] = useState("");
  const [hasSurface, setHasSurface] = useState(false);
  const [dimensions, setDimensions] = useState({ cols: 80, rows: 24 });
  const [exit, setExit] = useState<{ code: number | null; signal?: string }>();
  const host = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const terminal = useRef<XTerm | undefined>(undefined);
  const socket = useRef<WebSocket | undefined>(undefined);
  const disposeTerminal = useRef<() => void>(() => {});
  const sendInput = useRef<(data: string) => void>(() => {});
  const mounted = useRef(true);
  const helpId = useId();
  const selected =
    capabilities.data?.targets.find((target) => target.id === targetId) ||
    capabilities.data?.targets[0];
  const connecting = state === "connecting";
  const connected = state === "connected";
  const active = connecting || connected;

  function clearSurface() {
    disposeTerminal.current();
    disposeTerminal.current = () => {};
    terminal.current = undefined;
    sendInput.current = () => {};
    if (mounted.current) setHasSurface(false);
  }
  function disconnect() {
    const current = socket.current;
    socket.current = undefined;
    if (current?.readyState === WebSocket.OPEN)
      current.send(
        JSON.stringify({ type: "close" } satisfies TerminalClientFrame),
      );
    if (current && current.readyState < WebSocket.CLOSING)
      current.close(1000, "User disconnected");
    clearSurface();
    setError("");
    setExit(undefined);
    setState("disconnected");
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = socket.current;
      socket.current = undefined;
      if (current?.readyState === WebSocket.OPEN)
        current.send(
          JSON.stringify({ type: "close" } satisfies TerminalClientFrame),
        );
      if (current && current.readyState < WebSocket.CLOSING)
        current.close(1000, "Terminal view closed");
      disposeTerminal.current();
      terminal.current = undefined;
      sendInput.current = () => {};
    };
  }, []);

  function connect() {
    if (
      !allowed ||
      active ||
      !capabilities.data?.supported ||
      !capabilities.data.available ||
      !selected ||
      !host.current
    )
      return;
    clearSurface();
    setError("");
    setExit(undefined);
    setState("connecting");
    const cleanups: Array<() => void> = [];
    disposeTerminal.current = () => {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    };
    try {
      const term = new XTerm({
        cols: 80,
        rows: 24,
        scrollback: 1000,
        disableStdin: true,
        fontFamily:
          'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
        fontSize: window.innerWidth < 480 ? 12 : 13,
        lineHeight: 1.35,
        cursorStyle: "bar",
        cursorInactiveStyle: "outline",
        cursorBlink: true,
        screenReaderMode: true,
        logLevel: "off",
        allowProposedApi: false,
        convertEol: false,
        altClickMovesCursor: false,
        minimumContrastRatio: 4.5,
        windowOptions: {},
        theme: {
          background: "#101b33",
          foreground: "#e4eaf5",
          cursor: "#e3a33a",
          cursorAccent: "#101b33",
          selectionBackground: "#344969",
          black: "#1b2923",
          red: "#f4988e",
          green: "#b8dca1",
          yellow: "#e8d19a",
          blue: "#91bdce",
          magenta: "#c9b4da",
          cyan: "#90cdb9",
          white: "#e4ece6",
          brightBlack: "#7c9385",
          brightRed: "#fbb5ae",
          brightGreen: "#e3a33a",
          brightYellow: "#f3dfb2",
          brightBlue: "#b2d6e4",
          brightMagenta: "#dfc8ed",
          brightCyan: "#afe4d2",
          brightWhite: "#ffffff",
        },
      });
      cleanups.push(() => term.dispose());
      const fit = new FitAddon();
      term.loadAddon(fit);
      // Consume terminal-controlled hyperlink/clipboard escapes. No web-links,
      // clipboard, image, or websocket-attach addon is loaded.
      const oscLinks = term.parser.registerOscHandler(8, () => true);
      cleanups.push(() => oscLinks.dispose());
      const oscClipboard = term.parser.registerOscHandler(52, () => true);
      cleanups.push(() => oscClipboard.dispose());
      term.open(host.current);
      term.textarea?.setAttribute("aria-label", "Terminal input");
      term.textarea?.setAttribute("aria-describedby", helpId);
      terminal.current = term;
      setHasSurface(true);
      const url = new URL(
        `/api/services/${service.id}/terminal/socket`,
        window.location.origin,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      socket.current = ws;
      let ready = false,
        ended = false,
        queuedOutput = 0;
      let resizeTimer: number | undefined;
      cleanups.push(() => {
        if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      });
      const current = () => mounted.current && socket.current === ws;

      function fail(message: string) {
        if (!current()) return;
        ended = true;
        ready = false;
        socket.current = undefined;
        if (ws.readyState < WebSocket.CLOSING)
          ws.close(1000, "Terminal client closed");
        clearSurface();
        setState("error");
        setError(message);
      }
      function send(frame: TerminalClientFrame) {
        if (!current() || ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 64 * 1024) {
          fail(
            "The terminal connection is saturated. Reconnect before continuing.",
          );
          return;
        }
        ws.send(JSON.stringify(frame));
      }
      function input(data: string) {
        if (!ready || ended || !current()) return;
        const limit = capabilities.data?.limits.maxInputBytes || 8192;
        if (inputEncoder.encode(data).length > limit) {
          setError(
            `Input exceeds the ${limit.toLocaleString()} byte limit. Nothing was sent; paste a smaller section.`,
          );
          return;
        }
        const frame: TerminalClientFrame = { type: "input", data };
        if (inputEncoder.encode(JSON.stringify(frame)).length > 16 * 1024) {
          setError(
            "This input contains too many escaped characters for one message. Nothing was sent; paste a smaller section.",
          );
          return;
        }
        setError("");
        send(frame);
      }
      sendInput.current = input;
      const onData = term.onData(input);
      cleanups.push(() => onData.dispose());
      const onResize = term.onResize((size) => {
        if (!mounted.current) return;
        setDimensions(size);
        if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => {
          if (ready && !ended)
            send({ type: "resize", cols: term.cols, rows: term.rows });
        }, 150);
      });
      cleanups.push(() => onResize.dispose());
      function fitSurface() {
        if (!host.current || !mounted.current || terminal.current !== term)
          return;
        const size = fit.proposeDimensions();
        if (size)
          term.resize(
            Math.max(20, Math.min(300, size.cols)),
            Math.max(5, Math.min(150, size.rows)),
          );
      }
      const observer = new ResizeObserver(fitSurface);
      cleanups.push(() => observer.disconnect());
      observer.observe(host.current);
      fitSurface();
      term.attachCustomKeyEventHandler((event) => {
        if (
          event.type === "keydown" &&
          event.ctrlKey &&
          event.shiftKey &&
          event.key.toLowerCase() === "m"
        ) {
          event.preventDefault();
          controls.current
            ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
            ?.focus();
          return false;
        }
        return true;
      });
      ws.onopen = () => {
        if (!current()) return;
        fitSurface();
        send({
          type: "open",
          target: selected.id,
          shell,
          cols: term.cols,
          rows: term.rows,
        });
      };
      ws.onmessage = (event) => {
        if (!current() || ended) return;
        let frame: TerminalServerFrame;
        try {
          if (typeof event.data !== "string" || event.data.length > 64 * 1024)
            throw new Error();
          frame = JSON.parse(event.data) as TerminalServerFrame;
          if (!frame || typeof frame !== "object") throw new Error();
          if (frame.type === "ready") {
            if (
              ready ||
              typeof frame.sessionId !== "string" ||
              frame.target !== selected.id ||
              frame.shell !== shell
            )
              throw new Error();
            ready = true;
            term.options.disableStdin = false;
            setState("connected");
            setDimensions({ cols: term.cols, rows: term.rows });
            term.focus();
          } else if (frame.type === "output") {
            if (!ready || typeof frame.data !== "string") throw new Error();
            const bytes = decodeOutput(frame.data);
            if (queuedOutput + bytes.length > outputBacklogLimit) {
              fail(
                "Terminal output exceeded the display buffer. Reconnect to continue.",
              );
              return;
            }
            queuedOutput += bytes.length;
            term.write(bytes, () => {
              queuedOutput = Math.max(0, queuedOutput - bytes.length);
            });
          } else if (frame.type === "exit") {
            if (
              (frame.code !== null && !Number.isInteger(frame.code)) ||
              (frame.signal !== undefined && typeof frame.signal !== "string")
            )
              throw new Error();
            ended = true;
            ready = false;
            term.options.disableStdin = true;
            term.blur();
            socket.current = undefined;
            if (ws.readyState === WebSocket.OPEN)
              ws.close(1000, "Shell exited");
            setExit({
              code: frame.code,
              ...(frame.signal ? { signal: frame.signal } : {}),
            });
            setState("exited");
          } else if (
            frame.type === "error" &&
            typeof frame.message === "string"
          ) {
            fail(frame.message.slice(0, 1000));
          } else throw new Error();
        } catch {
          fail(
            "The terminal received an invalid response. Reconnect to start a new session.",
          );
        }
      };
      ws.onerror = () =>
        fail(
          "The terminal connection failed. Check your session and the running container, then reconnect.",
        );
      ws.onclose = (event) => {
        if (!current()) return;
        ready = false;
        ended = true;
        if (event.code !== 1000) {
          fail(
            event.code === 1008
              ? "Terminal access or session limits changed. Reconnect if you still have operator access."
              : "The terminal connection was interrupted. Reconnect to start a new session.",
          );
        } else {
          socket.current = undefined;
          term.options.disableStdin = true;
          term.blur();
          setState("disconnected");
        }
      };
    } catch {
      const current = socket.current;
      socket.current = undefined;
      if (current && current.readyState < WebSocket.CLOSING)
        current.close(1000, "Terminal initialization failed");
      clearSurface();
      setState("error");
      setError(
        "The terminal could not initialize. Refresh the page and connect again.",
      );
    }
  }

  function changeSelection() {
    clearSurface();
    setExit(undefined);
    setError("");
    setState("idle");
  }
  if (!allowed)
    return (
      <Notice>Interactive terminals are available to project operators.</Notice>
    );
  return (
    <Panel
      title="Container terminal"
      description="Open an interactive shell in a running service container."
      actions={
        <Button variant="ghost" disabled={active} onClick={capabilities.reload}>
          <RefreshCw size={15} />
          Refresh targets
        </Button>
      }
    >
      <ErrorBox
        message={capabilities.error || error}
        retry={capabilities.error ? capabilities.reload : undefined}
      />
      {capabilities.loading ? (
        <Loading label="Loading terminal availability" />
      ) : capabilities.data && !capabilities.data.supported ? (
        <Empty
          icon={<SquareTerminal size={27} />}
          title="Terminal unavailable"
          description={
            capabilities.data.reason ||
            "Interactive shells are unavailable in demo mode."
          }
        />
      ) : (
        capabilities.data && (
          <>
            {!capabilities.data.available && (
              <div className="terminal-unavailable">
                <Notice>
                  {capabilities.data.reason ||
                    "Start a managed container to connect."}
                </Notice>
              </div>
            )}
            <div className="terminal-controls" ref={controls}>
              <Field label="Container">
                <select
                  value={selected?.id || ""}
                  disabled={active || !capabilities.data.targets.length}
                  onChange={(event) => {
                    setTargetId(event.target.value);
                    changeSelection();
                  }}
                >
                  {!capabilities.data.targets.length && (
                    <option value="">No running containers</option>
                  )}
                  {capabilities.data.targets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Shell"
                hint="The shell must be installed in this container."
              >
                <select
                  value={shell}
                  disabled={active}
                  onChange={(event) => {
                    setShell(event.target.value as TerminalShell);
                    changeSelection();
                  }}
                >
                  {capabilities.data.shells.map((value) => (
                    <option value={value} key={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </Field>
              {active ? (
                <Button variant="secondary" onClick={disconnect}>
                  <Unplug size={16} />
                  {connecting ? "Cancel connection" : "Disconnect"}
                </Button>
              ) : (
                <Button
                  disabled={!capabilities.data.available || !selected}
                  onClick={connect}
                >
                  <Plug size={16} />
                  Connect terminal
                </Button>
              )}
            </div>
            <div className="interactive-terminal">
              <div className="terminal-session-bar">
                <span
                  className={`terminal-connection state-${state}`}
                  role="status"
                >
                  <i />
                  {statusLabels[state]}
                </span>
                <span>
                  {active
                    ? `${selected?.name || service.name} · ${shell}`
                    : "Container shell"}
                </span>
                <code aria-label="Terminal dimensions">
                  {dimensions.cols} × {dimensions.rows}
                </code>
              </div>
              <div className="terminal-screen">
                <div
                  className={`terminal-surface ${hasSurface ? "has-session" : ""}`}
                  ref={host}
                  onKeyDown={(event) => event.stopPropagation()}
                />
                {!hasSurface && (
                  <div className="terminal-placeholder">
                    <span>
                      <SquareTerminal size={29} />
                    </span>
                    <h3>
                      {state === "error"
                        ? "Session closed"
                        : state === "disconnected"
                          ? "Disconnected"
                          : "A shell, when you need it"}
                    </h3>
                    <p>
                      Choose a container and shell, then connect. Closing this
                      view ends the terminal session.
                    </p>
                  </div>
                )}
                {connecting && (
                  <div className="terminal-opening" role="status">
                    <Loader2 size={18} className="spin" />
                    Opening the container shell…
                  </div>
                )}
              </div>
              <div className="terminal-toolbar">
                <div>
                  <Button
                    variant="ghost"
                    disabled={!connected}
                    onClick={() => {
                      sendInput.current("\u0003");
                      terminal.current?.focus();
                    }}
                  >
                    <CircleStop size={14} />
                    Ctrl+C
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={!connected}
                    onClick={() => {
                      sendInput.current("\u0004");
                      terminal.current?.focus();
                    }}
                  >
                    <CornerDownLeft size={14} />
                    Ctrl+D
                  </Button>
                </div>
                <span>
                  {exit
                    ? `Exit ${exit.code === null ? "unknown" : exit.code}${exit.signal ? ` · ${exit.signal}` : ""}`
                    : "1,000 lines of local scrollback"}
                </span>
              </div>
            </div>
            <div className="terminal-footnotes">
              <p id={helpId}>
                Ctrl+C interrupts · Ctrl+D exits · Ctrl+Shift+M focuses terminal
                controls.
              </p>
              <p>
                Idle limit{" "}
                {Math.round(capabilities.data.limits.idleSeconds / 60)} min ·
                Session limit{" "}
                {Math.round(capabilities.data.limits.lifetimeSeconds / 60)} min.
                FullPanel does not save terminal input or output.
              </p>
            </div>
          </>
        )
      )}
    </Panel>
  );
}
