import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_DISPLAY_NAME_LENGTH,
  type CallIceConfig,
  type ClientMessage,
  type MediaState,
  type ServerMessage,
} from "../shared/protocol";
import { HttpError, requestJson } from "./api";
import { PeerMesh, type RemoteParticipant } from "./peerMesh";

export type Phase =
  | "preflight"
  | "joining"
  | "waiting"
  | "connecting"
  | "connected"
  | "ended"
  | "error";
type DeviceKind = "audio" | "video";
export const defaultMedia: MediaState = {
  audioEnabled: true,
  videoEnabled: true,
};
const labels = { audio: "microphone", video: "camera" } as const;
const mediaKeys = { audio: "audioEnabled", video: "videoEnabled" } as const;
const kinds = ["audio", "video"] as const;

function constraints(kind: DeviceKind): MediaTrackConstraints {
  return kind === "audio"
    ? { echoCancellation: true, noiseSuppression: true }
    : {
        facingMode: { ideal: "user" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 },
      };
}

function deviceError(kind: DeviceKind, error: unknown) {
  const device = labels[kind];
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError")
      return `Access to your ${device} was blocked. Check your browser’s site permissions.`;
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError")
      return `That ${device} is unavailable. Check the device or choose another in Settings.`;
    if (error.name === "NotReadableError" || error.name === "AbortError")
      return `Your ${device} may be in use by another app. Close that app and try again.`;
  }
  return `Couldn’t use that ${device}. Check the device and try again.`;
}

function release(track?: MediaStreamTrack) {
  if (!track) return;
  track.onended = null;
  track.stop();
}

function cleanName(name: string) {
  return name
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH);
}

