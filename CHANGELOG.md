# Changelog

All notable changes to `@snnh/dsh-llm-service-lite`. The package follows the
harness line it is built against: `peerDependencies` name that line, while this
package's own patch releases are independent.

## Unreleased

Verified against DeepSeek Harness `0.2.1-rc.2` (tests: 19 files / 357 cases).
Not published yet; the published release remains `0.1.0`.

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
  `INVALID_CONFIG` outcomes. A caller cancellation that lands while the listing
  body is being read also reports `ABORTED`, not a discovery failure.
- **Robustness at protocol edges.** Streamed tool-argument fragments win over a
  whole `tool_use.input` that a block-start event also stated (instead of being
  dropped), and a terminal reasoning item never downgrades an encrypted payload
  an earlier copy carried. A schema-valid but unrepresentable `maxConcurrent`
  is refused by the schema instead of failing each request, and reordering
  profiles (or editing one that another adapter's name claim skips) no longer
  triggers an unnecessary route replacement.

### Changed

- Development baseline moved to harness `0.2.1-rc.2` and cordis `4.0.5`, with
  the runtime `dsh-util-values` dependency on the same line. The
  `^0.2.1-alpha.2` peer ranges still admit the alpha line.
- `@deepseek-ai/cosmokit` is pinned to the harness line (`1.8.6`) and remains a
  runtime dependency: the emitted declarations reference its `Dict` type through
  schemastery's `volatile()`, and `preserveSymlinks` type resolution also needs
  the root copy beside the peers.
- Both READMEs corrected: profiles are configured on the bundle's own Plugins
  page or in the profile's `cordis.patch.yml` (the upstream Models page has no
  editor for this adapter family), same-id patch rows replace the earlier row and
  its whole config rather than mounting twice, the per-wire output-cap behavior
  is stated, route names must be unique across mounted adapters, and the full
  route/model field reference is documented.

### Added

- **Browser half: a provider-configuration page in the Web UI.** The bundle now
  ships `./client` (`lib/client.js`), registering a page on the Plugins screen
  under its `llm-service-lite` row (`plugins.row.config`). It lists providers
  and adds, edits, renames, and removes them; edits protocol, endpoint,
  concurrency, stream timeout, inherited capacities, and the full model catalog
  (ids, capacities, modalities, effort levels, thinking modes and switch,
  reasoning/tool/image-output declarations); stores an API key through the
  harness credentials service while writing an `apiKeyEnv` reference; and asks
  the endpoint which models it serves through the Host's protocol-aware
  discovery. Saves are revision-fenced minimal path operations, so a profile
  declared in a `cordis.patch.yml` layer keeps inheriting untouched fields, and
  hand-written fields the page does not render (`headers`, `extraBody`,
  `imageTokens`, `imageBudgets`, `catalog`, `retryPolicy`, model `defaults`) are
  preserved.
- The browser artifact is built by `build/client-bundle.mjs` into the client
  module system's factory format (`window.__ModuleLoader__`), leaving React and
  the shared UI packages to the page's frozen module table; client-side
  development dependencies pin harness `0.2.1-rc.2`.
- Tests for the browser half: the draft model and validation, the staged
  controller and its minimal write operations, a rendered page smoke test, and
  manifest guards for the `dsh.client` declaration.
- `pnpm run check` (source typecheck, test typecheck, full suite) and
  `pnpm run typecheck:tests`; CI now runs it on Node 22 and 24.
- Unit suites for SSE framing, model discovery, and the live-configuration
  lifecycle (volatile updates, withdrawal, write-time validation, credentials
  service, optional dsh-lite model-defaults seam).
- `imageRequestTarget` parity coverage and collision/mount-degradation coverage.
