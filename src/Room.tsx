import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import {
  Check,
  Copy,
  Link2,
  LoaderCircle,
  Mic,
  MicOff,
  Phone,
  Settings2,
  Share2,
  UsersRound,
  Video,
  VideoOff,
} from "lucide-react";
import {
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PARTICIPANTS,
  ROOM_ID,
  type AppConfig,
} from "../shared/protocol";
import { HttpError, requestJson } from "./api";
import { Notice, useCreateCall } from "./appUi";
import { DeviceSettings } from "./DeviceSettings";
import { defaultMedia, useCall } from "./useCall";

function VideoView({
  stream,
  muted = false,
  mirror = false,
  label,
}: {
  stream: MediaStream | null;
  muted?: boolean;
  mirror?: boolean;
  label: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let active = true;
    video.srcObject = stream;
    if (stream)
      video
        .play()
        .then(() => {
          if (active) setBlocked(false);
        })
        .catch(() => {
          if (active) setBlocked(true);
        });
    return () => {
      active = false;
      video.srcObject = null;
    };
  }, [stream]);
  return (
    <>
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        className={mirror ? "mirrored" : ""}
        aria-label={label}
      />
      {blocked && (
        <button
          className="play-fallback button primary"
          onClick={() => {
            void ref.current
              ?.play()
              .then(() => setBlocked(false))
              .catch(() => setBlocked(true));
          }}
        >
          Tap to play {muted ? "video" : "video & audio"}
        </button>
      )}
    </>
  );
}

function CallControls({
  call,
  onSettings,
}: {
  call: ReturnType<typeof useCall>;
  onSettings: () => void;
}) {
  return (
    <div className="call-controls" role="group" aria-label="Call controls">
      <button
        className={`control ${!call.media.audioEnabled ? "off" : ""}`}
        onClick={() => call.toggle("audio")}
        disabled={!call.participantId || !call.canCapture || call.busy}
        aria-label={
          call.media.audioEnabled ? "Mute microphone" : "Unmute microphone"
        }
        title={
          call.media.audioEnabled ? "Mute microphone" : "Unmute microphone"
        }
        aria-pressed={!call.media.audioEnabled}
      >
        {call.media.audioEnabled ? <Mic size={19} /> : <MicOff size={19} />}
        <span className="control-label">Mic</span>
      </button>
      <button
        className={`control ${!call.media.videoEnabled ? "off" : ""}`}
        onClick={() => call.toggle("video")}
        disabled={!call.participantId || !call.canCapture || call.busy}
        aria-label={
          call.media.videoEnabled ? "Turn camera off" : "Turn camera on"
        }
        title={call.media.videoEnabled ? "Turn camera off" : "Turn camera on"}
        aria-pressed={!call.media.videoEnabled}
      >
        {call.media.videoEnabled ? <Video size={19} /> : <VideoOff size={19} />}
        <span className="control-label">Camera</span>
      </button>
      <button
        className="control"
        onClick={onSettings}
        disabled={!call.participantId || call.busy}
        aria-label="Camera and microphone settings"
        title="Camera and microphone settings"
      >
        <Settings2 size={19} />
        <span className="control-label">Settings</span>
      </button>
      <button
        className="button leave-button"
        onClick={call.hangUp}
        aria-label="Leave call"
      >
        <Phone size={19} /> Leave
      </button>
    </div>
  );
}

