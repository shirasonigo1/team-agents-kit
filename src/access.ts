/**
 * Access control: one shared passcode for the whole prototype.
 *
 * - The passcode is a Worker secret, ACCESS_PASSCODE (`npx wrangler secret put ACCESS_PASSCODE`;
 *   locally it comes from .dev.vars). It never appears in code, config or the repo.
 * - Fails closed: if the secret isn't set, every request gets 503 "Access is not configured".
 * - Browsers sign in at /login and get a signed, HttpOnly session cookie (7 days). The signature is
 *   an HMAC keyed by the passcode, so changing the passcode signs everyone out.
 * - Scripts (scripts/run-test.mjs) send `Authorization: Bearer <passcode>` instead.
 * - Everything is gated: pages, static files, /api/*, /agents/* (HTTP and WebSocket).
 *   Only /login, /logout and /api/health are public. /api/health reveals nothing sensitive.
 *
 * Cloudflare Access (Zero Trust) is the stronger, per-person option; this keeps the prototype free
 * and self-contained.
 */

const COOKIE = "ask_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const PUBLIC_PATHS = new Set(["/login", "/logout", "/api/health"]);

/** The secret is read loosely: `wrangler types` only lists it in Env when .dev.vars exists. */
type AccessEnv = { ACCESS_PASSCODE?: string };

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time comparison (hash both sides first so lengths don't leak). */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

async function makeSession(secret: string): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  return `${expires}.${await hmac(secret, `session:${expires}`)}`;
}

async function validSession(secret: string, value: string | null): Promise<boolean> {
  if (!value) return false;
  const [exp, sig] = value.split(".");
  const expires = Number(exp);
  if (!sig || !Number.isInteger(expires) || expires < Date.now() / 1000) return false;
  return safeEqual(sig, await hmac(secret, `session:${expires}`));
}

async function isAuthorized(request: Request, secret: string): Promise<boolean> {
  const auth = request.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return safeEqual(auth.slice(7), secret);
  return validSession(secret, readCookie(request, COOKIE));
}

/** Only allow same-site relative paths as the post-login redirect. */
function safeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function loginPage(next: string, error: string | null, status = 200): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Team Agents Kit</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#F5F4EF;color:#18181B;font:15px/1.5 Inter,system-ui,sans-serif}
main{width:100%;max-width:400px;display:flex;flex-direction:column;gap:16px;padding:28px;background:#fff;border:1px solid #E3E1D9;border-radius:18px}
.brand{display:flex;align-items:center;gap:10px;font:700 18px 'Space Grotesk',Inter,sans-serif}
h1{margin:0;font:700 26px 'Space Grotesk',Inter,sans-serif;letter-spacing:-.02em}p{margin:0;color:#5B5B66}
label{font-size:13px;color:#5B5B66}input{width:100%;height:44px;margin-top:6px;padding:0 12px;border:1px solid #D4D1C6;border-radius:10px;font:inherit;color:#18181B}
input:focus-visible,button:focus-visible{outline:3px solid #2F4ACF;outline-offset:2px}
button{min-height:48px;border:0;border-radius:12px;background:#2F4ACF;color:#fff;font:600 15px Inter,sans-serif;cursor:pointer}button:hover{background:#1F338F}
.error{padding:12px;border-radius:12px;background:#FDEEE6;color:#9A3412;font-size:14px}
</style></head><body><main>
<div class="brand"><svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="#18181B" stroke-width="2" aria-hidden="true"><circle cx="14" cy="6" r="3.5"/><circle cx="6" cy="21" r="3.5"/><circle cx="22" cy="21" r="3.5"/><path d="M12.3 9 7.7 18M15.7 9l4.6 9M9.5 21h9"/></svg>Team Agents Kit</div>
<h1>Sign in</h1><p>This prototype is private. Enter the team passcode to continue.</p>
${error ? `<div class="error" role="alert">${escapeHtml(error)}</div>` : ""}
<form method="post" action="/login"><input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="passcode">Passcode</label><input id="passcode" name="passcode" type="password" autocomplete="current-password" required autofocus>
<button type="submit" style="width:100%;margin-top:16px">Sign in</button></form>
</main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
}

/**
 * The access gate. Returns a Response when the request is handled here (login/logout, or denied);
 * returns null when the request is authorized and should continue to the app.
 */
export async function accessGate(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";
  const secret = (env as AccessEnv).ACCESS_PASSCODE ?? "";
  const secure = url.protocol === "https:";

  if (path === "/api/health") return null;

  if (!secret) {
    return new Response("Access is not configured: set the ACCESS_PASSCODE secret (npx wrangler secret put ACCESS_PASSCODE).", {
      status: 503, headers: { "content-type": "text/plain; charset=utf-8" }
    });
  }

  if (path === "/logout") {
    return new Response(null, { status: 303, headers: { location: "/login", "set-cookie": cookie("", 0, secure) } });
  }

  if (path === "/login") {
    if (request.method === "GET") {
      if (await isAuthorized(request, secret)) return Response.redirect(new URL(safeNext(url.searchParams.get("next")), url).toString(), 303);
      return loginPage(safeNext(url.searchParams.get("next")), null);
    }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    const form = await request.formData().catch(() => null);
    const passcode = String(form?.get("passcode") ?? "");
    const next = safeNext(String(form?.get("next") ?? "/"));
    if (!passcode || !(await safeEqual(passcode, secret))) {
      await new Promise((r) => setTimeout(r, 750)); // slow down guessing
      return loginPage(next, "That passcode is not right.", 401);
    }
    return new Response(null, { status: 303, headers: { location: next, "set-cookie": cookie(await makeSession(secret), SESSION_SECONDS, secure) } });
  }

  if (await isAuthorized(request, secret)) return null;

  const wantsHtml = request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
  if (wantsHtml && !path.startsWith("/api/") && !path.startsWith("/agents/")) {
    return Response.redirect(new URL(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, url).toString(), 303);
  }
  return Response.json({ error: "Sign in required" }, { status: 401 });
}
