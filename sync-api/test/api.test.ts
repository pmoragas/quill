import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { keyFor } from "../src/paths";

const AUTH = { Authorization: "Bearer token-desktop" };
const PHONE = { Authorization: "Bearer token-phone" };
const url = (path: string) => `https://sync.test/v1/files/${path.split("/").map(encodeURIComponent).join("/")}`;

function put(path: string, body: string, headers: Record<string, string>) {
  return SELF.fetch(url(path), { method: "PUT", body, headers });
}

beforeEach(async () => {
  const all = await env.BUCKET.list();
  await env.BUCKET.delete(all.objects.map((o) => o.key));
});

describe("authentication", () => {
  it("rejects requests without a valid device token", async () => {
    expect((await SELF.fetch("https://sync.test/v1/files")).status).toBe(401);
    expect((await SELF.fetch("https://sync.test/v1/files", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
    expect((await SELF.fetch("https://sync.test/v1/files", { headers: { Authorization: "token-desktop" } })).status).toBe(401);
  });

  it("accepts every registered device", async () => {
    expect((await SELF.fetch("https://sync.test/v1/files", { headers: AUTH })).status).toBe(200);
    expect((await SELF.fetch("https://sync.test/v1/files", { headers: PHONE })).status).toBe(200);
  });

  it("answers the health check without a token", async () => {
    expect((await SELF.fetch("https://sync.test/health")).status).toBe(200);
  });
});

describe("paths", () => {
  // URL parsing already turns "/../x" into "/x" and "\\" into "/" before the Worker sees the request,
  // so only encoded separators can reach the path check through HTTP.
  it.each(["a%2F..%2Fb.md", "%2Fetc%2Fpasswd", "a%2F%2Fb.md", "a%2F.%2Fb.md", "C%3A%2Fx.md", "a%5Cb.md", "a%00b.md"])(
    "rejects the encoded path %s",
    async (path) => {
      const res = await SELF.fetch(`https://sync.test/v1/files/${path}`, { headers: AUTH });
      expect(res.status).toBe(400);
    },
  );

  it("never serves anything for plain traversal URLs", async () => {
    await env.BUCKET.put("secret.md", "outside the vault");
    for (const path of ["../secret.md", "a/../../secret.md"]) {
      const res = await SELF.fetch(`https://sync.test/v1/files/${path}`, { headers: AUTH });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).not.toContain("outside the vault");
    }
  });

  it("maps vault paths to keys inside the vault prefix only", () => {
    expect(keyFor("notes/a.md")).toBe("vault/notes/a.md");
    for (const bad of ["", "/a.md", "a/", "a//b", "./a", "a/./b", "../a", "a/../b", "a\\b", "C:/x", "a\u0000b"]) {
      expect(keyFor(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(keyFor("x".repeat(513))).toBeNull();
  });

  it("accepts spaces, accents and nested folders", async () => {
    const res = await put("Agent Engineering/1 Visió general.md", "# Hola", { ...AUTH, "If-None-Match": "*" });
    expect(res.status).toBe(200);
    const read = await SELF.fetch(url("Agent Engineering/1 Visió general.md"), { headers: AUTH });
    expect(await read.text()).toBe("# Hola");
  });
});

describe("writing", () => {
  it("creates a new file once, then refuses to create it again", async () => {
    expect((await put("a.md", "one", { ...AUTH, "If-None-Match": "*" })).status).toBe(200);
    const again = await put("a.md", "two", { ...PHONE, "If-None-Match": "*" });
    expect(again.status).toBe(412);
    expect(await (await SELF.fetch(url("a.md"), { headers: AUTH })).text()).toBe("one");
  });

  it("refuses a write that does not say what it replaces", async () => {
    const res = await put("a.md", "blind", AUTH);
    expect(res.status).toBe(428);
    expect((await env.BUCKET.head("vault/a.md"))).toBeNull();
  });

  it("replaces a file when the version matches and returns the new version", async () => {
    const first = await (await put("a.md", "v1", { ...AUTH, "If-None-Match": "*" })).json<{ etag: string }>();
    const second = await put("a.md", "v2", { ...AUTH, "If-Match": first.etag });
    expect(second.status).toBe(200);
    const { etag } = await second.json<{ etag: string }>();
    expect(etag).not.toBe(first.etag);
    expect(await (await SELF.fetch(url("a.md"), { headers: AUTH })).text()).toBe("v2");
  });

  it("accepts the version in the quoted ETag form", async () => {
    const created = await put("a.md", "v1", { ...AUTH, "If-None-Match": "*" });
    const quoted = created.headers.get("ETag")!;
    expect(quoted.startsWith('"')).toBe(true);
    expect((await put("a.md", "v2", { ...AUTH, "If-Match": quoted })).status).toBe(200);
  });

  it("does not lose an edit: the second device is told it conflicts", async () => {
    const base = await (await put("a.md", "base", { ...AUTH, "If-None-Match": "*" })).json<{ etag: string }>();
    // Both devices last saw `base`. The desktop saves first.
    expect((await put("a.md", "desktop edit", { ...AUTH, "If-Match": base.etag })).status).toBe(200);
    const stale = await put("a.md", "phone edit", { ...PHONE, "If-Match": base.etag });
    expect(stale.status).toBe(412);
    expect((await stale.json<{ error: string }>()).error).toBe("conflict");
    expect(await (await SELF.fetch(url("a.md"), { headers: AUTH })).text()).toBe("desktop edit");
  });

  it("rejects files over the size limit", async () => {
    const big = "x".repeat(21 * 1024 * 1024);
    const res = await put("big.bin", big, { ...AUTH, "If-None-Match": "*" });
    expect(res.status).toBe(413);
  });

  it("stores binary content unchanged", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 255]);
    await SELF.fetch(url("assets/pixel.png"), { method: "PUT", body: bytes, headers: { ...AUTH, "If-None-Match": "*", "Content-Type": "image/png" } });
    const read = await SELF.fetch(url("assets/pixel.png"), { headers: AUTH });
    expect(read.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(bytes);
  });
});

describe("reading and listing", () => {
  it("returns 404 for a missing file", async () => {
    expect((await SELF.fetch(url("nope.md"), { headers: AUTH })).status).toBe(404);
  });

  it("answers HEAD with the version and no body", async () => {
    await put("a.md", "hello", { ...AUTH, "If-None-Match": "*" });
    const head = await SELF.fetch(url("a.md"), { method: "HEAD", headers: AUTH });
    expect(head.status).toBe(200);
    expect(head.headers.get("ETag")).toBeTruthy();
    expect(await head.text()).toBe("");
  });

  it("lists vault paths with versions, and nothing outside the vault", async () => {
    await put("b.md", "b", { ...AUTH, "If-None-Match": "*" });
    await put("folder/a.md", "a", { ...AUTH, "If-None-Match": "*" });
    await env.BUCKET.put("other/ignored.md", "not part of the vault");
    const res = await SELF.fetch("https://sync.test/v1/files", { headers: AUTH });
    const { files } = await res.json<{ files: { path: string; etag: string; size: number }[] }>();
    expect(files.map((f) => f.path)).toEqual(["b.md", "folder/a.md"]);
    expect(files[0].size).toBe(1);
    expect(files[0].etag).toBeTruthy();
  });

  it("pages through large listings with a cursor", async () => {
    for (let i = 0; i < 3; i++) await env.BUCKET.put(`vault/n${i}.md`, String(i));
    const res = await SELF.fetch("https://sync.test/v1/files", { headers: AUTH });
    const body = await res.json<{ files: unknown[]; cursor?: string }>();
    expect(body.files.length).toBe(3);
    expect(body.cursor).toBeUndefined();
  });
});

describe("deleting", () => {
  it("deletes when the version matches", async () => {
    const created = await (await put("a.md", "x", { ...AUTH, "If-None-Match": "*" })).json<{ etag: string }>();
    const res = await SELF.fetch(url("a.md"), { method: "DELETE", headers: { ...AUTH, "If-Match": created.etag } });
    expect(await res.json()).toEqual({ deleted: true });
    expect(await env.BUCKET.head("vault/a.md")).toBeNull();
  });

  it("keeps a file that another device edited in the meantime", async () => {
    const base = await (await put("a.md", "base", { ...AUTH, "If-None-Match": "*" })).json<{ etag: string }>();
    await put("a.md", "edited", { ...PHONE, "If-Match": base.etag });
    const res = await SELF.fetch(url("a.md"), { method: "DELETE", headers: { ...AUTH, "If-Match": base.etag } });
    expect(res.status).toBe(412);
    expect(await (await SELF.fetch(url("a.md"), { headers: AUTH })).text()).toBe("edited");
  });

  it("requires a version, and treats a missing file as already deleted", async () => {
    expect((await SELF.fetch(url("a.md"), { method: "DELETE", headers: AUTH })).status).toBe(428);
    const gone = await SELF.fetch(url("a.md"), { method: "DELETE", headers: { ...AUTH, "If-Match": "abc" } });
    expect(await gone.json()).toEqual({ deleted: false });
  });
});
