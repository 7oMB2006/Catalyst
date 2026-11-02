import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { AcquisitionError } from "../src/acquisition.js";
import type { ExecutionContext } from "../src/contracts.js";
import type { NoteResearchRequest, XiaohongshuNoteSource } from "../src/note-contracts.js";
import { acquireNoteImages, resolveXiaohongshuNote } from "../src/adapters/xiaohongshu-note.js";

const ID = "6ae80a83000000001a0153d3";
const URL = `https://www.xiaohongshu.com/discovery/item/${ID}?xsec_token=fixture-share-token&xsec_source=app_share&type=video`;
const request: NoteResearchRequest = { url: URL, question: "What does this article say?", mode: "text" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lVcAAAAASUVORK5CYII=", "base64");

function context(ms = 5000): ExecutionContext { return { signal: AbortSignal.timeout(ms), deadlineMs: Date.now() + ms }; }
function code(expected: string) { return (error: unknown): boolean => error instanceof AcquisitionError && error.code === expected; }
function note(extra: Record<string, unknown> = {}) {
  return { noteId: ID, type: "normal", title: "A fixture article", desc: "An author explains automatic scheduling.", user: { nickName: "Fixture author" },
    imageList: [{ url: "http://sns-webpic-qc.xhscdn.com/one?sign=fixture-image-token", width: 1440, height: 2400 }, { urlDefault: "https://sns-webpic-qc.xhscdn.com/two", width: 1440, height: 2400 }],
    Cookie: "fixture-private-cookie", raw_private_field: "fixture-private-state", ...extra };
}
function html(value: Record<string, unknown>, schema: "mobile" | "desktop" = "mobile"): string {
  const payload = schema === "mobile" ? { LAUNCHER_SSR_STORE_PAGE_DATA: { noteData: value } } : { note: { noteDetailMap: { [ID]: { note: value } } } };
  return `<html><script>window.${schema === "mobile" ? "__SETUP_SERVER_STATE__" : "__INITIAL_STATE__"}=${JSON.stringify(payload)};</script></html>`;
}
function pageResponse(body: string) { return new Response(body, { headers: { "content-type": "text/html" } }); }
function imageResponse(body: BodyInit = PNG) { return new Response(body, { headers: { "content-type": "image/png" } }); }
function fixtureSource(): XiaohongshuNoteSource {
  return { id: ID, sourceUrl: URL, canonicalUrl: URL, title: "Fixture", description: "Description", contentType: "image_note",
    pages: [{ index: 1, url: "http://sns-webpic-qc.xhscdn.com/one", width: 1440, height: 2400 }, { index: 2, url: "https://sns-webpic-qc.xhscdn.com/two" }] };
}
async function withFetch<T>(implementation: typeof fetch, action: () => Promise<T>): Promise<T> {
  const old = globalThis.fetch;
  globalThis.fetch = implementation;
  try { return await action(); } finally { globalThis.fetch = old; }
}
async function temporaryDirectories() { return (await fs.readdir(tmpdir())).filter((name) => name.startsWith("catalyst-note-images-")).sort(); }

test("note resolver accepts both platform state schemas, exact identities and ordered original images", async () => {
  for (const schema of ["mobile", "desktop"] as const) {
    await withFetch((async (input, init) => {
      const received = new globalThis.URL(String(input));
      assert.equal(received.pathname, `/explore/${ID}`);
      assert.equal(received.searchParams.get("xsec_token"), "fixture-share-token");
      assert.match(new Headers(init?.headers).get("User-Agent") ?? "", /Android.*Mobile/);
      assert.equal(init?.redirect, "manual");
      assert.equal(init?.credentials, "omit");
      assert.equal(new Headers(init?.headers).has("Cookie"), false);
      return pageResponse(html(note(), schema));
    }) as typeof fetch, async () => {
      const source = await resolveXiaohongshuNote(request, context());
      assert.equal(source.contentType, "image_note", "type=video in the share query is not source evidence");
      assert.equal(source.id, ID);
      assert.equal(source.title, "A fixture article");
      assert.equal(source.uploader, "Fixture author");
      assert.deepEqual(source.pages.map((page) => [page.index, new globalThis.URL(page.url).pathname]), [[1, "/one"], [2, "/two"]]);
      assert.equal(new globalThis.URL(source.pages[0].url).protocol, "https:");
      assert.equal(new globalThis.URL(source.pages[0].url).searchParams.get("sign"), "fixture-image-token");
      assert.equal(new globalThis.URL(source.canonicalUrl).searchParams.get("xsec_token"), "fixture-share-token");
      assert.doesNotMatch(JSON.stringify(source), /private-cookie|private-state|noteDetailMap|LAUNCHER_SSR/);
    });
  }
});

test("source type must come from matching note data rather than images, captions or a share flag", async () => {
  let body = html(note({ noteId: "6411cf99000000001300b6d9" }));
  await withFetch((async () => pageResponse(body)) as typeof fetch, async () => {
    await assert.rejects(() => resolveXiaohongshuNote(request, context()), code("INVALID_METADATA"));
    body = html(note({ noteId: undefined }));
    await assert.rejects(() => resolveXiaohongshuNote(request, context()), code("INVALID_METADATA"));
    body = html(note({ type: "video" }));
    const video = await resolveXiaohongshuNote(request, context());
    assert.equal(video.contentType, "video_note");
    assert.deepEqual(video.pages, [], "a video cover must not become an article page");
    body = html(note({ type: "unknown" }));
    await assert.rejects(() => resolveXiaohongshuNote(request, context()), code("UNSUPPORTED_CONTENT"));
    body = "<html>Accessible shell without source data</html>";
    await assert.rejects(() => resolveXiaohongshuNote(request, context()), code("MEDIA_UNAVAILABLE"));
  });
});

test("page state parsing never evaluates executable syntax and only normalizes undefined outside strings", async () => {
  const name = "__catalystNoteSourceInjected";
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals[name];
  globals[name] = false;
  let body = html(note({ desc: 'A quoted brace } and escaped quote " and undefined remain text.', missing: null })).replace('"missing":null', '"missing":undefined');
  try {
    await withFetch((async () => pageResponse(body)) as typeof fetch, async () => {
      const source = await resolveXiaohongshuNote(request, context());
      assert.equal(source.description, 'A quoted brace } and escaped quote " and undefined remain text.');
      body = html(note()).replace('"type":"normal"', `"type":(()=>{globalThis.${name}=true;return "normal"})()`);
      await assert.rejects(() => resolveXiaohongshuNote(request, context()), code("INVALID_METADATA"));
      assert.equal(globals[name], false);
      body = html(note()).replace(";</script>", `;globalThis.${name}=true;</script>`);
      assert.equal((await resolveXiaohongshuNote(request, context())).contentType, "image_note");
      assert.equal(globals[name], false, "trailing page JavaScript is not executed");
      body = '<script>window.__SETUP_SERVER_STATE__={"broken":</script>';
      await assert.rejects(() => resolveXiaohongshuNote(request, context()), code("INVALID_METADATA"));
    });
  } finally { if (previous === undefined) delete globals[name]; else globals[name] = previous; }
});

test("note requests guard every redirect and distinguish login, unavailable and blocked responses", async () => {
  let destination = "https://www.xiaohongshu.com.evil.invalid/steal?token=fixture-private-token";
  let calls = 0;
  await withFetch((async () => { calls++; return new Response(null, { status: 302, headers: { location: destination } }); }) as typeof fetch, async () => {
    for (const unsafe of [destination, `http://www.xiaohongshu.com/explore/${ID}`, `https://user:pass@www.xiaohongshu.com/explore/${ID}`, `https://www.xiaohongshu.com:8443/explore/${ID}`]) {
      destination = unsafe; calls = 0;
      await assert.rejects(() => resolveXiaohongshuNote(request, context()), (error: unknown) => {
        assert.ok(error instanceof AcquisitionError);
        assert.equal(error.code, "INVALID_URL");
        assert.doesNotMatch(error.message, /fixture-private-token|steal/);
        return true;
      });
      assert.equal(calls, 1, "unsafe destination must never be fetched");
    }
    for (const [path, expected] of [["/login?redirect=private", "AUTH_REQUIRED"], ["/404/sec_fixture?error_code=300031", "CONTENT_UNAVAILABLE"]] as const) {
      destination = `https://www.xiaohongshu.com${path}`;
      await assert.rejects(() => resolveXiaohongshuNote(request, context()), code(expected));
    }
    destination = `https://www.xiaohongshu.com/explore/${ID}`; calls = 0;
    await assert.rejects(() => resolveXiaohongshuNote(request, context()), code("RESOLUTION_FAILED"));
    assert.equal(calls, 6);
  });
  for (const [status, expected] of [[401, "AUTH_REQUIRED"], [403, "ACCESS_BLOCKED"], [412, "ACCESS_BLOCKED"], [404, "CONTENT_UNAVAILABLE"], [410, "CONTENT_UNAVAILABLE"], [429, "UPSTREAM_ERROR"]] as const) {
    await withFetch((async () => new Response(null, { status })) as typeof fetch, async () => {
      await assert.rejects(() => resolveXiaohongshuNote(request, context()), code(expected));
    });
  }
});

test("note HTML and chunked bodies enforce byte limits and cancelled requests stop before fetching", async () => {
  let cancelled = false;
  await withFetch((async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-length": String(8 * 1024 * 1024 + 1) } })) as typeof fetch, async () => {
    await assert.rejects(() => resolveXiaohongshuNote(request, context()), code("RESOURCE_LIMIT"));
    assert.equal(cancelled, true);
  });
  cancelled = false;
  await withFetch((async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } }))) as typeof fetch, async () => {
    await assert.rejects(() => resolveXiaohongshuNote(request, context()), code("RESOURCE_LIMIT"));
    assert.equal(cancelled, true, "chunked content must be cancelled at the actual byte budget");
  });
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await withFetch((async () => { calls++; throw new Error("must not fetch"); }) as typeof fetch, async () => {
    await assert.rejects(() => resolveXiaohongshuNote(request, { signal: controller.signal, deadlineMs: Date.now() + 1000 }));
    await assert.rejects(() => resolveXiaohongshuNote(request, { signal: new AbortController().signal, deadlineMs: Date.now() - 1 }), code("TIMEOUT"));
    assert.equal(calls, 0);
  });
});

