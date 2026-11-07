import assert from "node:assert/strict";
import test from "node:test";
import { createNoteVisualResponseSchema, parseNoteVisualObservations } from "../src/note-visual-output.js";

function rejects(response: string, count: number, code: "VISION_INVALID_JSON" | "VISION_INCOMPLETE"): void {
  assert.throws(() => parseNoteVisualObservations(response, count), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code: string }).code, code);
    assert.doesNotMatch(error.message, /private-model-marker/);
    assert.equal("cause" in error, false, "provider output must not be attached to public errors");
    return true;
  });
}

test("visual response schemas require exactly one or four ordered string observations", () => {
  for (const count of [1, 4]) {
    const schema = createNoteVisualResponseSchema(count);
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["observations"]);
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(properties), ["observations"]);
    assert.equal(properties.observations.type, "array");
    assert.equal(properties.observations.minItems, count);
    assert.equal(properties.observations.maxItems, count);
    assert.deepEqual(properties.observations.items, { type: "string" });
    assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema, "schemas must be JSON serializable");
  }
});

test("observations preserve input order and trim whitespace for single and full image batches", () => {
  assert.deepEqual(parseNoteVisualObservations('{"observations":["  Page 24 diagram.\\n"]}', 1), ["Page 24 diagram."]);
  assert.deepEqual(parseNoteVisualObservations(JSON.stringify({ observations: ["first diagram", "  第二张：箭头向右。  ", "third photo", "fourth chart"] }), 4), ["first diagram", "第二张：箭头向右。", "third photo", "fourth chart"]);
});

test("complete JSON fences are accepted without accepting prose or partial wrappers", () => {
  assert.deepEqual(parseNoteVisualObservations('  ```json\n{"observations":["diagram"]}\n```  ', 1), ["diagram"]);
  assert.deepEqual(parseNoteVisualObservations('```JSON\r\n{"observations":["diagram"]}\r\n```', 1), ["diagram"]);
  for (const response of [
    '```\n{"observations":["private-model-marker"]}\n```',
    '```json\n{"observations":["private-model-marker"]}',
    '{"observations":["private-model-marker"]}\n```',
    '```json\n{"observations":["private-model-marker"]}\n```\nextra prose',
    'Here is the result: {"observations":["private-model-marker"]}',
  ]) rejects(response, 1, "VISION_INVALID_JSON");
});

test("malformed JSON has a safe error and is never repaired", () => {
  for (const response of [
    "", "private-model-marker", '{"observations":["private-model-marker"',
    '{"observations":["private-model-marker",]}',
    '{"observations":["private-model-marker"]} {}',
    '```json\n{"observations":["private-model-marker",]}\n```',
  ]) rejects(response, 1, "VISION_INVALID_JSON");
});

test("valid JSON with wrong shapes, fields or observation counts is rejected", () => {
  for (const value of [
    null, false, 1, "private-model-marker", [], {},
    { pages: [{ page: 24, observation: "private-model-marker" }] },
    { observations: ["private-model-marker"], pages: [] },
    { observations: ["private-model-marker"], extra: true },
    { observations: null }, { observations: {} }, { observations: "private-model-marker" },
    { observations: [] }, { observations: ["one", "two"] },
    { observations: [null] }, { observations: [false] }, { observations: [24] },
    { observations: [{ observation: "private-model-marker" }] }, { observations: [["private-model-marker"]] },
    { observations: [""] }, { observations: [" \t\r\n "] },
  ]) rejects(JSON.stringify(value), 1, "VISION_INCOMPLETE");
  rejects('{"observations":["one","two","three"]}', 4, "VISION_INCOMPLETE");
  rejects('{"observations":["one","two","three","four","five"]}', 4, "VISION_INCOMPLETE");
  rejects('{"observations":["one","two"," ","four"]}', 4, "VISION_INCOMPLETE");
});

test("invalid batch sizes are caller errors for both schema construction and parsing", () => {
  for (const count of [-1, 0, 1.5, 5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => createNoteVisualResponseSchema(count), RangeError);
    assert.throws(() => parseNoteVisualObservations('{"observations":["diagram"]}', count), RangeError);
  }
});
