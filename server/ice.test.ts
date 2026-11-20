import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIceProvider } from "./ice";
import { publicOrigin } from "./environment";

afterEach(() => vi.unstubAllGlobals());

describe("ICE providers", () => {
  it("works without a TURN account and preserves explicitly disabled STUN", async () => {
    const direct = createIceProvider({});
    expect(direct.turnConfigured).toBe(false);
    expect(await direct.getConfiguration()).toEqual({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      iceTransportPolicy: "all",
    });
    expect(
      (await createIceProvider({ STUN_URL: "" }).getConfiguration()).iceServers,
    ).toEqual([]);
  });

  it("generates expiring coturn credentials without exposing the signing secret", async () => {
    const secret = "test-server-only-secret";
    const provider = createIceProvider({
      TURN_URLS:
        "turn:relay.example:3478, turns:relay.example:443?transport=tcp",
      TURN_SECRET: secret,
    });
    const config = await provider.getConfiguration();
    const turn = config.iceServers[1];
    expect(Number(turn.username!.split(":")[0])).toBeGreaterThan(
      Date.now() / 1000 + 3500,
    );
    expect(turn.credential).toBe(
      createHmac("sha1", secret).update(turn.username!).digest("base64"),
    );
    expect(JSON.stringify(config)).not.toContain(secret);
    expect((await provider.getConfiguration()).iceServers[1].username).not.toBe(
      turn.username,
    );
  });

  it("uses provider credentials for relay-only verification", async () => {
    const provider = createIceProvider({
      TURN_URLS: "turns:relay.example:443?transport=tcp",
      TURN_USERNAME: "test-user",
      TURN_PASSWORD: "test-pass",
      ICE_TRANSPORT_POLICY: "relay",
    });
    expect(provider.turnConfigured).toBe(true);
    expect(await provider.getConfiguration()).toMatchObject({
      iceTransportPolicy: "relay",
      iceServers: [{}, { username: "test-user", credential: "test-pass" }],
    });
  });

  it("exchanges a Cloudflare server token for temporary credentials", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            iceServers: [
              {
                urls: ["turns:turn.cloudflare.com:443?transport=tcp"],
                username: "short-lived",
                credential: "ephemeral",
              },
            ],
          }),
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createIceProvider({
      CLOUDFLARE_TURN_KEY_ID: "key-id",
      CLOUDFLARE_TURN_API_TOKEN: "private-api-token",
    });
    const config = await provider.getConfiguration();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer private-api-token",
        }),
        body: JSON.stringify({ ttl: 3600 }),
      }),
    );
    expect(config.iceServers[1]).toMatchObject({
      username: "short-lived",
      credential: "ephemeral",
    });
    expect(JSON.stringify(config)).not.toContain("private-api-token");
  });

  it("fails explicitly when the provider rejects a request or omits relay credentials", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("private details", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ iceServers: [{ urls: "stun:stun.example:3478" }] }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const provider = createIceProvider({
      CLOUDFLARE_TURN_KEY_ID: "key",
      CLOUDFLARE_TURN_API_TOKEN: "secret",
    });
    await expect(provider.getConfiguration()).rejects.toThrow(
      "could not issue credentials",
    );
    await expect(provider.getConfiguration()).rejects.toThrow(
      "no relay servers",
    );
  });

  it.each([
    { ICE_TRANSPORT_POLICY: "relay" },
    { ICE_TRANSPORT_POLICY: "wrong" },
    { TURN_URLS: "https://wrong.example" },
    { TURN_USERNAME: "incomplete" },
    { CLOUDFLARE_TURN_KEY_ID: "incomplete" },
    {
      TURN_URLS: "turn:relay.example",
      TURN_SECRET: "secret",
      TURN_USERNAME: "user",
      TURN_PASSWORD: "pass",
    },
  ])("rejects incomplete or invalid settings: %j", (env) => {
    expect(() => createIceProvider(env)).toThrow();
  });
});

describe("public origin", () => {
  it("normalizes an HTTPS origin", () =>
    expect(publicOrigin("https://CALL.example.com/")).toBe(
      "https://call.example.com",
    ));
  it.each([
    "http://call.example.com",
    "https://call.example.com/path",
    "https://user:pass@call.example.com",
    "https://call.example.com?x=1",
    "not-a-url",
  ])("rejects unsafe public origins: %s", (origin) =>
    expect(() => publicOrigin(origin)).toThrow(),
  );
});
