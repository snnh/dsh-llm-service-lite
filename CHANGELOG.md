# Changelog

All notable changes to `@snnh/dsh-llm-service-lite`. The package follows the
harness line it is built against: `peerDependencies` name that line, while this
package's own patch releases are independent.

## 0.2.1 — 2026-10-19

### Changed

- **Readable model catalog.** The 34-model editor is now a compact, filterable
  list with one expanded editor instead of one full card per model. Capacity
  and reasoning facts stay visible in the row; editing a row no longer pushes
  the page to six figures of vertical height.
- **Reasoning controls that match the model.** Effort levels and thinking
  modes are localized pill toggles. The editor shows the documented levels a
  family publishes and warns when a model declares none, so the chat model
  picker no longer silently loses its reasoning selector.
- **`Fill capabilities`.** The documented family defaults fill only fields a
  profile left open. A resolved schema may materialize an unset capability list
  as `[]`; those lists are now treated as unset both in the editor and in the
  request-path profile resolver, so composed profiles get their family's
  reasoning ladder instead of an empty selector.
- **Advanced request body.** `extraBody` is a collapsed disclosure, opens only
  when the profile actually carries fields, and explains that harness-owned
  request fields stay owned by the adapter.
- **Thinking-switch labels.** `thinking`, `fixed`, `enable_thinking`, and
  `effort_only` are described in operator language instead of internal wire
  spellings.
- **Models footer builder.** The section-level add form now forwards the
  credential and model-discovery operations, so its connection test and API-key
  save work exactly like the plugin page's builder.
- **Visual system.** Buttons, inputs, switches, chips, sections, and empty
  states share one scoped stylesheet with `--dsw-*` tokens and dark-mode-safe
  fallbacks; the layout collapses to one column in the narrow settings modal.

### Verified

- `pnpm run check` (typecheck + 476 tests) and `pnpm run build`.
- Live Web UI: Models → 配置服务商 → 补全能力 filled 27 models; `glm-5.3`
  then exposed `Default / Low / High / Max` in the chat reasoning picker.

## 0.2.0 — 2026-10-19

Verified against DeepSeek Harness `0.2.1-rc.2` (tests: 28 files / 473 cases).
This release puts provider configuration on the page operators already use:
the Models settings page.

### Fixed

- **Anthropic Messages overflow recovery.** Anthropic's canonical
  `400 prompt is too long: … tokens > … maximum`, its `request_too_large`
  wording, and the Bedrock spelling now classify as `CONTEXT_WINDOW_EXCEEDED`,
  so `dsh-compaction-basic` can compact and retry instead of the turn failing
  permanently; an exhausted credit balance classifies as `QUOTA`. A stream that
  stops with the documented `model_context_window_exceeded` reason now raises
  the same overflow error instead of completing a truncated turn as a normal
  stop.
- **Tool-result images on the chat-completions wire.** An image a tool returned
  (for example `read_image`) is carried as one synthetic user turn after the
  batch's tool messages, matching what the other two wires already did, instead
  of being silently dropped.
- **SSE framing.** A final event the connection closes without a trailing blank
  line (`[DONE]`, `message_stop`, `response.completed`) is dispatched instead of
  being lost and turning a complete turn into a retryable `TRANSPORT` failure.
  Buffered events are bounded at 8 MiB, empty `data:` keepalives are ignored
  without losing the idle pulse, and a connection cut off mid-frame is reported
  as retryable rather than malformed.
- **Anthropic Messages content-block start.** Initial `text`, `thinking`,
  `signature`, and whole `tool_use.input` stated on `content_block_start` are
  honoured; a tool call whose input never streamed is assembled with valid `{}`
  arguments rather than an empty string.
- **OpenAI Responses reasoning.** An encrypted reasoning payload that appears
  only in the terminal `response.completed` item is retained for replay;
  plain-text reasoning is replayed only for history this exact provider and
  model produced; assembled reasoning no longer ends with a stray blank line.
