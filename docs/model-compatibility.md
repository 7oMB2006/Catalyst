# Model Setup and Compatibility

Choose models by the inputs Catalyst needs to read and the output contract for
each task. See the capability tables in the [English README](../README.md#model-setup)
or [中文 README](../README.zh-CN.md#模型搭配).

## Configuration examples

Enable one block in your local `.env` using [the template](../.env.example).
Catalyst selects one provider per server process. Its text, image, video and
transcription routes cannot be assigned to different providers independently.
Local OCR is a separate choice where macOS Swift/Vision is available.

| Provider | Text, images and video | Audio transcription | Catalyst validation |
| --- | --- | --- | --- |
| Gemini | Set `GEMINI_VIDEO_MODEL` to a model your account can call for the required inputs. The template shows [`gemini-3.5-flash-lite`](https://aistudio.google.com/docs/models/gemini-3.5-flash-lite), whose API documents text, image, video and audio input and structured output. | Catalyst prompts the same model to transcribe extracted audio. | The Gemini adapter and native image-note request shape have SDK/mock coverage. The example model has no recorded live Catalyst check; verify the workflows you intend to use. |
| StepFun | `step-3.7-flash` through the Open Platform or Step Plan adapter. Use the base URL matching the key. | `stepaudio-2.5-asr` through the selected StepFun endpoint. | [Live video and ASR checks](./validation.md) are recorded. [Native image-note schema](#2026-11-07--image-note-native-structured-output) was tested on Step Plan with `step-3.7-flash`. |

`npm run doctor` checks local dependencies and credential presence. To verify
the configured model and endpoint, run a small real read for each capability
you plan to use. See [core reader acceptance](./core-reader-acceptance.md)
for bounded examples. Platform access can fail independently of model support.

## Runtime defaults

If `CODEX_VIDEO_PROVIDER` is unset, the runtime uses `stepfun`. When model
overrides are unset, StepFun uses `step-3.7-flash` for analysis and
`stepaudio-2.5-asr` for transcription. Gemini uses `gemini-2.5-flash` if
`GEMINI_VIDEO_MODEL` is unset. Set the Gemini model ID explicitly because
[Google has deprecated `gemini-2.5-flash`](https://aistudio.google.com/docs/deprecations#gemini-2.5-flash-models).

## Status vocabulary

- `default`: runtime value used when an override is omitted.
- `interface-compatible`: accepted the request shape used by this MCP.
- `vision-only`: visual input worked, but language or multimodal support was not
  established.
- `experimental`: tested for compatibility or behavior without broad evaluation.
- `pending`: not tested yet.

## Test records

### 2026-08-30 — GLM-5.3-Flash (Z.AI)

| Field | Result |
| --- | --- |
| Capability | Video-frame understanding |
| Result | `vision-only` / `experimental` |
| Evidence | The model identified video frames and visible text in the tested request path |
| Limitation | An isolated test with a valid audio track did not establish audio understanding |
| Position | Historical experiment; not a documented provider configuration |

This experiment does not establish `language` or full `multimodal` support for
the project.

### 2026-09-22 — StepFun `step-5-preview`

| Field | Result |
| --- | --- |
| Capability | Video understanding |
| Channel | Step Plan |
| Request path | Chat Completions with `video_url` |
| Result | `interface-compatible` |
| Evidence | A minimal video request returned HTTP 200 and the expected model response |
| Position | Optional compatibility test; not the default |

The current adapter can select this model through:

```env
STEPFUN_VIDEO_MODEL=step-5-preview
```

### 2026-09-22 — StepFun `stepaudio-3-asr-max`

| Field | Result |
| --- | --- |
| Capability | ASR |
| Channel | Official Open Platform API |
| Request path | `/audio/asr/sse` |
| Result | `interface-compatible`, transcription quality not benchmarked |
| Evidence | The model was accepted by the existing request shape and returned HTTP 200 |
| Position | Optional compatibility test; not the default |

This test uses a different channel from the Step Plan configuration:

```env
STEPFUN_BASE_URL=https://api.stepfun.com/v1
STEPFUN_ASR_MODEL=stepaudio-3-asr-max
```

Do not mix credentials or Base URLs between the two channels.

### 2026-11-07 — Image-note native structured output

| Field | Result |
| --- | --- |
| Capability | Default image-note `vision` / `combined` visual batches |
| Live channel / model | Step Plan / `step-3.7-flash` |
| Request path | Chat Completions with image inputs and strict `json_schema` |
| Result | `interface-compatible` on the tested channel |
| Probe | Without `response_format`, the model returned requested plain text; `json_object` returned HTTP 200 with a valid object; strict `json_schema` returned HTTP 200 with `{"observations":["visible"]}` despite a prompt requesting plain text |
| MCP check | Three reads of original page 24, plus one read of pages 24–28 in 4+1 batches; native output shape, original-page mapping and citation structure passed in all four calls |

These checks establish current interface compatibility for this configured
channel, not support across all StepFun models or channels, or observation
accuracy. Model defaults remain unchanged. Gemini has SDK and mock coverage for
the request fields below; its live endpoint has not been validated.

The default note visual stage passes `responseJsonSchema` to
`analyzeImagesWithProvider`. StepFun sends
`response_format: { type: "json_schema", json_schema: { name: "image_response", strict: true, schema: ... } }`;
Gemini sets `responseMimeType: "application/json"` and `responseJsonSchema`.
The internal response is exactly `{"observations":["..."]}`: one nonempty string
per supplied image, with the array length fixed to the batch size (1–4).
The application validates the whole batch, then assigns original source pages
by input position; model-generated page numbers are not part of this contract.

Invalid JSON or a schema mismatch rejects that visual batch without guessing
missing observations. Completed batches and OCR remain available. If an API
rejects these request fields, Catalyst does not strip the constraint and resend
that batch; later distinct batches may still run within the request budget.
Only an explicit `overrides.analyzeImages` integration retains compatibility
with the legacy `pages` response shape; the default provider path rejects it.

This adds no MCP tools or parameters. Text, video, ASR, OCR and ordinary image
provider calls do not request this schema by default.

## Pending candidates

| Candidate | Planned check |
| --- | --- |
| Xiaomi MiMo Pro 2.6 family | Verify the exact model ID, video/audio input format, endpoint, and whether it can cover the BVR language, vision, or multimodal paths |

For every future record, distinguish request compatibility from actual research
quality. A successful HTTP response alone is not a quality benchmark.
