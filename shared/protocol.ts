export type MediaState = { audioEnabled: boolean; videoEnabled: boolean };
export type Participant = {
  id: string;
  number: number;
  media: MediaState;
  name?: string;
};
export const MAX_PARTICIPANTS = 4;
export const MAX_DISPLAY_NAME_LENGTH = 32;

export type Signal =
  | { type: "description"; description: RTCSessionDescriptionInit }
  | { type: "candidate"; candidate: RTCIceCandidateInit | null };

export type ClientMessage =
  | ({ type: "join"; roomId: string; name?: string } & MediaState)
  | (Signal & { to: string })
  | ({ type: "media-state" } & MediaState)
  | { type: "display-name"; name: string }
  | { type: "leave" };

export type ServerMessage =
  | { type: "joined"; participantId: string; participants: Participant[] }
  | { type: "peer-joined"; participant: Participant }
  | { type: "peer-left"; participantId: string }
  | (Signal & { from: string })
  | ({ type: "media-state"; participantId: string } & MediaState)
  | { type: "display-name"; participantId: string; name: string }
  | { type: "ended"; reason: "left" | "server-stopped" }
  | { type: "error"; code: string; message: string; peerId?: string };

export type RoomResponse = { roomId: string; invitePath: string };
export type AppConfig = {
  inviteOrigin: string;
  httpsReady: boolean;
  publicAccess: boolean;
  turnConfigured: boolean;
};
export type CallIceConfig = {
  iceServers: RTCIceServer[];
  iceTransportPolicy: RTCIceTransportPolicy;
};

export const ROOM_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
