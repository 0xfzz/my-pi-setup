// The login gate: renders the app only once the browser holds a session (or the server has
// no password). It owns the sign-in screen and tells the rest of the app, through context,
// whether signing out is a thing.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { getAuth } from "./auth.ts";

type Phase = "checking" | "open" | "login" | "offline" | "unavailable";

interface AuthContextValue {
  /** The server asks for a password, so a sign-out control makes sense. */
  required: boolean;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue>({ required: false, signOut: () => undefined });

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

function useCountdown(seconds: number): [number, (next: number) => void] {
  const [remaining, setRemaining] = useState(seconds);
  useEffect(() => {
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [remaining]);
  return [remaining, setRemaining];
}

function LoginScreen({ notice, onSignedIn }: { notice: string | null; onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [wait, setWait] = useCountdown(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (busy || wait > 0 || password === "") return;
    setBusy(true);
    setError(null);
    const result = await getAuth().login(password);
    setBusy(false);
    if (result.ok) {
      setPassword("");
      onSignedIn();
      return;
    }
    setError(result.error);
    if (result.retryAfterSeconds !== undefined) setWait(result.retryAfterSeconds);
    setPassword("");
    input.current?.focus();
  };

  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={(event) => void submit(event)}>
        <h1 className="auth-title">
          pi <span className="auth-title-dim">web</span>
        </h1>
        <p className="auth-lede">This pi-web is password protected.</p>
        {notice !== null ? <p className="auth-notice">{notice}</p> : null}
        {/* A username field lets password managers recognise and save the login. */}
        <input type="text" name="username" autoComplete="username" value="pi-web" readOnly hidden />
        <label className="auth-label" htmlFor="auth-password">
          Password
        </label>
        <input
          id="auth-password"
          ref={input}
          className="auth-input"
          type="password"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={busy}
        />
        {error !== null ? (
          <p className="auth-error" role="alert">
            {error}
            {wait > 0 ? ` Try again in ${wait}s.` : ""}
          </p>
        ) : null}
        <button className="auth-submit" type="submit" disabled={busy || wait > 0 || password === ""}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [required, setRequired] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const check = useCallback(async (): Promise<void> => {
    const auth = getAuth();
    setPhase("checking");
    try {
      const status = await auth.status();
      setRequired(status.required);
      if (status.unavailable === true) {
        setPhase("unavailable");
      } else if (!status.required || status.authenticated) {
        setPhase("open");
      } else {
        // The access cookie lapsed but a refresh cookie may still be good: sign back in silently.
        const outcome = await auth.refresh();
        if (outcome === "ok") setPhase("open");
        else if (outcome === "unavailable") setPhase("offline");
        else {
          // A first visit, not an ended session: no "sign in again" notice.
          setNotice(null);
          setPhase("login");
        }
      }
    } catch {
      setPhase("offline");
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(
    () =>
      getAuth().onLost((reason) => {
        setNotice(reason === "expired" ? "Your session ended. Sign in again." : null);
        setRequired(true);
        setPhase("login");
      }),
    [],
  );

  const value = useMemo<AuthContextValue>(
    () => ({ required, signOut: () => void getAuth().logout() }),
    [required],
  );

  if (phase === "open") return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
  if (phase === "login") {
    return (
      <LoginScreen
        notice={notice}
        onSignedIn={() => {
          setNotice(null);
          setPhase("open");
        }}
      />
    );
  }
  return (
    <main className="auth-screen">
      <div className="auth-card">
        <h1 className="auth-title">
          pi <span className="auth-title-dim">web</span>
        </h1>
        {phase === "checking" ? <p className="auth-lede">Connecting…</p> : null}
        {phase === "offline" ? (
          <>
            <p className="auth-error">Cannot reach the server.</p>
            <button className="auth-submit" type="button" onClick={() => void check()}>
              Retry
            </button>
          </>
        ) : null}
        {phase === "unavailable" ? (
          <p className="auth-error">
            The password file on the server is unreadable, so it is refusing all requests. Run /web set-password in pi to fix it.
          </p>
        ) : null}
      </div>
    </main>
  );
}
