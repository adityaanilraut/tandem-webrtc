import assert from "node:assert/strict";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { createSignalingServer } from "../server/app";

// These probes wrap real browser APIs; media and transport are never mocked.
declare global {
  interface Window {
    meshTest: {
      connections: RTCPeerConnection[];
      sockets: WebSocket[];
      tracks: MediaStreamTrack[];
      replaceDelay: number;
      descriptionDelay: number;
      rejectReplacementOnce: boolean;
      blockCamera: boolean;
    };
  }
}

const options = {
  origins: new Set<string>(),
  inviteOrigin: "",
  staticDirectory: resolve("dist"),
  heartbeatIntervalMs: 500,
  iceConfiguration: async () => ({
    iceServers: [],
    iceTransportPolicy: "all" as const,
  }),
};
const server = createSignalingServer(options);
let browser: Browser | undefined;
const errors: string[] = [];

async function page(width = 1280, height = 900) {
  const context = await browser!.newContext({
    permissions: ["camera", "microphone"],
    viewport: { width, height },
  });
  const tab = await context.newPage();
  tab.on("pageerror", (error) => errors.push(error.message));
  await tab.addInitScript(() => {
    const probe = (window.meshTest = {
      connections: [] as RTCPeerConnection[],
      sockets: [] as WebSocket[],
      tracks: [] as MediaStreamTrack[],
      replaceDelay: 0,
      descriptionDelay: 0,
      rejectReplacementOnce: false,
      blockCamera: false,
    });
    const NativePeer = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeer {
      constructor(config?: RTCConfiguration) {
        super(config);
        probe.connections.push(this);
      }
    };
    const NativeSocket = window.WebSocket;
    window.WebSocket = class extends NativeSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        probe.sockets.push(this);
      }
    };
    const capture = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (probe.blockCamera && constraints?.video)
        throw new DOMException("Test camera unavailable", "NotFoundError");
      const stream = await capture(constraints);
      probe.tracks.push(...stream.getTracks());
      return stream;
    };
    const replace = RTCRtpSender.prototype.replaceTrack;
    RTCRtpSender.prototype.replaceTrack = async function (track) {
      if (probe.replaceDelay)
        await new Promise((done) => setTimeout(done, probe.replaceDelay));
      if (probe.rejectReplacementOnce) {
        probe.rejectReplacementOnce = false;
        throw new DOMException(
          "Test device rejection",
          "InvalidModificationError",
        );
      }
      return replace.call(this, track);
    };
    const description = RTCPeerConnection.prototype.setRemoteDescription;
    RTCPeerConnection.prototype.setRemoteDescription = async function (value) {
      if (probe.descriptionDelay)
        await new Promise((done) => setTimeout(done, probe.descriptionDelay));
      return Reflect.apply(description, this, [value]) as Promise<void>;
    };
  });
  return tab;
}

async function joinCall(tab: Page, invite?: string) {
  if (invite) await tab.goto(invite);
  await tab.getByRole("button", { name: "Join call", exact: true }).click();
}

async function connected(tabs: Page[], count: number) {
  await Promise.all(
    tabs.map(async (tab) => {
      await tab.waitForFunction(
        (count) => {
          const pcs = window.meshTest.connections.filter(
            (pc) => pc.connectionState !== "closed",
          );
          const videos = [
            ...document.querySelectorAll<HTMLVideoElement>(
              ".participant-tile:not(.local-tile) video",
            ),
          ];
          return (
            document.querySelectorAll('[data-status="connected"]').length ===
              count - 1 &&
            pcs.length === count - 1 &&
            pcs.every((pc) => pc.connectionState === "connected") &&
            videos.length === count - 1 &&
            videos.every(
              (video) =>
                video.videoWidth > 0 && video.readyState >= 2 && !video.muted,
            )
          );
        },
        count,
        { timeout: 30_000 },
      );
      assert.match(
        await tab.getByLabel("Participants", { exact: true }).innerText(),
        new RegExp(`${count} / 4`),
      );
    }),
  );
}