test("image metadata cannot authorize arbitrary hosts or silently remove a source page", async () => {
  let body = html(note({ imageList: [{ url: "https://xhscdn.com.evil.invalid/one" }] }));
  await withFetch((async () => pageResponse(body)) as typeof fetch, async () => {
    await assert.rejects(() => resolveXiaohongshuNote(request, context()), code("INVALID_METADATA"));
    body = html(note({ imageList: [{ url: "https://sns-webpic-qc.xhscdn.com/one" }, {}] }));
    await assert.rejects(() => resolveXiaohongshuNote(request, context()), code("INVALID_METADATA"));
  });
});

test("image acquisition keeps source order, safe HTTPS sources and explicit disposal", async () => {
  const calls: string[] = [];
  await withFetch((async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.credentials, "omit");
    assert.ok(new globalThis.URL(String(input)).protocol === "https:");
    return imageResponse();
  }) as typeof fetch, async () => {
    const asset = await acquireNoteImages(fixtureSource(), [2, 1], context());
    try {
      assert.deepEqual(asset.pages.map((page) => page.index), [1, 2]);
      assert.equal(asset.bytes, PNG.byteLength * 2);
      assert.deepEqual(calls.map((raw) => new globalThis.URL(raw).pathname), ["/one", "/two"]);
      assert.deepEqual(await fs.readFile(asset.pages[0].path), PNG);
    } finally { await asset.dispose(); }
    await assert.rejects(() => fs.access(asset.directory));
  });
});

