import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMessage, Participant } from "../shared/protocol";
import { PeerMesh, type RemoteParticipant } from "./peerMesh";

class TestStream {
  constructor(private tracks: MediaStreamTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }
}
class TestConnection {
  static instances: TestConnection[] = [];
  connectionState: RTCPeerConnectionState = "new";
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  ontrack: RTCPeerConnection["ontrack"] = null;
  onicecandidate: RTCPeerConnection["onicecandidate"] = null;
  onconnectionstatechange: RTCPeerConnection["onconnectionstatechange"] = null;
  createOffer = vi.fn(async () => ({ type: "offer" as const, sdp: "offer" }));
  createAnswer = vi.fn(async () => ({
    type: "answer" as const,
    sdp: "answer",
  }));
  setLocalDescription = vi.fn(
    async (description: RTCSessionDescriptionInit) => {
      this.localDescription = description;
    },
  );
  setRemoteDescription = vi.fn(
    async (description: RTCSessionDescriptionInit) => {
      this.remoteDescription = description;
    },
  );
  addIceCandidate = vi.fn(async (_candidate?: RTCIceCandidateInit) => {});
  getReceivers = () => [];
  getTransceivers = () => [];
  addTransceiver = () => ({ sender: { replaceTrack: vi.fn(async () => {}) } });
  close = vi.fn(() => {
    this.connectionState = "closed";
  });
  constructor() {
    TestConnection.instances.push(this);
  }
  state(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.call(
      this as unknown as RTCPeerConnection,
      new Event("connectionstatechange"),
    );
  }
}
const participant = (id: string): Participant => ({
  id,
  number: 1,
  media: { audioEnabled: true, videoEnabled: true },
});
const candidate = {
  candidate: "candidate:test",
  sdpMid: "0",
  sdpMLineIndex: 0,
};
const meshes: PeerMesh[] = [];
function mesh() {
  const send = vi.fn<(message: ClientMessage) => void>();
  const changed = vi.fn<(participants: RemoteParticipant[]) => void>();
  const result = new PeerMesh(
    { iceServers: [], iceTransportPolicy: "all" },
    () => new MediaStream(),
    send,
    changed,
  );
  meshes.push(result);
  return { mesh: result, send, changed };
}
async function settled() {
  for (let i = 0; i < 15; i++) await Promise.resolve();
}

beforeEach(() => {
  TestConnection.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal("RTCPeerConnection", TestConnection);
  vi.stubGlobal("MediaStream", TestStream);
});
afterEach(() => {
  meshes.splice(0).forEach((mesh) => mesh.close());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("independent peer lifecycle", () => {
  it("queues early ICE separately and serializes each peer's SDP work without blocking another peer", async () => {
    const { mesh: call, send } = mesh();
    call.add(participant("a"), false);
    call.add(participant("b"), false);
    const [a, b] = TestConnection.instances;
    let release!: () => void;
    a.setRemoteDescription.mockImplementationOnce(async (description) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      a.remoteDescription = description;
    });
    call.receive("a", { type: "candidate", candidate });
    call.receive("a", {
      type: "description",
      description: { type: "offer", sdp: "slow-offer" },
    });
    call.receive("a", { type: "candidate", candidate: null });
    call.receive("b", { type: "candidate", candidate });
    call.receive("b", {
      type: "description",
      description: { type: "offer", sdp: "fast-offer" },
    });
    await settled();
    expect(a.addIceCandidate).not.toHaveBeenCalled();
    expect(b.addIceCandidate).toHaveBeenCalledWith(candidate);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "description", to: "b" }),
    );
    release();
    await settled();
    expect(a.addIceCandidate.mock.calls).toEqual([[candidate], [undefined]]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "description", to: "a" }),
    );
  });

  it("discards a departed participant's pending answer and late ICE without recreating a peer", async () => {
    const { mesh: call, send, changed } = mesh();
    call.add(participant("a"), false);
    const a = TestConnection.instances[0];
    let release!: () => void;
    a.createAnswer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ type: "answer", sdp: "stale-answer" });
        }),
    );
    call.receive("a", {
      type: "description",
      description: { type: "offer", sdp: "offer" },
    });
    await settled();
    call.remove("a");
    call.receive("a", { type: "candidate", candidate });
    release();
    await settled();
    expect(send).not.toHaveBeenCalled();
    expect(a.setLocalDescription).not.toHaveBeenCalled();
    expect(a.close).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenLastCalledWith([]);
    expect(TestConnection.instances).toHaveLength(1);
  });

  it("isolates setup failure and disconnect grace timers from connected peers", async () => {
    const { mesh: call, changed } = mesh();
    call.add(participant("slow"), false);
    call.add(participant("stable"), false);
    const [slow, stable] = TestConnection.instances;
    stable.state("connected");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(slow.close).toHaveBeenCalledOnce();
    expect(stable.close).not.toHaveBeenCalled();
    expect(changed.mock.lastCall![0].map((p) => p.status)).toEqual([
      "failed",
      "connected",
    ]);
    stable.state("disconnected");
    await vi.advanceTimersByTimeAsync(7_999);
    stable.state("connected");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(stable.close).not.toHaveBeenCalled();
    stable.state("disconnected");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(stable.close).toHaveBeenCalledOnce();
  });

  it("a rejected SDP operation fails only that peer", async () => {
    const { mesh: call, changed } = mesh();
    call.add(participant("bad"), false);
    call.add(participant("good"), false);
    const [bad, good] = TestConnection.instances;
    good.state("connected");
    bad.setRemoteDescription.mockRejectedValueOnce(new Error("Rejected SDP"));
    call.receive("bad", {
      type: "description",
      description: { type: "offer", sdp: "invalid" },
    });
    await settled();
    expect(bad.close).toHaveBeenCalledOnce();
    expect(good.close).not.toHaveBeenCalled();
    expect(changed.mock.lastCall![0].map((p) => p.status)).toEqual([
      "failed",
      "connected",
    ]);
  });
});