async function received(tabs: Page[], count: number) {
  for (const tab of tabs) {
    await tab.waitForFunction(
      async (count) => {
        const received = await Promise.all(
          window.meshTest.connections
            .filter((pc) => pc.connectionState === "connected")
            .map(async (pc) => {
              const incoming = [...(await pc.getStats()).values()].filter(
                (s) => s.type === "inbound-rtp",
              );
              return (
                incoming.some(
                  (s) =>
                    s.kind === "video" &&
                    s.framesDecoded > 0 &&
                    s.bytesReceived > 0,
                ) &&
                incoming.some(
                  (s) => s.kind === "audio" && s.packetsReceived > 0,
                )
              );
            }),
        );
        return received.length === count - 1 && received.every(Boolean);
      },
      count,
      { timeout: 10_000 },
    );
  }
}

async function flowing(tabs: Page[]) {
  await Promise.all(
    tabs.map(async (tab) => {
      const before = await tab.evaluate(async () =>
        Promise.all(
          window.meshTest.connections
            .filter((pc) => pc.connectionState === "connected")
            .map(async (pc) => {
              const stats = [...(await pc.getStats()).values()].filter(
                (s) => s.type === "inbound-rtp",
              );
              return {
                video: stats.reduce(
                  (sum, s) =>
                    sum + (s.kind === "video" ? (s.framesDecoded ?? 0) : 0),
                  0,
                ),
                audio: stats.reduce(
                  (sum, s) =>
                    sum + (s.kind === "audio" ? (s.packetsReceived ?? 0) : 0),
                  0,
                ),
              };
            }),
        ),
      );
      await tab.waitForFunction(
        async (before) => {
          const pcs = window.meshTest.connections.filter(
            (pc) => pc.connectionState === "connected",
          );
          if (pcs.length !== before.length) return false;
          return (
            await Promise.all(
              pcs.map(async (pc, i) => {
                const stats = [...(await pc.getStats()).values()].filter(
                  (s) => s.type === "inbound-rtp",
                );
                const video = stats.reduce(
                  (sum, s) =>
                    sum + (s.kind === "video" ? (s.framesDecoded ?? 0) : 0),
                  0,
                );
                const audio = stats.reduce(
                  (sum, s) =>
                    sum + (s.kind === "audio" ? (s.packetsReceived ?? 0) : 0),
                  0,
                );
                return video > before[i].video && audio > before[i].audio;
              }),
            )
          ).every(Boolean);
        },
        before,
        { timeout: 10_000 },
      );
    }),
  );
}

async function stopped(tab: Page) {
  await tab.waitForFunction(
    () =>
      window.meshTest.tracks.every((t) => t.readyState === "ended") &&
      window.meshTest.connections.every(
        (pc) => pc.connectionState === "closed",
      ),
  );
}

async function bytes(tab: Page) {
  return tab.evaluate(async () => {
    let total = 0;
    for (const pc of window.meshTest.connections.filter(
      (pc) => pc.connectionState === "connected",
    ))
      for (const stat of (await pc.getStats()).values())
        if (stat.type === "inbound-rtp") total += stat.bytesReceived ?? 0;
    return total;
  });
}

async function noOverflow(tab: Page) {
  assert.ok(
    await tab.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Page overflows horizontally",
  );
}

async function controlsInView(tab: Page) {
  const viewport = tab.viewportSize()!;
  for (const name of [
    "Mute microphone",
    "Turn camera off",
    "Leave call",
    "Copy link",
  ]) {
    const bounds = await tab
      .getByRole("button", { name, exact: true })
      .boundingBox();
    assert.ok(
      bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height,
      `${name} is within the viewport`,
    );
  }
}

