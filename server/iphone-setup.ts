import { createServer } from "node:http";

// This bootstrap server exposes only a public certificate and instructions.
// It never resolves request paths against the filesystem or reads private keys.
export function createIPhoneSetupServer(
  certificate: Buffer,
  appOrigin: string,
) {
  const origin = new URL(appOrigin).origin;
  const htmlOrigin = origin.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tandem — iPhone setup</title>
<style>html{color-scheme:dark}body{font:16px/1.7 system-ui,sans-serif;background:#101411;color:#edf0e9;margin:0;padding:28px 22px}main{max-width:560px;margin:36px auto}h1{font-size:34px;letter-spacing:-1.5px;line-height:1.2}h2{font-size:17px;margin:24px 0 6px}p{color:#b4c1a9;margin:8px 0 18px}.brand{font-size:24px;font-weight:700;color:#d2f5a1}a{color:#d2f5a1}.button{display:block;text-align:center;padding:13px 18px;border-radius:9px;background:#d2f5a1;color:#20301c;font-weight:650;text-decoration:none;margin:16px 0}li{padding-left:4px;margin:12px 0}small{display:block;color:#92a283;line-height:1.8;border-top:1px solid #34402c;margin-top:32px;padding-top:18px}.url{overflow-wrap:anywhere;font-size:14px}</style>
</head><body><main><div class="brand">tandem.</div><h1>Enable your iPhone camera.</h1><p>Keep your iPhone and computer on the same Wi-Fi. First, trust this computer’s local development certificate.</p>
<h2>1. Download the public certificate</h2><a class="button" href="/tandem-rootCA.crt">Download certificate</a><p>Open this page in Safari, then allow the certificate profile download.</p>
<h2>2. Install and trust it</h2><ol><li>Open <strong>Settings → General → VPN &amp; Device Management</strong> (or <strong>Profile Downloaded</strong>). Select the mkcert profile and install it.</li><li>Open <strong>Settings → General → About → Certificate Trust Settings</strong>. Enable full trust for the mkcert root certificate.</li></ol>
<h2>3. Open your secure call app</h2><a class="button" href="${htmlOrigin}">Open Tandem over HTTPS</a><p class="url">${htmlOrigin}</p><p>Create a call or open an invite and tap <strong>Join call</strong>. Allow access to the devices you want to use. If you denied access earlier, change Safari’s camera and microphone permissions for this site.</p>
<small>This setup page serves only the public CA certificate; private keys are never served. After testing, remove the profile in VPN &amp; Device Management. <a href="https://support.apple.com/en-us/102390">Apple’s certificate trust instructions</a>.</small>
</main></body></html>`;
  return createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : page);
    } else if (path === "/tandem-rootCA.crt") {
      response.writeHead(200, {
        "Content-Type": "application/x-x509-ca-cert",
        "Content-Disposition": 'attachment; filename="tandem-rootCA.crt"',
        "Content-Length": certificate.length,
      });
      response.end(request.method === "HEAD" ? undefined : certificate);
    } else {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
}
