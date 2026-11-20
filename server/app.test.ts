import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { createSignalingServer } from "./app";
import type { ServerMessage } from "../shared/protocol";

const ORIGIN = "http://localhost:5173";
const running: ReturnType<typeof createSignalingServer>[] = [];
const clients: WebSocket[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.terminate();
  await Promise.all(running.splice(0).map((server) => server.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function start(
  overrides: Partial<Parameters<typeof createSignalingServer>[0]> = {},
) {
  const server = createSignalingServer({
    origins: new Set([ORIGIN]),
    inviteOrigin: ORIGIN,
    ...overrides,
  });
  running.push(server);
  const port = await server.listen(0);
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    async room() {
      const response = await fetch(`${base}/api/rooms`, { method: "POST" });
      expect(response.status).toBe(201);
      return (await response.json()) as { roomId: string; invitePath: string };
    },
    async client(origin = ORIGIN) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        origin,
      });
      clients.push(socket);
      const inbox: ServerMessage[] = [];
      let wake: (() => void) | undefined;
      socket.on("message", (raw) => {
        inbox.push(JSON.parse(raw.toString()));
        wake?.();
      });
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      return {
        socket,
        inbox,
        send: (message: unknown) => socket.send(JSON.stringify(message)),
        join: (roomId: string) =>
          socket.send(
            JSON.stringify({
              type: "join",
              roomId,
              audioEnabled: true,
              videoEnabled: true,
            }),
          ),
        async next<T extends ServerMessage["type"]>(
          type: T,
        ): Promise<Extract<ServerMessage, { type: T }>> {
          const deadline = Date.now() + 2000;
          while (Date.now() < deadline) {
            const index = inbox.findIndex((message) => message.type === type);
            if (index !== -1)
              return inbox.splice(index, 1)[0] as Extract<
                ServerMessage,
                { type: T }
              >;
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 25);
              wake = () => {
                clearTimeout(timer);
                wake = undefined;
                resolve();
              };
            });
          }
          throw new Error(
            `Timed out waiting for ${type}: ${JSON.stringify(inbox)}`,
          );
        },
      };
    },
  };
}