try {
  await mkdir("artifacts", { recursive: true });
  const port = await server.listen(0);
  const base = `http://127.0.0.1:${port}`;
  options.inviteOrigin = base;
  options.origins.add(base);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE
      ? { executablePath: process.env.BROWSER_EXECUTABLE }
      : {}),
    args: [
      "--use-fake-device-for-media-stream=device-count=2",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const host = await page();
  await host.goto(base);
  await host
    .getByRole("button", { name: "Create a call", exact: true })
    .click();
  await host
    .getByRole("status")
    .filter({ hasText: "Waiting for someone to join" })
    .waitFor();
  const invite = host.url();
  await host
    .getByRole("button", { name: "Mute microphone", exact: true })
    .click();
  await host
    .getByRole("button", { name: "Turn camera off", exact: true })
    .click();
  const second = await page(390, 844);
  await joinCall(second, invite);
  await connected([host, second], 2);
  assert.match(
    await second.locator(".participant-tile:not(.local-tile)").innerText(),
    /Mic off/,
  );
  assert.match(
    await second.locator(".participant-tile:not(.local-tile)").innerText(),
    /Camera off/,
  );
  await host
    .getByRole("button", { name: "Unmute microphone", exact: true })
    .click();
  await host
    .getByRole("button", { name: "Turn camera on", exact: true })
    .click();
  const third = await page(),
    fourth = await page();
  // Delayed SDP makes ICE and concurrent join handling exercise the per-peer queues.
  await third.goto(base);
  await third.evaluate(() => {
    window.meshTest.descriptionDelay = 150;
  });
  // A document navigation resets probes, so use the in-app invite form to join.
  await third.getByLabel("Call link", { exact: true }).fill(invite);
  await third.getByRole("button", { name: "Join", exact: true }).click();
  await Promise.all([joinCall(third), joinCall(fourth, invite)]);
  const four = [host, second, third, fourth];
  await connected(four, 4);
  await received(four, 4);
  await flowing(four);
  console.log(
    "PASS: four real browser peers, six connections, twelve incoming audio/video streams; concurrent and late joins",
  );
  await host.screenshot({
    path: "artifacts/four-person-desktop.png",
    fullPage: true,
  });
  await second.screenshot({
    path: "artifacts/four-person-mobile.png",
    fullPage: true,
  });
  await noOverflow(host);
  await noOverflow(second);
  await second.setViewportSize({ width: 320, height: 568 });
  await noOverflow(second);
  await controlsInView(second);
  await second.setViewportSize({ width: 390, height: 844 });

  const fifth = await page();
  await fifth.goto(invite);
  await fifth
    .getByRole("alert")
    .filter({ hasText: "4 people maximum" })
    .waitFor();
  assert.equal(await fifth.evaluate(() => window.meshTest.tracks.length), 0);
  await connected(four, 4);
  console.log(
    "PASS: fifth visitor rejected before capture; all four existing participants remain connected",
  );

  // Drop the original room creator's signaling connection, with no explicit leave.
  await host.evaluate(() => window.meshTest.sockets[0].close());
  await connected([second, third, fourth], 3);
  await stopped(host);
  await fifth.getByRole("button", { name: "Try again", exact: true }).click();
  await joinCall(fifth);
  await connected([second, third, fourth, fifth], 4);
  await received([second, third, fourth, fifth], 4);
  console.log(
    "PASS: creator disconnect removes only that participant; a replacement joins the same invite",
  );

  await third.getByRole("button", { name: "Leave call", exact: true }).click();
  await connected([second, fourth, fifth], 3);
  await stopped(third);
  // Keep mute/camera-off across both replacements, with a newcomer during camera replacement.
  await second
    .getByRole("button", { name: "Mute microphone", exact: true })
    .click();
  await second
    .getByRole("button", { name: "Turn camera off", exact: true })
    .click();
  await second
    .getByRole("button", {
      name: "Camera and microphone settings",
      exact: true,
    })
    .click();
  const devices = await second.evaluate(async () =>
    (await navigator.mediaDevices.enumerateDevices()).map((d) => ({
      kind: d.kind,
      id: d.deviceId,
    })),
  );
  const camera = devices.filter((d) => d.kind === "videoinput")[1];
  const mic = devices.filter((d) => d.kind === "audioinput")[1];
  assert.ok(
    camera && mic,
    "Browser must provide multiple fake cameras and microphones",
  );
  await second.evaluate(() => {
    window.meshTest.replaceDelay = 500;
  });
  const sixth = await page();
  await sixth.goto(invite);
  await Promise.all([
    second.getByLabel("Camera", { exact: true }).selectOption(camera.id),
    joinCall(sixth),
  ]);
  await second.getByRole("button", { name: "Done", exact: true }).waitFor();
  await second
    .getByLabel("Microphone", { exact: true })
    .waitFor({ state: "visible" });
  await second.waitForFunction(
    () =>
      !document.querySelector<HTMLSelectElement>("#microphone-select")
        ?.disabled,
  );
  await second.getByLabel("Microphone", { exact: true }).selectOption(mic.id);
  await second.waitForFunction(
    () =>
      !document.querySelector<HTMLSelectElement>("#microphone-select")
        ?.disabled,
  );
  await second.getByRole("button", { name: "Done", exact: true }).click();
  const current = [second, fourth, fifth, sixth];
  await connected(current, 4);
  const replacementState = await second.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>(
      'video[aria-label="Your local video"]',
    )!;
    const stream = video.srcObject as MediaStream;
    const tracks = stream.getTracks();
    return {
      states: tracks.map((t) => ({
        kind: t.kind,
        enabled: t.enabled,
        id: t.id,
      })),
      senders: window.meshTest.connections
        .filter((pc) => pc.connectionState === "connected")
        .map((pc) =>
          pc.getSenders().map((s) => ({
            kind: s.track?.kind,
            enabled: s.track?.enabled,
            id: s.track?.id,
          })),
        ),
      stopped: window.meshTest.tracks
        .filter((t) => !tracks.includes(t))
        .every((t) => t.readyState === "ended"),
    };
  });
  assert.ok(replacementState.stopped);
  assert.ok(replacementState.states.every((t) => !t.enabled));
  for (const senders of replacementState.senders)
    for (const state of replacementState.states)
      assert.deepEqual(
        senders.find((s) => s.kind === state.kind),
        state,
      );
  const secondId = await second
    .locator(".local-tile")
    .getAttribute("data-participant-id");
  for (const tab of current.slice(1)) {
    await tab
      .locator(`[data-participant-id="${secondId}"]`)
      .getByText("Mic off", { exact: false })
      .waitFor();
    await tab
      .locator(`[data-participant-id="${secondId}"]`)
      .getByRole("heading", { name: "Camera off" })
      .waitFor();
  }
  await second
    .getByRole("button", { name: "Unmute microphone", exact: true })
    .click();
  await second
    .getByRole("button", { name: "Turn camera on", exact: true })
    .click();
  await received(current, 4);
  await flowing(current);
  console.log(
    "PASS: microphone and camera replacement reaches every peer, including a concurrent join; mute states preserved and old captures released",
  );

  // Inject one browser API rejection, then verify all real senders roll back.
  await second
    .getByRole("button", {
      name: "Camera and microphone settings",
      exact: true,
    })
    .click();
  const oldTrackId = await second.evaluate(
    () =>
      (
        document.querySelector<HTMLVideoElement>(
          'video[aria-label="Your local video"]',
        )!.srcObject as MediaStream
      ).getVideoTracks()[0].id,
  );
  await second.evaluate(() => {
    window.meshTest.replaceDelay = 0;
    window.meshTest.rejectReplacementOnce = true;
  });
  await second
    .getByLabel("Camera", { exact: true })
    .selectOption(devices.filter((d) => d.kind === "videoinput")[0].id);
  await second
    .getByRole("dialog", { name: "Camera & microphone" })
    .getByRole("alert")
    .filter({ hasText: "Your previous device is still selected" })
    .waitFor();
  await second.waitForFunction(
    (id) =>
      window.meshTest.connections
        .filter((pc) => pc.connectionState === "connected")
        .every(
          (pc) =>
            pc.getSenders().find((s) => s.track?.kind === "video")?.track
              ?.id === id,
        ),
    oldTrackId,
  );
  await second.getByRole("button", { name: "Done", exact: true }).click();
  await connected(current, 4);
  await received(current, 4);
  await flowing(current);
  console.log(
    "PASS: a rejected camera switch rolls all senders back to the previous capture without losing any participant",
  );

  // Break one transport only: both participants retain their other connections.
  const before = await bytes(fourth);
  await second.evaluate(() =>
    window.meshTest.connections
      .find((pc) => pc.connectionState === "connected")!
      .close(),
  );
  await fourth.waitForTimeout(500);
  assert.ok((await bytes(fourth)) > before);
  assert.equal(
    await second.evaluate(
      () =>
        window.meshTest.connections.filter(
          (pc) => pc.connectionState === "connected",
        ).length,
    ),
    2,
  );
  console.log(
    "PASS: a single transport closing does not tear down unrelated connections",
  );

  await Promise.all(
    current.map((tab) =>
      tab.getByRole("button", { name: "Leave call", exact: true }).click(),
    ),
  );
  await Promise.all(current.map(stopped));

  // Leave while descriptions are still pending; stale async work cannot recreate a departed peer.
  const response = await fetch(base + "/api/rooms", { method: "POST" });
  const room = (await response.json()) as { invitePath: string };
  const slow = await page(),
    brief = await page(),
    survivor = await page();
  await slow.goto(base);
  await slow.evaluate(() => {
    window.meshTest.descriptionDelay = 700;
  });
  await slow
    .getByLabel("Call link", { exact: true })
    .fill(base + room.invitePath);
  await slow.getByRole("button", { name: "Join", exact: true }).click();
  await joinCall(slow);
  await slow
    .getByLabel("Participants", { exact: true })
    .filter({ hasText: "1 / 4" })
    .waitFor();
  await joinCall(brief, base + room.invitePath);
  await brief
    .getByLabel("Participants", { exact: true })
    .filter({ hasText: "2 / 4" })
    .waitFor();
  await brief.getByRole("button", { name: "Leave call", exact: true }).click();
  await joinCall(survivor, base + room.invitePath);
  await connected([slow, survivor], 2);
  await received([slow, survivor], 2);
  await stopped(brief);
  console.log(
    "PASS: departure during SDP negotiation leaves no ghost peer; another participant can join",
  );
  await Promise.all(
    [slow, survivor].map((tab) =>
      tab.getByRole("button", { name: "Leave call", exact: true }).click(),
    ),
  );
  await Promise.all([slow, survivor].map(stopped));

  const concurrentRoom = (await (
    await fetch(base + "/api/rooms", { method: "POST" })
  ).json()) as { invitePath: string };
  const simultaneous = await Promise.all(
    Array.from({ length: 4 }, () => page()),
  );
  await Promise.all(
    simultaneous.map((tab) => joinCall(tab, base + concurrentRoom.invitePath)),
  );
  await connected(simultaneous, 4);
  await received(simultaneous, 4);
  await flowing(simultaneous);
  console.log(
    "PASS: all four browsers join concurrently and every pair sends fresh audio/video",
  );
  await Promise.all(
    simultaneous.map((tab) =>
      tab.getByRole("button", { name: "Leave call", exact: true }).click(),
    ),
  );
  await Promise.all(simultaneous.map(stopped));

  const deviceRoom = (await (
    await fetch(base + "/api/rooms", { method: "POST" })
  ).json()) as { invitePath: string };
  const deviceInvite = base + deviceRoom.invitePath;
  const speaker = await page();
  const listener = await page();
  const audioOnly = await page();
  await listener.addInitScript(() => {
    navigator.share = async (data) => {
      Reflect.set(window, "sharedInvite", data?.url);
    };
  });
  await joinCall(speaker, deviceInvite);
  await listener.goto(deviceInvite);
  assert.equal(
    await listener.evaluate(() => typeof navigator.share),
    "function",
  );
  await listener.getByLabel("Display name").fill("Alex");
  await listener.getByRole("checkbox", { name: "Microphone" }).uncheck();
  await listener.getByRole("checkbox", { name: "Camera" }).uncheck();
  assert.equal(await listener.evaluate(() => window.meshTest.tracks.length), 0);
  await joinCall(listener);
  await listener.getByRole("status").filter({ hasText: "Connected" }).waitFor();
  const namedTile = speaker.locator('.participant-tile[aria-label="Alex"]');
  await namedTile.getByRole("heading", { name: "Camera off" }).waitFor();
  assert.equal(await listener.evaluate(() => window.meshTest.tracks.length), 0);
  await listener.getByRole("button", { name: "Share link" }).click();
  assert.equal(
    await listener.evaluate(() => Reflect.get(window, "sharedInvite")),
    deviceInvite,
  );
  // A receive-only guest plays the other person's media without turning on either local device.
  await listener.waitForFunction(() => {
    const incoming = document.querySelector<HTMLVideoElement>(
      ".participant-tile:not(.local-tile) video",
    );
    return incoming && !incoming.paused && incoming.videoWidth > 0;
  });
  await listener
    .getByRole("button", { name: "Unmute microphone", exact: true })
    .click();
  await listener
    .getByRole("button", { name: "Turn camera on", exact: true })
    .click();
  await flowing([speaker, listener]);
  assert.equal(
    await listener.evaluate(() => window.meshTest.connections.length),
    1,
  );

  await audioOnly.goto(deviceInvite);
  await audioOnly.evaluate(() => {
    window.meshTest.blockCamera = true;
  });
  await joinCall(audioOnly);
  await audioOnly
    .getByRole("status")
    .filter({ hasText: "Connected" })
    .waitFor();
  await audioOnly
    .getByRole("alert")
    .filter({ hasText: "camera is unavailable" })
    .waitFor();
  assert.deepEqual(
    await audioOnly.evaluate(() =>
      window.meshTest.tracks.map((track) => track.kind),
    ),
    ["audio"],
  );
  await audioOnly.evaluate(() => {
    window.meshTest.blockCamera = false;
  });
  await audioOnly
    .getByRole("button", { name: "Turn camera on", exact: true })
    .click();
  await connected([speaker, listener, audioOnly], 3);
  await flowing([speaker, listener, audioOnly]);

  const listenerId = await listener
    .locator(".local-tile")
    .getAttribute("data-participant-id");
  await listener.evaluate(() => {
    const camera = window.meshTest.tracks.find(
      (track) => track.kind === "video" && track.readyState === "live",
    )!;
    camera.stop();
    camera.dispatchEvent(new Event("ended"));
  });
  await listener
    .getByRole("alert")
    .filter({ hasText: "camera stopped" })
    .waitFor();
  await namedTile.getByRole("heading", { name: "Camera off" }).waitFor();
  assert.ok(
    await listener.evaluate(() =>
      window.meshTest.tracks.some(
        (track) => track.kind === "audio" && track.readyState === "live",
      ),
    ),
  );
  await listener
    .getByRole("button", { name: "Turn camera on", exact: true })
    .click();
  await flowing([speaker, listener, audioOnly]);
  assert.equal(
    await listener.locator(".local-tile").getAttribute("data-participant-id"),
    listenerId,
  );
  console.log(
    "PASS: listen-only join, enabling and recovering devices in call, display names, and native invite sharing",
  );

  await speaker
    .getByRole("button", { name: "Camera and microphone settings" })
    .click();
  await speaker.getByLabel("Display name").fill("Sam");
  await speaker.getByRole("button", { name: "Done", exact: true }).click();
  await listener.locator('.participant-tile[aria-label="Sam"]').waitFor();
  await listener
    .getByRole("button", { name: "Mute microphone", exact: true })
    .click();
  await listener
    .getByRole("button", { name: "Turn camera off", exact: true })
    .click();
  await listener.evaluate(() => window.meshTest.sockets.at(-1)!.close());
  await listener.getByRole("button", { name: "Rejoin this call" }).click();
  await listener.getByRole("status").filter({ hasText: "Connected" }).waitFor();
  assert.equal(listener.url(), deviceInvite);
  await listener
    .getByRole("button", { name: "Unmute microphone", exact: true })
    .waitFor();
  await listener
    .getByRole("button", { name: "Turn camera on", exact: true })
    .waitFor();
  await namedTile.getByText("Mic off").waitFor();
  await namedTile.getByRole("heading", { name: "Camera off" }).waitFor();
  console.log(
    "PASS: rejoin stays on the same invite and preserves media choices and display name",
  );

  const invalid = await page();
  await invalid.goto(base + "/room/malformed-invite");
  await invalid
    .getByRole("alert")
    .filter({ hasText: "invite link is invalid" })
    .waitFor();
  await invalid.goto(base + "/room/");
  await invalid
    .getByRole("alert")
    .filter({ hasText: "invite link is invalid" })
    .waitFor();
  await invalid.goto(base);
  await invalid
    .getByLabel("Call link", { exact: true })
    .fill("https://other.example" + deviceRoom.invitePath);
  await invalid.getByRole("button", { name: "Join", exact: true }).click();
  await invalid
    .getByRole("alert")
    .filter({ hasText: "belongs to another server" })
    .waitFor();
  assert.equal(new URL(invalid.url()).origin, base);
  console.log("PASS: malformed and foreign invites show actionable errors");

  await Promise.all(
    [speaker, listener, audioOnly].map((tab) =>
      tab.getByRole("button", { name: "Leave call" }).click(),
    ),
  );
  await Promise.all([speaker, listener, audioOnly].map(stopped));
  assert.deepEqual(errors, [], "Browser errors");
  console.log("All browser mesh checks passed.");
} finally {
  await browser?.close();
  await server.close();
}