test("unsafe image redirects, oversized media and malformed image bytes clean all partial files", async () => {
  const before = await temporaryDirectories();
  let calls = 0;
  for (const failure of ["redirect", "size", "not-image", "cancel"] as const) {
    calls = 0;
    const controller = new AbortController();
    const ctx = { signal: controller.signal, deadlineMs: Date.now() + 5000 };
    await withFetch((async () => {
      calls++;
      if (calls === 1) return imageResponse();
      if (failure === "redirect") return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private?sign=fixture-private-token" } });
      if (failure === "size") return new Response(null, { headers: { "content-type": "image/png", "content-length": String(12 * 1024 * 1024 + 1) } });
      if (failure === "cancel") { controller.abort(new DOMException("Fixture cancelled", "AbortError")); return imageResponse(); }
      return imageResponse("<html>Not an image</html>");
    }) as typeof fetch, async () => {
      await assert.rejects(() => acquireNoteImages(fixtureSource(), [1, 2], ctx), (error: unknown) => {
        if (failure === "cancel") assert.equal((error as Error).name, "AbortError");
        else assert.equal((error as AcquisitionError).code, failure === "redirect" ? "INVALID_METADATA" : failure === "size" ? "RESOURCE_LIMIT" : "INVALID_MEDIA");
        assert.doesNotMatch((error as Error).message, /fixture-private-token/);
        return true;
      });
      assert.equal(calls, 2);
    });
    assert.deepEqual(await temporaryDirectories(), before);
  }
});