describe("room lifecycle and signaling", () => {
  it("creates an unguessable invite, exposes availability, and rejects invalid rooms", async () => {
    const app = await start();
    const { roomId, invitePath } = await app.room();
    expect(invitePath).toBe(`/room/${roomId}`);
    expect(
      await (await fetch(`${app.base}/api/rooms/${roomId}`)).json(),
    ).toEqual({ available: true, participants: 0 });
    expect((await fetch(`${app.base}/api/rooms/not-a-room`)).status).toBe(404);
    const config = await (await fetch(`${app.base}/api/config`)).json();
    expect(config).toEqual({
      inviteOrigin: ORIGIN,
      httpsReady: false,
      publicAccess: false,
      turnConfigured: false,
    });
  });

  it("admits four concurrent participants, builds every pair and safely addresses SDP/ICE", async () => {
    const app = await start();
    const { roomId } = await app.room();
    const peers = await Promise.all(
      Array.from({ length: 4 }, () => app.client()),
    );
    peers.forEach((peer) => peer.join(roomId));
    const joined = await Promise.all(peers.map((peer) => peer.next("joined")));
    expect(new Set(joined.map((message) => message.participantId)).size).toBe(
      4,
    );
    const order = joined
      .map((message, index) => ({ ...message, index }))
      .sort((a, b) => a.participants.length - b.participants.length);
    expect(order.map((message) => message.participants.length)).toEqual([
      0, 1, 2, 3,
    ]);
    for (const [i, participant] of order.entries()) {
      expect(participant.participants.map((p) => p.id)).toEqual(
        order.slice(0, i).map((p) => p.participantId),
      );
      for (const newcomer of order.slice(i + 1)) {
        expect(
          await peers[participant.index].next("peer-joined"),
        ).toMatchObject({
          participant: {
            id: newcomer.participantId,
            media: { audioEnabled: true, videoEnabled: true },
          },
        });
      }
    }
    // All six pairs negotiate; traffic goes only to the addressed member.
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const a = peers[order[i].index],
          b = peers[order[j].index];
        const aId = order[i].participantId,
          bId = order[j].participantId;
        const description = { type: "offer", sdp: `offer-${i}-${j}` };
        a.send({
          type: "description",
          to: bId,
          from: "spoofed",
          roomId: randomUUID(),
          description,
        });
        expect(await b.next("description")).toEqual({
          type: "description",
          from: aId,
          description,
        });
        const answer = { type: "answer", sdp: `answer-${i}-${j}` };
        b.send({ type: "description", to: aId, description: answer });
        expect(await a.next("description")).toEqual({
          type: "description",
          from: bId,
          description: answer,
        });
        const candidate = {
          candidate: "candidate:test",
          sdpMid: "0",
          sdpMLineIndex: 0,
        };
        a.send({ type: "candidate", to: bId, candidate });
        expect(await b.next("candidate")).toEqual({
          type: "candidate",
          from: aId,
          candidate,
        });
        b.send({ type: "candidate", to: aId, candidate: null });
        expect(await a.next("candidate")).toEqual({
          type: "candidate",
          from: bId,
          candidate: null,
        });
      }
    }
    const media = { audioEnabled: false, videoEnabled: false };
    peers[0].send({ type: "media-state", participantId: "spoofed", ...media });
    for (const peer of peers.slice(1))
      expect(await peer.next("media-state")).toEqual({
        type: "media-state",
        participantId: joined[0].participantId,
        ...media,
      });
    expect(peers.every((peer) => peer.inbox.length === 0)).toBe(true);
  });

  it("rejects a fifth participant at HTTP and WebSocket admission without disturbing the four", async () => {
    const app = await start();
    const { roomId } = await app.room();
    const peers = await Promise.all(
      Array.from({ length: 4 }, () => app.client()),
    );
    peers.forEach((peer) => peer.join(roomId));
    const joined = await Promise.all(peers.map((peer) => peer.next("joined")));
    const fifth = await app.client();
    fifth.join(roomId);
    expect(await fifth.next("error")).toMatchObject({
      code: "ROOM_FULL",
      message: expect.stringContaining("4 people maximum"),
    });
    for (const path of [`/api/rooms/${roomId}`, `/api/rooms/${roomId}/ice`])
      expect((await fetch(app.base + path)).status).toBe(409);
    fifth.socket.close();
    peers[0].send({
      type: "candidate",
      to: joined[1].participantId,
      candidate: null,
    });
    expect(await peers[1].next("candidate")).toMatchObject({
      from: joined[0].participantId,
    });
    expect(
      peers.every(
        (peer) =>
          peer.socket.readyState === WebSocket.OPEN &&
          !peer.inbox.some((m) => m.type === "ended" || m.type === "peer-left"),
      ),
    ).toBe(true);
  });

  it("isolates rooms, prevents sender impersonation and rejects unjoined or stale targets", async () => {
    const app = await start();
    const first = await app.room(),
      second = await app.room();
    const a = await app.client(),
      b = await app.client(),
      outsider = await app.client();
    a.join(first.roomId);
    const aId = (await a.next("joined")).participantId;
    b.join(second.roomId);
    const bId = (await b.next("joined")).participantId;
    for (const to of [bId, aId, randomUUID()]) {
      a.send({ type: "candidate", to, candidate: null });
      expect(await a.next("error")).toMatchObject({
        code: "PEER_NOT_FOUND",
        peerId: to,
      });
    }
    expect(b.inbox).toHaveLength(0);
    outsider.send({
      type: "description",
      to: aId,
      description: { type: "offer", sdp: "bad" },
    });
    expect(await outsider.next("error")).toMatchObject({ code: "NOT_JOINED" });
    a.join(second.roomId);
    expect(await a.next("error")).toMatchObject({ code: "ALREADY_JOINED" });
  });

  it("rejects malformed signaling and enforces an offerer for each pair", async () => {
    const app = await start();
    const { roomId } = await app.room();
    const a = await app.client(),
      b = await app.client();
    a.socket.send("{invalid json");
    expect(await a.next("error")).toMatchObject({ code: "BAD_MESSAGE" });
    for (const message of [
      { type: "candidate", to: randomUUID(), candidate: { candidate: 99 } },
      { type: "candidate", candidate: null },
      {
        type: "description",
        to: {},
        description: { type: "offer", sdp: "bad" },
      },
      {
        type: "description",
        to: randomUUID(),
        description: { type: ["offer"], sdp: "bad" },
      },
    ]) {
      a.send(message);
      expect(await a.next("error")).toMatchObject({ code: "BAD_MESSAGE" });
    }
    a.join(roomId);
    const aId = (await a.next("joined")).participantId;
    b.join(roomId);
    const bId = (await b.next("joined")).participantId;
    a.send({
      type: "description",
      to: bId,
      description: { type: "answer", sdp: "wrong-role" },
    });
    expect(await a.next("error")).toMatchObject({
      code: "BAD_ROLE",
      peerId: bId,
    });
    b.send({
      type: "description",
      to: aId,
      description: { type: "offer", sdp: "wrong-role" },
    });
    expect(await b.next("error")).toMatchObject({
      code: "BAD_ROLE",
      peerId: aId,
    });
    expect(b.inbox.some((m) => m.type === "description")).toBe(false);
  });

  it.each(["leave", "disconnect"])(
    "removes only one participant on %s, admits a replacement and deletes the room only when empty",
    async (mode) => {
      const app = await start();
      const { roomId } = await app.room();
      const peers = await Promise.all(
        Array.from({ length: 4 }, () => app.client()),
      );
      const ids: string[] = [];
      for (const peer of peers) {
        peer.join(roomId);
        ids.push((await peer.next("joined")).participantId);
      }
      if (mode === "leave") {
        peers[0].send({ type: "leave" });
        expect(await peers[0].next("ended")).toMatchObject({ reason: "left" });
      } else peers[0].socket.terminate();
      for (const peer of peers.slice(1))
        expect(await peer.next("peer-left")).toEqual({
          type: "peer-left",
          participantId: ids[0],
        });
      expect(
        await (await fetch(`${app.base}/api/rooms/${roomId}`)).json(),
      ).toMatchObject({ participants: 3 });
      peers[1].send({ type: "candidate", to: ids[0], candidate: null });
      expect(await peers[1].next("error")).toMatchObject({
        code: "PEER_NOT_FOUND",
      });
      peers[1].send({
        type: "description",
        to: ids[2],
        description: { type: "offer", sdp: "still-connected" },
      });
      expect(await peers[2].next("description")).toMatchObject({
        from: ids[1],
      });
      const replacement = await app.client();
      replacement.send({
        type: "join",
        roomId,
        audioEnabled: false,
        videoEnabled: true,
      });
      const joined = await replacement.next("joined");
      expect(joined.participants.map((p) => p.id)).toEqual(ids.slice(1));
      expect(joined.participantId).not.toBe(ids[0]);
      for (const peer of peers.slice(1)) {
        // Consume earlier join events to reach the replacement.
        let event = await peer.next("peer-joined");
        while (event.participant.id !== joined.participantId)
          event = await peer.next("peer-joined");
        expect(event.participant).toMatchObject({
          number: 1,
          media: { audioEnabled: false },
        });
        expect(peer.inbox.some((m) => m.type === "ended")).toBe(false);
        peer.send({ type: "leave" });
        await peer.next("ended");
      }
      expect((await fetch(`${app.base}/api/rooms/${roomId}`)).status).toBe(200);
      replacement.send({ type: "leave" });
      await replacement.next("ended");
      expect((await fetch(`${app.base}/api/rooms/${roomId}`)).status).toBe(404);
      replacement.socket.close();
    },
  );

  it("gives a late joiner each participant’s current mute and camera state", async () => {
    const app = await start();
    const { roomId } = await app.room();
    const a = await app.client(),
      b = await app.client();
    a.join(roomId);
    const aId = (await a.next("joined")).participantId;
    a.send({ type: "media-state", audioEnabled: false, videoEnabled: false });
    // An addressed invalid-target response is a barrier for the preceding state change.
    a.send({ type: "candidate", to: aId, candidate: null });
    await a.next("error");
    b.join(roomId);
    expect((await b.next("joined")).participants).toEqual([
      {
        id: aId,
        number: 1,
        media: { audioEnabled: false, videoEnabled: false },
      },
    ]);
  });

  it("expires unused rooms without expiring occupied rooms", async () => {
    const app = await start({ roomTtlMs: 30, cleanupIntervalMs: 10 });
    const unused = await app.room();
    const active = await app.room();
    const a = await app.client();
    a.join(active.roomId);
    await a.next("joined");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect((await fetch(`${app.base}/api/rooms/${unused.roomId}`)).status).toBe(
      404,
    );
    expect((await fetch(`${app.base}/api/rooms/${active.roomId}`)).status).toBe(
      200,
    );
  });

  it("lets the last caller rejoin after a connection drop and expires the grace period", async () => {
    const app = await start({ reconnectGraceMs: 100, cleanupIntervalMs: 10 });
    const { roomId } = await app.room();
    const caller = await app.client();
    caller.join(roomId);
    await caller.next("joined");
    caller.socket.close();
    const availability = `${app.base}/api/rooms/${roomId}`;
    await expect
      .poll(
        async () => (await (await fetch(availability)).json()).participants,
        {
          interval: 5,
          timeout: 90,
        },
      )
      .toBe(0);
    const returning = await app.client();
    returning.join(roomId);
    await returning.next("joined");
    returning.socket.close();
    await expect
      .poll(async () => (await fetch(availability)).status, { interval: 15 })
      .toBe(404);
  });

  it("rejects foreign HTTP and WebSocket origins", async () => {
    const app = await start();
    expect(
      (
        await fetch(`${app.base}/api/rooms`, {
          method: "POST",
          headers: { Origin: "https://outside.example" },
        })
      ).status,
    ).toBe(403);
    const ws = new WebSocket(app.base.replace("http:", "ws:") + "/ws", {
      origin: "https://outside.example",
    });
    clients.push(ws);
    const status = await new Promise<number>((resolve, reject) => {
      ws.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode!);
      });
      ws.once("open", () =>
        reject(new Error("Unexpectedly allowed foreign origin")),
      );
      ws.on("error", () => {});
    });
    expect(status).toBe(403);
  });
});

