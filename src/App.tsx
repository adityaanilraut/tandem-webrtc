import { useEffect, useState, type FormEvent } from "react";
import { Link, Route, Routes, useNavigate } from "react-router-dom";
import { ArrowRight, LoaderCircle, Video } from "lucide-react";
import { ROOM_ID, type AppConfig } from "../shared/protocol";
import { requestJson } from "./api";
import { Modal, Notice, useCreateCall } from "./appUi";
import { RoomRoute } from "./Room";

function Header({ onHelp }: { onHelp: () => void }) {
  return (
    <header className="site-header">
      <Link className="brand" to="/" aria-label="Tandem home">
        <span className="brand-mark" aria-hidden="true">
          <i />
          <i />
        </span>
        tandem
      </Link>
      <button className="text-button" onClick={onHelp}>
        Help
      </button>
    </header>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Start a call" onClose={onClose}>
      <ol className="help-steps">
        <li>
          <strong>Create or open a call</strong>
          <p>Start a new call, or open the invite someone shared with you.</p>
        </li>
        <li>
          <strong>Choose your camera and mic</strong>
          <p>
            Choose your camera and mic settings when opening an invite, then tap
            Join call. Allow access to the devices you want to use.
          </p>
        </li>
        <li>
          <strong>Share the link</strong>
          <p>
            Send the call link to up to three people. They can join from the
            invite in their browser.
          </p>
        </li>
      </ol>
      <p className="help-note">
        On a phone, open the secure invite in Safari or Chrome. Keep the browser
        open and your screen awake during the call.
      </p>
      <button className="button primary full" onClick={onClose}>
        Got it
      </button>
    </Modal>
  );
}

function Home({ config }: { config: AppConfig | null }) {
  const navigate = useNavigate();
  const { createCall, creating, error } = useCreateCall();
  const [invite, setInvite] = useState("");
  const [inviteError, setInviteError] = useState("");

  function openInvite(event: FormEvent) {
    event.preventDefault();
    setInviteError("");
    try {
      const url = new URL(invite.trim(), location.origin);
      const match = /^\/room\/([^/]+)\/?$/.exec(url.pathname);
      if (
        !match ||
        !ROOM_ID.test(match[1]) ||
        url.username ||
        url.password ||
        !["https:", "http:"].includes(url.protocol)
      )
        throw new Error();
      if (
        url.origin !== location.origin &&
        url.origin !== config?.inviteOrigin
      ) {
        setInviteError(
          "This link belongs to another server. Open the original invite directly.",
        );
        return;
      }
      navigate(`/room/${match[1]}`);
    } catch {
      setInviteError("Enter a valid Tandem call link.");
    }
  }

  return (
    <main className="home-main">
      <div className="home-heading">
        <h1>
          A little closer.
          <br />A lot simpler.
        </h1>
        <p>
          Video calls for up to four.
          <br />
          Just a link and your people.
        </p>
      </div>
      <section className="start-panel" aria-label="Start or join a call">
        <button
          className="button primary full create-button"
          onClick={createCall}
          disabled={creating}
        >
          {creating ? (
            <LoaderCircle size={20} className="spin" />
          ) : (
            <Video size={20} />
          )}
          {creating ? "Creating call…" : "Create a call"}
        </button>
        {error && <Notice>{error}</Notice>}
        <div className="form-divider">
          <span>or join an existing call</span>
        </div>
        <form onSubmit={openInvite} className="invite-form">
          <label className="field-label" htmlFor="invite-link">
            Call link
          </label>
          <div className="invite-input">
            <input
              id="invite-link"
              type="text"
              inputMode="url"
              value={invite}
              onChange={(event) => {
                setInvite(event.target.value);
                setInviteError("");
              }}
              placeholder="Paste your invite link"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!inviteError}
              aria-describedby={inviteError ? "invite-error" : undefined}
              required
            />
            <button className="button secondary" type="submit">
              Join <ArrowRight size={16} />
            </button>
          </div>
          {inviteError && (
            <p className="field-error" id="invite-error" role="alert">
              {inviteError}
            </p>
          )}
        </form>
      </section>
      <p className="home-note">No account. No download.</p>
    </main>
  );
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    requestJson<AppConfig>("/api/config", { signal: controller.signal })
      .then(setConfig)
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return (
    <div className="app-shell">
      <Header onHelp={() => setHelp(true)} />
      <Routes>
        <Route path="/" element={<Home config={config} />} />
        <Route
          path="/room/:roomId"
          element={<RoomRoute config={config} onHelp={() => setHelp(true)} />}
        />
        <Route
          path="/room/*"
          element={<RoomRoute config={config} onHelp={() => setHelp(true)} />}
        />
        <Route
          path="*"
          element={
            <main className="empty-panel">
              <h1>Page not found</h1>
              <p>Let’s get you back to your next call.</p>
              <Link className="button primary" to="/">
                Back to home <ArrowRight size={18} />
              </Link>
            </main>
          }
        />
      </Routes>
      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  );
}