export function useCall(roomId: string) {
  const [phase, setPhase] = useState<Phase>("preflight");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [participants, setParticipants] = useState<RemoteParticipant[]>([]);
  const [participantId, setParticipantId] = useState<string | null>(null);
  const [activity, setActivity] = useState("");
  const [media, setMedia] = useState(defaultMedia);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [canRetry, setCanRetry] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [name, setName] = useState("");
  const streamRef = useRef<MediaStream | null>(null);
  const meshRef = useRef<PeerMesh | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const mediaChoice = useRef(defaultMedia);
  const displayName = useRef("");
  const generation = useRef(0);
  const mediaBusy = useRef(false);
  const joiningRef = useRef(false);
  const iceRequest = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const canCapture =
    window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);
  const isIPhone =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  const send = useCallback((message: ClientMessage) => {
    if (socketRef.current?.readyState === WebSocket.OPEN)
      socketRef.current.send(JSON.stringify(message));
  }, []);

  const cleanup = useCallback((leave = false) => {
    generation.current++;
    clearTimeout(timeoutRef.current);
    iceRequest.current?.abort();
    iceRequest.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      if (leave && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "leave" }));
      socket.close();
    }
    meshRef.current?.close();
    meshRef.current = null;
    streamRef.current?.getTracks().forEach(release);
    streamRef.current = null;
    mediaBusy.current = false;
    joiningRef.current = false;
  }, []);

  const finish = useCallback(
    (
      next: "ended" | "error",
      message: string,
      retry = false,
      leave = false,
    ) => {
      cleanup(leave);
      setLocalStream(null);
      setParticipants([]);
      setParticipantId(null);
      setActivity("");
      setBusy(false);
      setNotice(message);
      setCanRetry(retry);
      setPhase(next);
    },
    [cleanup],
  );

  const enumerate = useCallback(async () => {
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch {
      /* Capture can still use the default devices. */
    }
  }, []);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    mediaDevices?.addEventListener("devicechange", enumerate);
    const onPageHide = () => {
      if (streamRef.current || joiningRef.current)
        finish(
          "error",
          "This tab left the call. You can rejoin from here.",
          true,
        );
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      mediaDevices?.removeEventListener("devicechange", enumerate);
      window.removeEventListener("pagehide", onPageHide);
      cleanup();
    };
  }, [cleanup, enumerate, finish]);

  const inConversation = phase === "connected";
  useEffect(() => {
    if (!inConversation) return;
    const start = Date.now();
    setElapsed(0);
    const interval = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(interval);
  }, [inConversation]);

  const publishMedia = useCallback(() => {
    const enabled = (track?: MediaStreamTrack) =>
      track?.readyState === "live" && track.enabled;
    const state = {
      audioEnabled: enabled(streamRef.current?.getAudioTracks()[0]),
      videoEnabled: enabled(streamRef.current?.getVideoTracks()[0]),
    };
    mediaChoice.current = state;
    setMedia(state);
    send({ type: "media-state", ...state });
  }, [send]);

  const setTrack = useCallback((kind: DeviceKind, track?: MediaStreamTrack) => {
    const tracks =
      streamRef.current
        ?.getTracks()
        .filter((existing) => existing.kind !== kind) ?? [];
    if (track) tracks.push(track);
    const stream = new MediaStream(tracks);
    streamRef.current = stream;
    return stream;
  }, []);

  const watchTrack = useCallback(
    (track: MediaStreamTrack, kind: DeviceKind) => {
      track.onended = () => {
        if (!streamRef.current?.getTracks().includes(track)) return;
        release(track);
        setLocalStream(setTrack(kind));
        void meshRef.current?.replaceTrack(kind, null);
        publishMedia();
        setNotice(
          `Your ${labels[kind]} stopped. Turn it on again or choose another in Settings.`,
        );
      };
    },
    [publishMedia, setTrack],
  );

  const start = useCallback(
    async (choice = mediaChoice.current, name = displayName.current) => {
      if (joiningRef.current || socketRef.current) return;
      joiningRef.current = true;
      mediaChoice.current = choice;
      displayName.current = cleanName(name);
      setName(displayName.current);
      setPhase("joining");
      setNotice("");
      const attempt = generation.current;
      const active = () => attempt === generation.current;
      let ice: CallIceConfig;
      const controller = new AbortController();
      iceRequest.current = controller;
      try {
        if (typeof RTCPeerConnection !== "function")
          throw new Error(
            "This browser doesn’t support calls. Try opening the invite in Safari or Chrome.",
          );
        ice = await requestJson<CallIceConfig>(`/api/rooms/${roomId}/ice`, {
          signal: controller.signal,
        });
        if (!Array.isArray(ice.iceServers))
          throw new Error(
            "The call connection settings are unavailable. Try again shortly.",
          );
      } catch (error) {
        if (active())
          finish(
            "error",
            error instanceof Error
              ? error.message
              : "Couldn’t prepare the call.",
            !(error instanceof HttpError && error.status === 404),
          );
        return;
      } finally {
        if (iceRequest.current === controller) iceRequest.current = null;
      }
      if (!active()) return;

      const unavailable: string[] = [];
      const capture = async (audio: boolean, video: boolean) => {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: audio && constraints("audio"),
          video: video && constraints("video"),
        });
        for (const track of stream.getTracks()) {
          if (!active() || track.readyState !== "live") {
            release(track);
            continue;
          }
          const kind = track.kind as DeviceKind;
          watchTrack(track, kind);
          setTrack(kind, track);
        }
      };
      streamRef.current = new MediaStream();
      if (canCapture) {
        const requested = kinds.filter((kind) => choice[mediaKeys[kind]]);
        if (requested.length === 2) {
          try {
            await capture(true, true);
          } catch {
            /* Retry each kind below. */
          }
        }
        for (const kind of requested) {
          if (!active()) return;
          if (
            streamRef.current?.getTracks().some((track) => track.kind === kind)
          )
            continue;
          try {
            await capture(kind === "audio", kind === "video");
            if (
              !streamRef.current
                ?.getTracks()
                .some((track) => track.kind === kind)
            )
              unavailable.push(deviceError(kind, undefined));
          } catch (error) {
            unavailable.push(deviceError(kind, error));
          }
        }
      } else if (choice.audioEnabled || choice.videoEnabled) {
        unavailable.push(
          "Open a secure invite link to use your microphone or camera.",
        );
      }
      if (!active()) return;
      setLocalStream(streamRef.current);
      publishMedia();
      setNotice(unavailable.join(" "));
      void enumerate();

      let socket: WebSocket;
      try {
        socket = new WebSocket(
          `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`,
        );
      } catch {
        finish(
          "error",
          "Couldn’t open the call connection. Try again shortly.",
          true,
        );
        return;
      }
      socketRef.current = socket;
      timeoutRef.current = setTimeout(
        () =>
          finish(
            "error",
            "The call server didn’t respond. Try joining again.",
            true,
          ),
        12_000,
      );
      socket.onopen = () =>
        send({
          type: "join",
          roomId,
          ...mediaChoice.current,
          name: displayName.current,
        });
      socket.onclose = socket.onerror = () => {
        if (active())
          finish("error", "Your connection to the call was interrupted.", true);
      };
      const mesh = new PeerMesh(
        ice,
        () => streamRef.current,
        send,
        (peers) => {
          if (!active()) return;
          setParticipants(peers);
          setPhase(
            peers.some((p) => p.status === "connected")
              ? "connected"
              : peers.length
                ? "connecting"
                : "waiting",
          );
        },
      );
      meshRef.current = mesh;
      socket.onmessage = (event) => {
        if (!active()) return;
        try {
          const message = JSON.parse(event.data) as ServerMessage;
          switch (message.type) {
            case "joined":
              clearTimeout(timeoutRef.current);
              joiningRef.current = false;
              setParticipantId(message.participantId);
              setPhase("waiting");
              for (const participant of message.participants)
                mesh.add(participant, false);
              break;
            case "peer-joined":
              setActivity(
                `${message.participant.name ?? `Participant ${message.participant.number}`} joined the call.`,
              );
              mesh.add(message.participant, true);
              break;
            case "peer-left":
              setActivity(
                "A participant left the call. Their slot is available.",
              );
              mesh.remove(message.participantId);
              break;
            case "description":
            case "candidate":
              mesh.receive(message.from, message);
              break;
            case "media-state":
              mesh.media(message.participantId, {
                audioEnabled: message.audioEnabled,
                videoEnabled: message.videoEnabled,
              });
              break;
            case "display-name":
              mesh.rename(message.participantId, message.name);
              break;
            case "ended":
              finish(
                "ended",
                message.reason === "server-stopped"
                  ? "The call server stopped."
                  : "You left the call.",
              );
              break;
            case "error":
              // A signal can race with departure. Keep unrelated connections open.
              if (message.peerId) {
                if (message.code !== "PEER_NOT_FOUND")
                  mesh.fail(message.peerId);
              } else
                finish(
                  "error",
                  message.message,
                  message.code !== "ROOM_NOT_FOUND",
                );
              break;
          }
        } catch {
          if (active())
            finish(
              "error",
              "We couldn’t read the call server’s response.",
              true,
            );
        }
      };
    },
    [
      canCapture,
      enumerate,
      finish,
      publishMedia,
      roomId,
      send,
      setTrack,
      watchTrack,
    ],
  );

  async function switchDevice(kind: DeviceKind, selection = "", flip = false) {
    if (
      mediaBusy.current ||
      joiningRef.current ||
      !streamRef.current ||
      !canCapture
    )
      return;
    const previous = streamRef.current
      .getTracks()
      .find((track) => track.kind === kind);
    const settings = previous?.getSettings();
    const enabled = previous?.enabled ?? true;
    const attempt = generation.current;
    const active = () => attempt === generation.current;
    const mesh = meshRef.current;
    mediaBusy.current = true;
    setBusy(true);
    setNotice("");

    async function capture(constraint: MediaTrackConstraints) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: kind === "audio" && constraint,
        video: kind === "video" && constraint,
      });
      const track = stream.getTracks()[0];
      if (!track) throw new Error("No replacement track");
      if (!active()) {
        release(track);
        return;
      }
      track.enabled = enabled;
      setTrack(kind, track);
      const failed = await mesh?.replaceTrack(kind, track);
      if (!active()) {
        release(previous);
        release(track);
        return;
      }
      if (failed?.length || track.readyState !== "live") {
        const previousLive =
          previous?.readyState === "live" ? previous : undefined;
        setLocalStream(setTrack(kind, previousLive));
        const rollbackFailed = await mesh?.replaceTrack(
          kind,
          previousLive ?? null,
        );
        release(track);
        rollbackFailed?.forEach((id) => mesh?.fail(id));
        throw new Error("Replacement failed");
      }
      release(previous);
      watchTrack(track, kind);
      setLocalStream(streamRef.current);
      publishMedia();
      void enumerate();
    }

    try {
      // Some Apple devices can open only one camera at a time.
      if (kind === "video" && isIPhone) release(previous);
      const constraint = constraints(kind);
      if (flip)
        constraint.facingMode = {
          ideal:
            settings?.facingMode === "environment" ? "user" : "environment",
        };
      if (selection) {
        constraint.deviceId = { exact: selection };
        delete constraint.facingMode;
      }
      await capture(constraint);
    } catch (error) {
      if (!active()) return;
      if (previous?.readyState === "ended") {
        try {
          await capture({
            ...constraints(kind),
            ...(settings?.deviceId
              ? { deviceId: { exact: settings.deviceId } }
              : {}),
            ...(settings?.facingMode
              ? { facingMode: { ideal: settings.facingMode } }
              : {}),
          });
        } catch {
          if (!active()) return;
          setLocalStream(setTrack(kind));
          void mesh?.replaceTrack(kind, null);
        }
      }
      if (active()) {
        publishMedia();
        const restored = streamRef.current
          ?.getTracks()
          .some((track) => track.kind === kind && track.readyState === "live");
        setNotice(
          `${deviceError(kind, error)}${restored ? " Your previous device is still selected." : " You can keep the call open and try again."}`,
        );
      }
    } finally {
      if (active()) {
        mediaBusy.current = false;
        setBusy(false);
      }
    }
  }

  function toggle(kind: DeviceKind) {
    if (mediaBusy.current || joiningRef.current) return;
    const track = streamRef.current
      ?.getTracks()
      .find((track) => track.kind === kind);
    if (!track || track.readyState !== "live") {
      void switchDevice(kind);
      return;
    }
    track.enabled = !track.enabled;
    publishMedia();
  }

  function rejoin() {
    const socket = socketRef.current;
    if (!socket) {
      void start();
      return;
    }
    finish("error", "", true);
    setPhase("joining");
    const attempt = generation.current;
    const retry = () => {
      socket.removeEventListener("close", retry);
      if (attempt !== generation.current) return;
      clearTimeout(timeoutRef.current);
      void start();
    };
    socket.addEventListener("close", retry, { once: true });
    timeoutRef.current = setTimeout(retry, 1_000);
  }

  function rename(name: string) {
    const next = cleanName(name);
    if (next === displayName.current) return;
    displayName.current = next;
    setName(next);
    send({ type: "display-name", name: next });
  }

  return {
    phase,
    localStream,
    participants,
    participantId,
    activity,
    media,
    devices,
    busy,
    notice,
    elapsed,
    isIPhone,
    canCapture,
    canRetry,
    start,
    toggle,
    switchDevice,
    rejoin,
    name,
    rename,
    hangUp: () => finish("ended", "You left the call.", false, true),
  };
}
