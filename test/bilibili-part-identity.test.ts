import assert from "node:assert/strict";
import test from "node:test";
import { getVideo, researchBilibiliVideo } from "../src/bilibili.js";
import { BilibiliAdapter } from "../src/adapters/bilibili.js";

const bvid = "BV1DTxXzUEvW";
const partTitle = "17、各式各样神奇的自注意力机制 Selfattention";
const canonicalUrl = `https://www.bilibili.com/video/${bvid}/?p=17`;
const partCid = 38_253_823_575;

function metadata() {
  return {
    aid: 115_332_370_992_204,
    cid: 100,
    title: "Machine learning course collection",
    duration: 60,
    owner: { name: "Course uploader", mid: 1 },
    pages: Array.from({ length: 52 }, (_, index) => ({
      cid: index === 16 ? partCid : 100 + index,
      duration: index === 16 ? 4276 : 60,
      part: index === 16 ? partTitle : `Lesson ${index + 1}`,
    })),
  };
}

test("Bilibili p=17 keeps the selected CID, duration and title without replacing the collection title", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/x/web-interface/view")) return Response.json({ code: 0, data: metadata() });
      if (url.includes("/x/tag/archive/tags")) return Response.json({ code: 0, data: [] });
      if (url.includes("/x/player/v2")) {
        assert.equal(new URL(url).searchParams.get("cid"), String(partCid));
        return Response.json({ code: 0, data: { need_login_subtitle: true } });
      }
      throw new Error(`Unexpected fixture URL: ${url}`);
    }) as typeof fetch;
    const result = await new BilibiliAdapter().resolve({ url: `${canonicalUrl}&share_source=copy_web`, question: "Explain this lesson", mode: "language" }, { signal: AbortSignal.timeout(5000), deadlineMs: Date.now() + 5000 });
    assert.equal(result.video.partId, String(partCid));
    assert.equal(result.video.durationSeconds, 4276);
    assert.equal(result.video.title, "Machine learning course collection");
    assert.equal(result.video.metadata?.part, 17);
    assert.equal(result.video.metadata?.part_title, partTitle);
    assert.equal(result.video.canonicalUrl, canonicalUrl);
    assert.equal(result.captions.status, "auth_required");
  } finally { globalThis.fetch = original; }
});

test("legacy BVR uses p=17 metadata and captions for both direct links and redirected shares", async () => {
  const original = globalThis.fetch;
  const names = ["CODEX_VIDEO_PROVIDER", "STEPFUN_BASE_URL", "STEPFUN_API_KEY"];
  const previous = names.map((name) => process.env[name]);
  const providerPrompts: string[] = [];
  try {
    process.env.CODEX_VIDEO_PROVIDER = "stepfun";
    process.env.STEPFUN_BASE_URL = "https://provider.test/v1";
    process.env.STEPFUN_API_KEY = "fixture-part-identity-key";
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url === "https://b23.tv/fixture-lesson") {
        assert.equal(init?.redirect, "manual");
        assert.ok(init?.signal);
        return new Response(null, { status: 302, headers: { location: `${canonicalUrl}&share_source=copy_web` } });
      }
      if (url.includes("/x/web-interface/view")) return Response.json({ code: 0, data: metadata() });
      if (url.includes("/x/tag/archive/tags")) return Response.json({ code: 0, data: [] });
      if (url.includes("/x/player/v2")) {
        assert.equal(new URL(url).searchParams.get("cid"), String(partCid));
        return Response.json({ code: 0, data: { subtitle: { subtitles: [{ lan: "zh", subtitle_url: "https://subtitle.test/lesson17.json" }] } } });
      }
      if (url === "https://subtitle.test/lesson17.json") return Response.json({ body: [{ from: 4205, to: 4220, content: "A statement from lesson seventeen near its end." }] });
      if (url === "https://provider.test/v1/chat/completions") {
        const body = JSON.parse(String(init?.body));
        providerPrompts.push(body.messages[0].content);
        return Response.json({ choices: [{ message: { content: "The selected lesson discusses attention." } }] });
      }
      throw new Error(`Unexpected fixture URL: ${url}`);
    }) as typeof fetch;
    for (const url of [canonicalUrl, "https://b23.tv/fixture-lesson"]) {
      // This window is valid only for lesson 17; lesson 1 is just 60 seconds.
      const result = await researchBilibiliVideo({ url, question: "What is explained in this interval?", mode: "language", mediaDetail: "default", includeComments: false, startSeconds: 4200, endSeconds: 4250 });
      assert.match(result, /"analysis":"complete"/);
      assert.match(result, /"duration_seconds": 4276/);
      assert.match(result, /"part_title": "17、各式各样神奇的自注意力机制 Selfattention"/);
      assert.match(result, /The selected lesson discusses attention/);
    }
    assert.equal(providerPrompts.length, 2);
    assert.ok(providerPrompts.every((prompt) => prompt.includes("[70:05-70:20] A statement from lesson seventeen")));
  } finally {
    globalThis.fetch = original;
    names.forEach((name, index) => previous[index] === undefined ? delete process.env[name] : process.env[name] = previous[index]);
  }
});

test("a selected Bilibili part with missing identity cannot fall back to first-part metadata", async () => {
  const original = globalThis.fetch;
  try {
    for (const brokenPart of [null, {}, { cid: partCid }, { cid: partCid, duration: 0 }]) {
      globalThis.fetch = (async () => {
        const data = metadata();
        (data.pages as unknown[])[16] = brokenPart;
        return Response.json({ code: 0, data });
      }) as typeof fetch;
      await assert.rejects(() => getVideo(bvid, 17), /valid identity and duration for the selected part/);
    }
  } finally { globalThis.fetch = original; }
});