test("page selection rejects duplicates, missing pages and video covers before network access", async () => {
  let calls = 0;
  await withFetch((async () => { calls++; throw new Error("must not fetch"); }) as typeof fetch, async () => {
    for (const selected of [[0], [1.5], [3], [1, 1]]) await assert.rejects(() => acquireNoteImages(fixtureSource(), selected, context()), code("INVALID_PAGE_RANGE"));
    await assert.rejects(() => acquireNoteImages({ ...fixtureSource(), contentType: "video_note" }, [1], context()), code("UNSUPPORTED_CONTENT"));
    assert.equal(calls, 0);
  });
});

test("a stalled streamed image obeys the overall deadline and cleans its temporary directory", async () => {
  const before = await temporaryDirectories();
  let cancelled = false;
  await withFetch((async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": "image/png" } })) as typeof fetch, async () => {
    await assert.rejects(() => acquireNoteImages(fixtureSource(), [1], context(50)), (error: unknown) => (error as Error).name === "TimeoutError");
  });
  assert.equal(cancelled, true);
  assert.deepEqual(await temporaryDirectories(), before);
});

test("the aggregate image budget is enforced even when every individual image fits", { timeout: 20_000 }, async () => {
  const before = await temporaryDirectories();
  const body = Buffer.alloc(12 * 1024 * 1024);
  PNG.copy(body);
  let calls = 0;
  const source = fixtureSource();
  source.pages = Array.from({ length: 11 }, (_, index) => ({ index: index + 1, url: `https://sns-webpic-qc.xhscdn.com/page-${index + 1}` }));
  await withFetch((async () => {
    calls++;
    return new Response(body, { headers: { "content-type": "image/png", "content-length": String(body.byteLength) } });
  }) as typeof fetch, async () => {
    await assert.rejects(() => acquireNoteImages(source, source.pages.map((page) => page.index), context(15_000)), code("RESOURCE_LIMIT"));
    assert.equal(calls, 11, "ten 12 MiB images fit, the next exceeds the 128 MiB aggregate budget");
  });
  assert.deepEqual(await temporaryDirectories(), before);
});
