import type {
  CallIceConfig,
  ClientMessage,
  MediaState,
  Participant,
  Signal,
} from "../shared/protocol";

export type RemoteParticipant = Participant & {
  stream: MediaStream | null;
  status: "connecting" | "connected" | "disconnected" | "failed";
};
type Peer = {
  participant: RemoteParticipant;
  connection: RTCPeerConnection;
  senders: Map<string, RTCRtpSender>;
  candidates: (RTCIceCandidateInit | null)[];
  messages: Promise<void>;
  timeout?: ReturnType<typeof setTimeout>;
  disconnect?: ReturnType<typeof setTimeout>;
};

// One connection and one ordered SDP/ICE queue per remote participant.
export class PeerMesh {
  private peers = new Map<string, Peer>();

  constructor(
    private config: CallIceConfig,
    private localStream: () => MediaStream | null,
    private send: (message: ClientMessage) => void,
    private changed: (participants: RemoteParticipant[]) => void,
  ) {}

  private publish() {
    this.changed(
      [...this.peers.values()].map((peer) => ({ ...peer.participant })),
    );
  }

  private active(peer: Peer) {
    return (
      this.peers.get(peer.participant.id) === peer &&
      peer.participant.status !== "failed"
    );
  }

  private release(peer: Peer) {
    clearTimeout(peer.timeout);
    clearTimeout(peer.disconnect);
    peer.timeout = peer.disconnect = undefined;
    const pc = peer.connection;
    pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null;
    pc.getReceivers().forEach((receiver) => receiver.track?.stop());
    pc.close();
    peer.candidates = [];
  }

  fail(id: string) {
    const peer = this.peers.get(id);
    if (!peer || !this.active(peer)) return;
    peer.participant.status = "failed";
    peer.participant.stream = null;
    this.release(peer);
    this.publish();
  }

  add(participant: Participant, initiator: boolean) {
    if (this.peers.has(participant.id)) return;
    const connection = new RTCPeerConnection(this.config);
    const peer: Peer = {
      participant: { ...participant, stream: null, status: "connecting" },
      connection,
      senders: new Map(),
      candidates: [],
      messages: Promise.resolve(),
    };
    this.peers.set(participant.id, peer);
    // Negotiate both kinds even when either local device starts off.
    if (initiator) {
      const tracks = this.localStream()?.getTracks() ?? [];
      for (const kind of ["audio", "video"] as const) {
        const track = tracks.find((track) => track.kind === kind);
        const { sender } = connection.addTransceiver(track ?? kind, {
          direction: "sendrecv",
        });
        peer.senders.set(kind, sender);
      }
    }
    const incoming = new MediaStream();
    connection.ontrack = ({ track }) => {
      if (!this.active(peer)) return;
      if (!incoming.getTracks().some((t) => t.id === track.id))
        incoming.addTrack(track);
      peer.participant.stream = new MediaStream(incoming.getTracks());
      this.publish();
    };
    connection.onicecandidate = ({ candidate }) => {
      if (this.active(peer))
        this.send({
          type: "candidate",
          to: participant.id,
          candidate: candidate?.toJSON() ?? null,
        });
    };
    connection.onconnectionstatechange = () => {
      if (!this.active(peer)) return;
      switch (connection.connectionState) {
        case "connected":
          clearTimeout(peer.timeout);
          clearTimeout(peer.disconnect);
          peer.timeout = peer.disconnect = undefined;
          peer.participant.status = "connected";
          this.publish();
          break;
        case "disconnected":
          peer.participant.status = "disconnected";
          peer.disconnect ??= setTimeout(
            () => this.fail(participant.id),
            8_000,
          );
          this.publish();
          break;
        case "failed":
        case "closed":
          this.fail(participant.id);
          break;
      }
    };
    peer.timeout = setTimeout(() => this.fail(participant.id), 25_000);
    this.publish();
    if (initiator)
      this.enqueue(peer, async () => {
        const offer = await connection.createOffer();
        if (!this.active(peer)) return;
        await connection.setLocalDescription(offer);
        if (this.active(peer))
          this.send({
            type: "description",
            to: participant.id,
            description: connection.localDescription!,
          });
      });
  }

  private enqueue(peer: Peer, operation: () => Promise<void>) {
    peer.messages = peer.messages
      .then(async () => {
        if (this.active(peer)) await operation();
      })
      .catch(() => {
        if (this.active(peer)) this.fail(peer.participant.id);
      });
  }

  receive(from: string, signal: Signal) {
    const peer = this.peers.get(from);
    // Signals in flight when a participant leaves must not recreate that participant.
    if (!peer || !this.active(peer)) return;
    this.enqueue(peer, async () => {
      const pc = peer.connection;
      if (signal.type === "candidate") {
        if (pc.remoteDescription)
          await pc.addIceCandidate(signal.candidate ?? undefined);
        else peer.candidates.push(signal.candidate);
        return;
      }
      await pc.setRemoteDescription(signal.description);
      if (!this.active(peer)) return;
      for (const candidate of peer.candidates) {
        await pc.addIceCandidate(candidate ?? undefined);
        if (!this.active(peer)) return;
      }
      peer.candidates = [];
      if (signal.description.type === "offer") {
        const tracks = this.localStream()?.getTracks() ?? [];
        const attach = pc.getTransceivers().map((transceiver) => {
          // Use the transceivers created by the offer so the answer can send too.
          const kind = transceiver.receiver.track.kind;
          const track = tracks.find((track) => track.kind === kind);
          transceiver.direction = "sendrecv";
          peer.senders.set(kind, transceiver.sender);
          return track ? transceiver.sender.replaceTrack(track) : undefined;
        });
        await Promise.all(attach);
        if (!this.active(peer)) return;
        const answer = await pc.createAnswer();
        if (!this.active(peer)) return;
        await pc.setLocalDescription(answer);
        if (this.active(peer))
          this.send({
            type: "description",
            to: from,
            description: pc.localDescription!,
          });
      }
    });
  }

  media(id: string, media: MediaState) {
    const peer = this.peers.get(id);
    if (peer) {
      peer.participant.media = media;
      this.publish();
    }
  }

  rename(id: string, name: string) {
    const peer = this.peers.get(id);
    if (peer) {
      peer.participant.name = name || undefined;
      this.publish();
    }
  }

  async replaceTrack(kind: "audio" | "video", track: MediaStreamTrack | null) {
    // The caller publishes the new local stream before this snapshot. A peer joining
    // during replacement therefore starts with the new track as well.
    const failed: string[] = [];
    await Promise.all(
      [...this.peers.values()].map(async (peer) => {
        const sender = peer.senders.get(kind);
        if (!sender || !this.active(peer)) return;
        try {
          await sender.replaceTrack(track);
        } catch {
          if (this.active(peer)) failed.push(peer.participant.id);
        }
      }),
    );
    return failed;
  }

  remove(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    this.release(peer);
    this.publish();
  }

  close() {
    for (const peer of this.peers.values()) this.release(peer);
    this.peers.clear();
  }
}