function Placeholder({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="stage-placeholder">
      <span className="placeholder-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

function ShareInvite({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shareAvailable = typeof navigator.share === "function";
  useEffect(() => () => clearTimeout(timer.current), []);

  async function share() {
    if (shareAvailable) {
      try {
        await navigator.share({ title: "Tandem call", url: value });
        setManual(false);
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError")
          return;
      }
    }
    try {
      await navigator.clipboard.writeText(value);
      setManual(false);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2500);
    } catch {
      setManual(true);
    }
  }

  return (
    <div className="copy-invite">
      <button className="button secondary" onClick={() => void share()}>
        {copied ? (
          <Check size={17} />
        ) : shareAvailable ? (
          <Share2 size={17} />
        ) : (
          <Copy size={17} />
        )}
        {copied ? "Copied" : shareAvailable ? "Share link" : "Copy link"}
      </button>
      {manual && (
        <div className="copy-fallback">
          <input
            aria-label="Invite link"
            value={value}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <p role="status">Select the link and copy it.</p>
        </div>
      )}
      <span className="sr-only" role="status">
        {copied ? "Invite link copied to clipboard." : ""}
      </span>
    </div>
  );
}

function JoinForm({ call }: { call: ReturnType<typeof useCall> }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [name, setName] = useState("");
  const [choice, setChoice] = useState(
    call.canCapture
      ? defaultMedia
      : { audioEnabled: false, videoEnabled: false },
  );
  useEffect(() => heading.current?.focus(), []);

  function join(event: FormEvent) {
    event.preventDefault();
    void call.start(choice, name);
  }

  return (
    <main className="empty-panel join-room">
      <span className="empty-icon">
        <Video size={26} />
      </span>
      <h1 ref={heading} tabIndex={-1}>
        Join a call
      </h1>
      <form className="join-form" onSubmit={join}>
        <label className="field-label" htmlFor="join-name">
          Display name <span>(optional)</span>
        </label>
        <input
          id="join-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          autoComplete="off"
        />
        <div className="join-devices" role="group" aria-label="Join with">
          <label>
            <input
              type="checkbox"
              checked={choice.audioEnabled}
              disabled={!call.canCapture}
              onChange={(event) =>
                setChoice({ ...choice, audioEnabled: event.target.checked })
              }
            />{" "}
            Microphone
          </label>
          <label>
            <input
              type="checkbox"
              checked={choice.videoEnabled}
              disabled={!call.canCapture}
              onChange={(event) =>
                setChoice({ ...choice, videoEnabled: event.target.checked })
              }
            />{" "}
            Camera
          </label>
        </div>
        {!call.canCapture && (
          <p>
            Open a secure invite to use your microphone or camera. You can join
            to listen here.
          </p>
        )}
        <button className="button primary full" type="submit">
          <Video size={18} /> Join call
        </button>
      </form>
      <Link className="back-link" to="/">
        Back to home
      </Link>
    </main>
  );
}

type RoomStatus =
  { available: true } | { available: false; message: string; retry: boolean };

function Room({
  roomId,
  config,
  onHelp,
}: {
  roomId: string;
  config: AppConfig | null;
  onHelp: () => void;
}) {
  const { createCall, creating, error } = useCreateCall();
  const location = useLocation();
  const navigate = useNavigate();
  const autoStart = useRef(location.state?.startCreatedCall === true);
  const [validation, setValidation] = useState<RoomStatus | null>(null);
  const [check, setCheck] = useState(0);
  const [settings, setSettings] = useState(false);
  const call = useCall(roomId);
  const startCall = call.start;
  const terminal = call.phase === "ended" || call.phase === "error";
  const invite = `${config?.inviteOrigin || window.location.origin}/room/${roomId}`;
  const cameraFacing = call.localStream
    ?.getVideoTracks()[0]
    ?.getSettings().facingMode;

  useEffect(() => {
    if (!ROOM_ID.test(roomId)) {
      setValidation({
        available: false,
        message:
          "This invite link is invalid. Ask for a new link or create a call.",
        retry: false,
      });
      return;
    }
    const controller = new AbortController();
    requestJson(`/api/rooms/${roomId}`, { signal: controller.signal })
      .then(() => {
        if (!controller.signal.aborted) setValidation({ available: true });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setValidation({
          available: false,
          message:
            error instanceof Error
              ? error.message
              : "Couldn’t check this invite.",
          retry: !(error instanceof HttpError && error.status === 404),
        });
      });
    return () => controller.abort();
  }, [check, roomId]);

  useEffect(() => {
    if (!validation?.available || !autoStart.current) return;
    autoStart.current = false;
    navigate(location.pathname, { replace: true, state: null });
    void startCall();
  }, [location.pathname, navigate, startCall, validation]);

  if (
    !validation ||
    (call.phase === "preflight" && validation.available && autoStart.current)
  )
    return (
      <main className="empty-panel" aria-live="polite">
        <LoaderCircle size={24} className="spin" />
        <p>Opening call…</p>
      </main>
    );

  if (!validation.available || terminal) {
    const unavailable = !validation.available;
    const retry = unavailable ? validation.retry : call.canRetry;
    return (
      <main className="empty-panel">
        <span className="empty-icon">
          {call.phase === "ended" ? <Phone size={26} /> : <Link2 size={26} />}
        </span>
        <h1>
          {unavailable
            ? "Call unavailable"
            : call.phase === "ended"
              ? "Call ended"
              : "Couldn’t connect"}
        </h1>
        <p role={call.phase === "ended" ? "status" : "alert"}>
          {unavailable ? validation.message : call.notice}
        </p>
        {retry && (
          <button
            className="button primary"
            onClick={() => {
              if (unavailable) {
                setValidation(null);
                setCheck((value) => value + 1);
              } else {
                setSettings(false);
                call.rejoin();
              }
            }}
          >
            {unavailable ? "Try again" : "Rejoin this call"}
          </button>
        )}
        <button
          className={`button ${retry ? "secondary" : "primary"}`}
          onClick={createCall}
          disabled={creating}
        >
          {creating ? (
            <LoaderCircle size={18} className="spin" />
          ) : (
            <Video size={18} />
          )}
          {creating ? "Creating call…" : "Create a new call"}
        </button>
        {error && <Notice>{error}</Notice>}
        <Link className="back-link" to="/">
          Back to home
        </Link>
      </main>
    );
  }

  if (call.phase === "preflight") return <JoinForm call={call} />;

  const joining = call.phase === "joining";
  const connecting = call.phase === "connecting" || joining;
  const allFailed =
    call.participants.length > 0 &&
    call.participants.every((p) => p.status === "failed");
  const status = allFailed
    ? "Connection issue"
    : call.phase === "connected"
      ? "Connected"
      : connecting
        ? "Connecting…"
        : "Waiting for someone to join";
  return (
    <main className="room-main in-session">
      <div className="room-heading">
        <h1>Your call</h1>
        <div className="room-status">
          <span
            className={`status-dot ${call.phase === "connected" ? "connected" : ""}`}
          />
          <span role="status">{status}</span>
          <span className="participant-count" aria-label="Participants">
            <UsersRound size={15} />{" "}
            {(call.participantId ? 1 : 0) + call.participants.length} /{" "}
            {MAX_PARTICIPANTS}
          </span>
          {call.phase === "connected" && (
            <time aria-label="Call duration">
              {String(Math.floor(call.elapsed / 60)).padStart(2, "0")}:
              {String(call.elapsed % 60).padStart(2, "0")}
            </time>
          )}
        </div>
      </div>
      <div className="video-panel">
        <section
          className={`video-stage ${call.participants.length ? "group-stage" : ""}`}
          aria-label="Call participants"
          data-count={call.participants.length + 1}
        >
          {!call.participants.length && (
            <Placeholder
              icon={
                connecting ? (
                  <LoaderCircle size={29} className="spin" />
                ) : (
                  <UsersRound size={29} strokeWidth={1.5} />
                )
              }
              title={connecting ? "Connecting…" : "Waiting for people to join"}
            >
              {joining
                ? "Allow access if your browser asks for your microphone or camera."
                : connecting
                  ? "Getting your call ready."
                  : "Share the invite with up to three people."}
            </Placeholder>
          )}
          {call.localStream && (
            <div
              className={
                call.participants.length
                  ? "participant-tile local-tile"
                  : "self-view"
              }
              data-participant-id={call.participantId ?? undefined}
              aria-label="You"
            >
              {call.localStream.getVideoTracks().length > 0 && (
                <VideoView
                  stream={call.localStream}
                  muted
                  mirror={cameraFacing !== "environment"}
                  label="Your local video"
                />
              )}
              {!call.media.videoEnabled && (
                <div className="self-cover">
                  <VideoOff size={26} />
                  <span>Camera off</span>
                </div>
              )}
              <span className="video-label">
                {call.media.audioEnabled ? (
                  <Mic size={14} />
                ) : (
                  <MicOff size={14} />
                )}{" "}
                You
                {!call.media.audioEnabled && <span>· Mic off</span>}
              </span>
            </div>
          )}
          {call.participants.map((participant) => {
            const name =
              participant.name ?? `Participant ${participant.number}`;
            return (
              <div
                className="participant-tile"
                key={participant.id}
                data-participant-id={participant.id}
                data-status={participant.status}
                aria-label={name}
              >
                {participant.stream && (
                  <VideoView
                    stream={participant.stream}
                    label={`${name}’s video`}
                  />
                )}
                {(!participant.stream ||
                  !participant.media.videoEnabled ||
                  participant.status !== "connected") && (
                  <Placeholder
                    icon={
                      participant.status === "connecting" ? (
                        <LoaderCircle size={24} className="spin" />
                      ) : (
                        <VideoOff size={24} />
                      )
                    }
                    title={
                      participant.status === "failed"
                        ? "Couldn’t connect to this person"
                        : participant.status === "disconnected"
                          ? "Connection interrupted"
                          : participant.status === "connecting"
                            ? "Connecting…"
                            : "Camera off"
                    }
                  >
                    {participant.status === "failed"
                      ? "Rejoin the call to try again."
                      : participant.status === "disconnected"
                        ? "Waiting for their connection to return…"
                        : participant.status === "connecting"
                          ? "Getting their video and audio ready."
                          : participant.media.audioEnabled
                            ? "Audio only"
                            : "Microphone off"}
                  </Placeholder>
                )}
                <span className="video-label">
                  {participant.media.audioEnabled ? (
                    <Mic size={14} />
                  ) : (
                    <MicOff size={14} />
                  )}
                  <span className="participant-name">{name}</span>
                  {!participant.media.audioEnabled && <span>· Mic off</span>}
                </span>
              </div>
            );
          })}
        </section>
        <div className="call-toolbar">
          <CallControls call={call} onSettings={() => setSettings(true)} />
          {call.participantId && <ShareInvite value={invite} />}
        </div>
      </div>
      <p className="sr-only" role="status">
        {call.activity}
      </p>
      {call.participants.some((p) => p.status === "failed") && (
        <div className="retry-call">
          <button className="button secondary" onClick={call.rejoin}>
            Rejoin this call
          </button>
          {allFailed && config?.turnConfigured === false && (
            <p className="room-note">
              If rejoining still fails, ask the person running Tandem to enable
              a call relay.
            </p>
          )}
        </div>
      )}
      {call.notice && <Notice>{call.notice}</Notice>}
      {config && !config.httpsReady && (
        <p className="room-note">
          Joining from a phone? Use a secure invite link.{" "}
          <button className="text-button" onClick={onHelp}>
            Get help
          </button>
        </p>
      )}
      {call.isIPhone && (
        <p className="room-note">
          Keep Safari open and your screen awake during the call.
        </p>
      )}
      {settings && (
        <DeviceSettings call={call} onClose={() => setSettings(false)} />
      )}
    </main>
  );
}

export function RoomRoute({
  config,
  onHelp,
}: {
  config: AppConfig | null;
  onHelp: () => void;
}) {
  const { roomId = "" } = useParams();
  return <Room key={roomId} roomId={roomId} config={config} onHelp={onHelp} />;
}
