function validateCount(count: number): void {
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new RangeError("A visual batch must contain between one and four images.");
}

export function createNoteVisualResponseSchema(count: number): Record<string, unknown> {
  validateCount(count);
  return {
    type: "object",
    additionalProperties: false,
    required: ["observations"],
    properties: {
      observations: {
        type: "array", minItems: count, maxItems: count,
        items: { type: "string" },
      },
    },
  };
}

export function parseNoteVisualObservations(response: string, count: number): string[] {
  validateCount(count);
  const input = response.trim();
  const fenced = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(input);
  let parsed: unknown;
  try { parsed = JSON.parse(fenced ? fenced[1] : input); }
  catch { throw Object.assign(new Error("Visual response was not valid JSON."), { code: "VISION_INVALID_JSON" }); }

  const incomplete = () => Object.assign(new Error("Visual response did not contain exactly the required nonempty observations."), { code: "VISION_INCOMPLETE" });
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "observations")) throw incomplete();
  const observations = (parsed as { observations: unknown }).observations;
  if (!Array.isArray(observations) || observations.length !== count || observations.some((item) => typeof item !== "string" || !item.trim())) throw incomplete();
  return observations.map((item: string) => item.trim());
}