describe("public hosting and ICE configuration", () => {
  it("limits public room creation and concurrent connections per client IP", async () => {
    const app = await start({
      publicAccess: true,
      clientIpHeader: "x-test-client-ip",
    });
    await Promise.all(Array.from({ length: 12 }, () => app.room()));
    const path = app.base + "/api/rooms";
    const limited = await fetch(path, { method: "POST" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(
      (
        await fetch(path, {
          method: "POST",
          headers: { "x-test-client-ip": "198.51.100.42" },
        })
      ).status,
    ).toBe(201);

    const peers = await Promise.all(
      Array.from({ length: 16 }, () => app.client()),
    );
    const limitedSocket = new WebSocket(
      app.base.replace("http:", "ws:") + "/ws",
      { origin: ORIGIN },
    );
    clients.push(limitedSocket);
    const status = await new Promise<number>((resolve, reject) => {
      limitedSocket.on("error", reject);
      limitedSocket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode!);
      });
    });
    expect(status).toBe(429);
    await new Promise<void>((resolve) => {
      peers[0].socket.once("close", resolve);
      peers[0].socket.close();
    });
    await app.client();
  });

  it("rejects malformed request URLs without stopping the public server", async () => {
    const app = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port: new URL(app.base).port, path: "//[" },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(400);
    expect((await fetch(`${app.base}/api/health`)).status).toBe(200);
  });
  it("cleans up after a failed bind and allows repeated shutdown", async () => {
    const app = await start();
    const conflicting = createSignalingServer({
      origins: new Set([ORIGIN]),
      inviteOrigin: ORIGIN,
    });
    running.push(conflicting);
    await expect(
      conflicting.listen(Number(new URL(app.base).port)),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    await conflicting.close();
    await conflicting.close();
  });
  it("accepts the exact public HTTPS origin for API and WebSocket signaling", async () => {
    const origin = "https://tandem-test.trycloudflare.com";
    const app = await start({
      origins: new Set([origin]),
      inviteOrigin: origin,
      httpsReady: true,
      publicAccess: true,
    });
    expect(await (await fetch(`${app.base}/api/config`)).json()).toMatchObject({
      inviteOrigin: origin,
      httpsReady: true,
      publicAccess: true,
    });
    const roomResponse = await fetch(`${app.base}/api/rooms`, {
      method: "POST",
      headers: { Origin: origin },
    });
    expect(roomResponse.status).toBe(201);
    const { roomId } = await roomResponse.json();
    const client = await app.client(origin);
    client.join(roomId);
    expect(await client.next("joined")).toMatchObject({
      type: "joined",
      participants: [],
      participantId: expect.any(String),
    });
    expect(
      (
        await fetch(`${app.base}/api/rooms`, {
          method: "POST",
          headers: { Origin: "https://another.trycloudflare.com" },
        })
      ).status,
    ).toBe(403);
  });

  it("serves built pages and assets without exposing source, certificates or path traversal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tandem-public-"));
    directories.push(directory);
    await mkdir(join(directory, "assets"));
    await writeFile(
      join(directory, "index.html"),
      "<!doctype html><title>Tandem fixture</title>",
    );
    await writeFile(
      join(directory, "assets", "app-test.js"),
      "console.log('frontend')",
    );
    await writeFile(join(directory, "secret.txt"), "must never be served");
    const app = await start({ staticDirectory: directory });
    const { roomId } = await app.room();
    for (const path of ["/", `/room/${roomId}`, "/room/malformed-link"]) {
      const response = await fetch(app.base + path);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("Tandem fixture");
    }
    const asset = await fetch(`${app.base}/assets/app-test.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect(asset.headers.get("content-type")).toContain("javascript");
    const head = await fetch(app.base, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    for (const path of [
      "/.env.local",
      "/.certs/dev-key.pem",
      "/src/App.tsx",
      "/server/ice.ts",
      "/secret.txt",
      "/assets/%2e%2e%2fsecret.txt",
      "/assets/%00.js",
      "/assets/missing.js",
    ]) {
      expect((await fetch(app.base + path)).status, path).toBe(404);
    }
  });

  it("only issues ICE credentials for valid available rooms, with no caching or credentials in public config", async () => {
    const iceConfig = {
      iceServers: [
        {
          urls: "turn:relay.example:3478",
          username: "temporary",
          credential: "temporary-password",
        },
      ],
      iceTransportPolicy: "relay" as const,
    };
    const app = await start({
      turnConfigured: true,
      iceConfiguration: async () => iceConfig,
    });
    const { roomId } = await app.room();
    const response = await fetch(`${app.base}/api/rooms/${roomId}/ice`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(iceConfig);
    const config = await (await fetch(`${app.base}/api/config`)).text();
    expect(config).toContain('"turnConfigured":true');
    expect(config).not.toContain("temporary-password");
    expect((await fetch(`${app.base}/api/rooms/not-a-room/ice`)).status).toBe(
      404,
    );
    const peers = await Promise.all(
      Array.from({ length: 4 }, () => app.client()),
    );
    for (const peer of peers) {
      peer.join(roomId);
      await peer.next("joined");
    }
    expect((await fetch(`${app.base}/api/rooms/${roomId}/ice`)).status).toBe(
      409,
    );
    peers[0].send({ type: "leave" });
    await peers[1].next("peer-left");
    expect((await fetch(`${app.base}/api/rooms/${roomId}/ice`)).status).toBe(
      200,
    );
    for (const peer of peers.slice(1)) {
      peer.send({ type: "leave" });
      await peer.next("ended");
    }
    expect((await fetch(`${app.base}/api/rooms/${roomId}/ice`)).status).toBe(
      404,
    );
  });

  it("limits credential issuance per room and hides provider errors", async () => {
    const app = await start({
      iceConfiguration: async () => {
        throw new Error("secret-provider-token");
      },
    });
    const { roomId } = await app.room();
    for (let i = 0; i < 10; i++) {
      const response = await fetch(`${app.base}/api/rooms/${roomId}/ice`);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("secret-provider-token");
    }
    expect((await fetch(`${app.base}/api/rooms/${roomId}/ice`)).status).toBe(
      429,
    );
  });
});