- **chat-completions terminal handling.** A clean stream with no content reports
  `EMPTY_RESPONSE`, and usage counters are validated as non-negative safe
  integers.
- **Route names shared with another mounted adapter.** On a stock upstream
  profile the shipped `llm-pi-ai` catalog already declares common names such as
  `deepseek` and `openai`; a profile claiming one is now reported and skipped
  (the rest of the mount serves), re-attempted when the name is released, and a
  write that newly claims such a name is refused where it is written. Previously
  one such name aborted the whole plugin mount.
- **Stream cleanup on timeout/abort.** The adapter no longer awaits the drain of
  an abandoned provider request, so an idle timeout or caller abort surfaces
  `TIMEOUT`/`ABORTED` instead of hanging the turn.
- **Request-image projection seam.** The adapter now overrides
  `imageRequestTarget` (harness `0.2.1-rc.2`), reporting the resized image
  actually sent to the endpoint, so coordinate consumers (for example CUA) no
  longer map against the source dimensions.
- **Profile edits.** Changing `maxConcurrent` re-tunes the route's existing
  admission queue instead of splitting it across two limiters; a profile can
  always be disabled even when it is already unserviceable; a converted official
  catalog is sanitized (capacities, headers, request defaults) and every dropped
  value is reported instead of failing later in the runtime.
- **Model discovery.** The listing is protocol-aware (Anthropic
  `/v1/models` with `x-api-key` and `anthropic-version`, OpenAI-compatible
  `/models` with bearer auth), honours the drafted endpoint over the stored one,
  merges the route's configured headers, validates a one-shot key, and bounds
  the reply at 4 MiB with explicit `DISCOVERY_FAILED`/`INVALID_REQUEST`/
  `INVALID_CONFIG` outcomes.

### Changed

- Development baseline moved to harness `0.2.1-rc.2` and cordis `4.0.5`, with
  the runtime `dsh-util-values` dependency on the same line. The
  `^0.2.1-alpha.2` peer ranges still admit the alpha line.
- The unused `@deepseek-ai/cosmokit` runtime dependency was dropped (it remains
  a development dependency because `preserveSymlinks` type resolution needs the
  root copy next to the peers).
- Both READMEs corrected: profiles are configured in the profile's
  `cordis.patch.yml` (the upstream Models page has no editor for this adapter
  family), same-id patch rows replace the earlier row and its whole config
  rather than mounting twice, the per-wire output-cap behavior is stated, route
  names must be unique across mounted adapters, and the full route/model field
  reference is documented.

### Added

- **Models page configuration seats and full add-provider builder.** Every
  `llm-service-lite` card on **Settings → Models** now gets the plugin's editor
  (protocol, endpoint, credential, request behavior, extra body, connection
  test, model catalog) and the section footer gets the same builder. The builder
  offers DeepSeek, OpenAI, Anthropic, DashScope, Qianfan, GLM, Kimi, Moonshot,
  OpenRouter, Ollama, Tencent Cloud, local vLLM/SGLang, and a custom route; it
  tests the drafted endpoint before writing and stores a typed key only after
  the profile write lands.
- **Archived capability editor.** Effort levels and thinking modes are edited
  as checkbox groups, the thinking switch uses labeled choices, and the model
  catalog keeps modalities, image output, tools, reasoning-content, and
  encrypted Responses replay declarations. The extra request body is a JSON
  editor that refuses harness-owned fields and blocks a save on malformed text.
- `pnpm run check` (source typecheck, test typecheck, full suite) and
  `pnpm run typecheck:tests`; CI now runs it on Node 22 and 24.
- Unit suites for SSE framing, model discovery, and the live-configuration
  lifecycle (volatile updates, withdrawal, write-time validation, credentials
  service, optional dsh-lite model-defaults seam).
- `imageRequestTarget` parity coverage and collision/mount-degradation coverage.
