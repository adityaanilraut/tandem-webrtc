import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { isIP, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  ROOM_ID,
  MAX_PARTICIPANTS,
  MAX_DISPLAY_NAME_LENGTH,
  type Participant as ParticipantInfo,
  type ClientMessage,
  type ServerMessage,
  type CallIceConfig,
} from "../shared/protocol";
import { serveFrontend } from "./frontend";
import { createIceProvider } from "./ice";

type Participant = ParticipantInfo & { socket: WebSocket };
type Room = { id: string; expiresAt: number; participants: Participant[] };
type Options = {
  origins: Set<string>;
  inviteOrigin: string;
  httpsReady?: boolean;
  publicAccess?: boolean;
  turnConfigured?: boolean;
  iceConfiguration?: () => Promise<CallIceConfig>;
  staticDirectory?: string;
  roomTtlMs?: number;
  reconnectGraceMs?: number;
  cleanupIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxRooms?: number;
  clientIpHeader?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_DISPLAY_NAME_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "join":
      return (
        typeof value.roomId === "string" &&
        ROOM_ID.test(value.roomId) &&
        (value.name === undefined || validName(value.name)) &&
        typeof value.audioEnabled === "boolean" &&
        typeof value.videoEnabled === "boolean"
      );
    case "leave":
      return true;
    case "display-name":
      return validName(value.name);
    case "media-state":
      return (
        typeof value.audioEnabled === "boolean" &&
        typeof value.videoEnabled === "boolean"
      );
    case "description":
      return (
        typeof value.to === "string" &&
        ROOM_ID.test(value.to) &&
        isRecord(value.description) &&
        (value.description.type === "offer" ||
          value.description.type === "answer") &&
        typeof value.description.sdp === "string"
      );
    case "candidate": {
      const c = value.candidate;
      return (
        typeof value.to === "string" &&
        ROOM_ID.test(value.to) &&
        (c === null ||
          (isRecord(c) &&
            typeof c.candidate === "string" &&
            (c.sdpMid === undefined ||
              c.sdpMid === null ||
              typeof c.sdpMid === "string") &&
            (c.sdpMLineIndex === undefined ||
              c.sdpMLineIndex === null ||
              (Number.isInteger(c.sdpMLineIndex) &&
                Number(c.sdpMLineIndex) >= 0)) &&
            (c.usernameFragment === undefined ||
              c.usernameFragment === null ||
              typeof c.usernameFragment === "string")))
      );
    }
    default:
      return false;
  }
}

