import { useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { MAX_DISPLAY_NAME_LENGTH } from "../shared/protocol";
import { Modal, Notice } from "./appUi";
import type { useCall } from "./useCall";

export function DeviceSettings({
  call,
  onClose,
}: {
  call: ReturnType<typeof useCall>;
  onClose: () => void;
}) {
  const [name, setName] = useState(call.name);
  const cameras = call.devices.filter(
    (device) => device.kind === "videoinput" && device.deviceId,
  );
  const microphones = call.devices.filter(
    (device) => device.kind === "audioinput" && device.deviceId,
  );
  const videoId = call.localStream?.getVideoTracks()[0]?.getSettings().deviceId;
  const audioId = call.localStream?.getAudioTracks()[0]?.getSettings().deviceId;
  return (
    <Modal title="Camera & microphone" onClose={onClose}>
      <label className="field-label" htmlFor="camera-select">
        Camera
      </label>
      <div className="select-wrap">
        <select
          id="camera-select"
          value={videoId ?? ""}
          disabled={
            call.busy ||
            !call.canCapture ||
            !cameras.length ||
            (Boolean(videoId) && cameras.length < 2)
          }
          onChange={(event) =>
            void call.switchDevice("video", event.target.value)
          }
        >
          {!videoId && (
            <option value="" disabled>
              Camera off
            </option>
          )}
          {cameras.length ? (
            cameras.map((device, i) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Camera ${i + 1}`}
              </option>
            ))
          ) : (
            <option>Default camera</option>
          )}
        </select>
        <ChevronDown size={16} />
      </div>
      {call.isIPhone && (
        <button
          className="button secondary full flip-button"
          disabled={call.busy || !call.canCapture}
          onClick={() => void call.switchDevice("video", "", true)}
        >
          <RefreshCw size={17} /> Switch camera
        </button>
      )}
      <label className="field-label" htmlFor="microphone-select">
        Microphone
      </label>
      <div className="select-wrap">
        <select
          id="microphone-select"
          value={audioId ?? ""}
          disabled={
            call.busy ||
            !call.canCapture ||
            !microphones.length ||
            (Boolean(audioId) && microphones.length < 2)
          }
          onChange={(event) =>
            void call.switchDevice("audio", event.target.value)
          }
        >
          {!audioId && (
            <option value="" disabled>
              Microphone off
            </option>
          )}
          {microphones.length ? (
            microphones.map((device, i) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Microphone ${i + 1}`}
              </option>
            ))
          ) : (
            <option>Default microphone</option>
          )}
        </select>
        <ChevronDown size={16} />
      </div>
      <p className="help-note">
        {call.busy
          ? "Switching device…"
          : "Sound plays through your device’s selected speaker or headphones."}
      </p>
      {call.notice && <Notice>{call.notice}</Notice>}
      <form
        className="call-profile"
        onSubmit={(event) => {
          event.preventDefault();
          call.rename(name);
          onClose();
        }}
      >
        <label className="field-label" htmlFor="call-display-name">
          Display name <span>(optional)</span>
        </label>
        <input
          id="call-display-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          autoComplete="off"
        />
        <button className="button primary full" type="submit">
          Done
        </button>
      </form>
    </Modal>
  );
}
