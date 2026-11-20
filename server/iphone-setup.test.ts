import { expect, it } from "vitest";
import { createIPhoneSetupServer } from "./iphone-setup";

it("serves only the public certificate and setup page, never private key paths", async () => {
  const publicCertificate = Buffer.from("public certificate fixture");
  const server = createIPhoneSetupServer(
    publicCertificate,
    "https://192.168.1.25:5173",
  );
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test address");
    const base = `http://127.0.0.1:${address.port}`;
    const page = await fetch(base);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('href="https://192.168.1.25:5173"');
    const download = await fetch(`${base}/tandem-rootCA.crt`);
    expect(download.headers.get("content-type")).toBe(
      "application/x-x509-ca-cert",
    );
    expect(Buffer.from(await download.arrayBuffer())).toEqual(
      publicCertificate,
    );
    for (const path of [
      "/dev-key.pem",
      "/rootCA-key.pem",
      "/.certs/dev-key.pem",
      "/%2e%2e/.certs/dev-key.pem",
    ]) {
      expect((await fetch(base + path)).status).toBe(404);
    }
    expect((await fetch(base, { method: "POST" })).status).toBe(405);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