export function createSignalingServer(options: Options) {
  const rooms = new Map<string, Room>();
  const membership = new Map<WebSocket, Room>();
  const alive = new Set<WebSocket>();
  const iceRequests = new Map<string, { count: number; reset: number }>();
  const roomRequests = new Map<string, { count: number; reset: number }>();
  const connectionsByIp = new Map<string, number>();
  const defaultIce = createIceProvider({});
  const ttl = options.roomTtlMs ?? 10 * 60_000;
  const reconnectGrace = options.reconnectGraceMs ?? 60_000;
  const clientIpHeader = options.clientIpHeader?.toLowerCase();
  const clientIp = (request: IncomingMessage) => {
    const forwarded = clientIpHeader && request.headers[clientIpHeader];
    return typeof forwarded === "string" && isIP(forwarded)
      ? forwarded
      : request.socket.remoteAddress ?? "unknown";
  };
  const send = (socket: WebSocket, message: ServerMessage) => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  };
  const error = (
    socket: WebSocket,
    code: string,
    message: string,
    peerId?: string,
  ) =>
    send(socket, {
      type: "error",
      code,
      message,
      ...(peerId ? { peerId } : {}),
    });
  const participantInfo = ({
    id,
    number,
    media,
    name,
  }: Participant): ParticipantInfo => ({
    id,
    number,
    media,
    ...(name ? { name } : {}),
  });
  const fullMessage =
    "This call is full (4 people maximum). Ask someone to leave, then try again.";

  function endRoom(
    room: Room,
    reason: Extract<ServerMessage, { type: "ended" }>["reason"],
  ) {
    rooms.delete(room.id);
    iceRequests.delete(room.id);
    // Remove every membership before closing sockets, so close events are idempotent.
    for (const { socket } of room.participants) membership.delete(socket);
    for (const { socket } of room.participants) {
      send(socket, { type: "ended", reason });
      socket.close(1000, reason);
    }
    room.participants = [];
  }

  function removeParticipant(socket: WebSocket, left = false) {
    const room = membership.get(socket);
    if (!room) return;
    membership.delete(socket);
    const participant = room.participants.find((p) => p.socket === socket)!;
    room.participants = room.participants.filter((p) => p !== participant);
    for (const peer of room.participants)
      send(peer.socket, { type: "peer-left", participantId: participant.id });
    if (!room.participants.length) {
      if (left) {
        rooms.delete(room.id);
        iceRequests.delete(room.id);
      } else {
        room.expiresAt = Date.now() + reconnectGrace;
      }
    }
  }

  function getRoom(id: string) {
    const room = rooms.get(id);
    if (
      room &&
      room.participants.length === 0 &&
      Date.now() >= room.expiresAt
    ) {
      rooms.delete(id);
      iceRequests.delete(id);
      return undefined;
    }
    return room;
  }

  const httpServer = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader(
      "Permissions-Policy",
      "camera=(self), microphone=(self), geolocation=()",
    );
    const json = (status: number, body: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(body));
    };
    if (
      request.headers.origin &&
      !options.origins.has(request.headers.origin)
    ) {
      json(403, { message: "This origin is not allowed." });
      return;
    }
    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      json(400, { message: "Invalid request URL." });
      return;
    }
    if (request.method === "GET" && path === "/api/config") {
      json(200, {
        inviteOrigin: options.inviteOrigin,
        httpsReady: options.httpsReady ?? false,
        publicAccess: options.publicAccess ?? false,
        turnConfigured: options.turnConfigured ?? false,
      });
    } else if (request.method === "GET" && path === "/api/health") {
      json(200, { ok: true });
    } else if (request.method === "POST" && path === "/api/rooms") {
      if (options.publicAccess) {
        const ip = clientIp(request);
        let limit = roomRequests.get(ip);
        if (!limit || Date.now() >= limit.reset) {
          limit = { count: 0, reset: Date.now() + 60_000 };
          roomRequests.set(ip, limit);
        }
        if (++limit.count > 12) {
          response.setHeader(
            "Retry-After",
            Math.ceil((limit.reset - Date.now()) / 1000),
          );
          json(429, {
            message: "Too many calls created. Wait a minute and try again.",
          });
          return;
        }
      }
      if (rooms.size >= (options.maxRooms ?? 100)) {
        json(503, {
          message:
            "There are too many open rooms. Please try again in a moment.",
        });
        return;
      }
      const id = randomUUID();
      rooms.set(id, { id, expiresAt: Date.now() + ttl, participants: [] });
      json(201, { roomId: id, invitePath: `/room/${id}` });
    } else if (
      request.method === "GET" &&
      /^\/api\/rooms\/[^/]+\/ice$/.test(path)
    ) {
      const id = path.split("/")[3];
      const room = ROOM_ID.test(id) ? getRoom(id) : undefined;
      if (!room) {
        json(404, {
          message: "This call has ended or the invite has expired.",
        });
        return;
      }
      if (room.participants.length >= MAX_PARTICIPANTS) {
        json(409, { message: fullMessage });
        return;
      }
      let limit = iceRequests.get(id);
      if (!limit || Date.now() >= limit.reset) {
        limit = { count: 0, reset: Date.now() + 60_000 };
        iceRequests.set(id, limit);
      }
      if (++limit.count > 10) {
        json(429, {
          message: "Please wait a minute before trying to join again.",
        });
        return;
      }
      try {
        const config = await (
          options.iceConfiguration ?? defaultIce.getConfiguration
        )();
        // A room may end while a remote TURN provider is issuing credentials.
        if (!getRoom(id)) {
          json(404, { message: "This call has ended." });
          return;
        }
        json(200, config);
      } catch {
        json(503, {
          message: "The call relay is unavailable. Please try again shortly.",
        });
      }
    } else if (request.method === "GET" && path.startsWith("/api/rooms/")) {
      const id = path.slice("/api/rooms/".length);
      const room = ROOM_ID.test(id) ? getRoom(id) : undefined;
      if (!room)
        json(404, {
          message:
            "This call has ended or the invite has expired. Create a new call to get started.",
        });
      else if (room.participants.length >= MAX_PARTICIPANTS)
        json(409, {
          message: fullMessage,
        });
      else
        json(200, { available: true, participants: room.participants.length });
    } else if (
      options.staticDirectory &&
      (await serveFrontend(request, response, options.staticDirectory, path))
    ) {
      // The public server exposes only the built frontend, never source or certificates.
    } else json(404, { message: "Not found." });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  httpServer.on("upgrade", (request, socket, head) => {
    if (
      request.url !== "/ws" ||
      !request.headers.origin ||
      !options.origins.has(request.headers.origin)
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const ip = clientIp(request);
    const connections = connectionsByIp.get(ip) ?? 0;
    if (options.publicAccess && (connections >= 16 || wss.clients.size >= 512)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket as Socket, head, (ws) => {
      if (options.publicAccess) {
        connectionsByIp.set(ip, connections + 1);
        ws.once("close", () => {
          const remaining = (connectionsByIp.get(ip) ?? 1) - 1;
          if (remaining) connectionsByIp.set(ip, remaining);
          else connectionsByIp.delete(ip);
        });
      }
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket) => {
    alive.add(socket);
    const joinDeadline = setTimeout(() => {
      if (!membership.has(socket)) socket.close(1008, "Join a room first");
    }, 10_000);
    joinDeadline.unref();
    socket.on("pong", () => alive.add(socket));
    socket.on("error", () => {
      removeParticipant(socket);
    });
    socket.on("close", () => {
      clearTimeout(joinDeadline);
      alive.delete(socket);
      removeParticipant(socket);
    });
    socket.on("message", (raw, isBinary) => {
      let message: unknown;
      try {
        message = isBinary ? null : JSON.parse(raw.toString());
      } catch {
        message = null;
      }
      if (!validMessage(message)) {
        error(socket, "BAD_MESSAGE", "The signaling message is invalid.");
        return;
      }
      if (message.type === "join") {
        if (membership.has(socket)) {
          error(socket, "ALREADY_JOINED", "You have already joined a call.");
          return;
        }
        const room = getRoom(message.roomId);
        if (!room) {
          error(
            socket,
            "ROOM_NOT_FOUND",
            "This call has ended or the invite has expired.",
          );
          return;
        }
        if (room.participants.length >= MAX_PARTICIPANTS) {
          error(socket, "ROOM_FULL", fullMessage);
          return;
        }
        clearTimeout(joinDeadline);
        const existing = [...room.participants];
        const participant: Participant = {
          id: randomUUID(),
          number: [1, 2, 3, 4].find(
            (n) => !existing.some((p) => p.number === n),
          )!,
          socket,
          name: message.name?.trim() || undefined,
          media: {
            audioEnabled: message.audioEnabled,
            videoEnabled: message.videoEnabled,
          },
        };
        room.participants.push(participant);
        membership.set(socket, room);
        // The newcomer answers each existing participant. Only existing members offer.
        send(socket, {
          type: "joined",
          participantId: participant.id,
          participants: existing.map(participantInfo),
        });
        for (const peer of existing)
          send(peer.socket, {
            type: "peer-joined",
            participant: participantInfo(participant),
          });
        return;
      }
      const room = membership.get(socket);
      if (!room) {
        error(socket, "NOT_JOINED", "Join a room before sending signals.");
        return;
      }
      if (message.type === "leave") {
        removeParticipant(socket, true);
        send(socket, { type: "ended", reason: "left" });
        socket.close(1000, "left");
        return;
      }
      const sender = room.participants.find((p) => p.socket === socket)!;
      if (message.type === "display-name") {
        const name = message.name.trim();
        if (name === (sender.name ?? "")) return;
        sender.name = name || undefined;
        for (const peer of room.participants)
          if (peer !== sender)
            send(peer.socket, {
              type: "display-name",
              participantId: sender.id,
              name,
            });
        return;
      }
      if (message.type === "media-state") {
        sender.media = {
          audioEnabled: message.audioEnabled,
          videoEnabled: message.videoEnabled,
        };
        for (const peer of room.participants)
          if (peer !== sender)
            send(peer.socket, {
              type: "media-state",
              participantId: sender.id,
              ...sender.media,
            });
        return;
      }
      // A recipient must still belong to this socket's room. Never trust a client-supplied sender.
      const peer = room.participants.find(
        (p) => p.id === message.to && p !== sender,
      );
      if (!peer) {
        error(
          socket,
          "PEER_NOT_FOUND",
          "That participant is no longer in this call.",
          message.to,
        );
        return;
      }
      if (message.type === "description") {
        const expected =
          room.participants.indexOf(sender) < room.participants.indexOf(peer)
            ? "offer"
            : "answer";
        if (message.description.type !== expected) {
          error(
            socket,
            "BAD_ROLE",
            "The connection offer came from the wrong participant.",
            peer.id,
          );
          return;
        }
        send(peer.socket, {
          type: "description",
          from: sender.id,
          description: message.description,
        });
      } else {
        send(peer.socket, {
          type: "candidate",
          from: sender.id,
          candidate: message.candidate,
        });
      }
    });
  });

  const cleanup = setInterval(() => {
    for (const id of rooms.keys()) getRoom(id);
    const now = Date.now();
    for (const [ip, limit] of roomRequests)
      if (now >= limit.reset) roomRequests.delete(ip);
  }, options.cleanupIntervalMs ?? 30_000);
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, options.heartbeatIntervalMs ?? 15_000);
  cleanup.unref();
  heartbeat.unref();
  let closing: Promise<void> | undefined;

  return {
    httpServer,
    async listen(port = 3001, host = "127.0.0.1") {
      await new Promise<void>((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.removeListener("error", reject);
          resolve();
        });
      });
      const address = httpServer.address();
      if (!address || typeof address === "string")
        throw new Error("No server address");
      return address.port;
    },
    close() {
      return (closing ??= (async () => {
        clearInterval(cleanup);
        clearInterval(heartbeat);
        for (const room of rooms.values()) endRoom(room, "server-stopped");
        for (const socket of wss.clients) socket.terminate();
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        if (httpServer.listening)
          await new Promise<void>((resolve, reject) =>
            httpServer.close((err) => (err ? reject(err) : resolve())),
          );
      })());
    },
  };
}
