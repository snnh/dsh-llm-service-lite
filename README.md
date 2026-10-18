# @snnh/dsh-llm-service-lite

English | [中文](README.zh.md)

> **Community plugin.** Maintained by [snnh](https://github.com/snnh). It is not
> an official DeepSeek package: DeepSeek neither publishes nor supports it, and
> issues belong in this repository.

## Install

A harness loads plugins from a profile's own installation, so this package is
installed into a profile rather than into the harness itself:

```sh
# From the published package:
dsh plugin --profile web add @snnh/dsh-llm-service-lite

# Or straight from this repository. pnpm builds the checkout while installing,
# which the profile must allow first: run the command, add the exact key pnpm
# printed under `allowBuilds` in <profile>/pnpm-workspace.yaml, and re-run it.
dsh plugin --profile web add github:snnh/dsh-llm-service-lite
```

### Mount

The package declares itself a bundle (`dsh.bundle.patch`), so the install above
also mounts its `llm-service-lite` row: one command installs and mounts, and no
hand-written entry is needed. The mount is dormant — no route exists until a
profile declares one.

Two surfaces edit the same document. In the web UI, open **Plugins**, select
this bundle, open its `llm-service-lite` row, and choose **Configure**: the
page lists every provider, adds and removes profiles, edits the endpoint,
protocol, capabilities and model catalog, stores an API key through the
harness credential service, and asks an endpoint which models it serves. The
same document can be edited by hand in the profile's own `cordis.patch.yml`
(`$DSH_HOME/profiles/<profile>/cordis.patch.yml`; **Settings → Open
configuration file** in the web UI opens it). Add the `providers` dictionary
described under [Configure provider profiles](#configure-provider-profiles) to
the `llm-service-lite` row's `config`. The profile patch is applied after every
bundle layer, so that entry's `config` replaces the row's empty default; the
same entry also mounts the plugin in a composition that declares no bundle
layer, because it names the module to load:

```yaml
- id: llm-service-lite
  name: '@snnh/dsh-llm-service-lite'
  config:
    providers:
      # ... provider profiles, one per endpoint
```

After the install, refresh the Web page once: the browser half is served by
the client module system, so the new page appears on the **Plugins** screen the
next time the shell boots. It lives on the bundle's page and on its
`llm-service-lite` row, where that row's **Configure** control opens it.

The upstream **Models** page does not edit these profiles in harness
0.2.1-rc.2: that page only lays out the adapter families it ships
(`llm-deepseek`, `llm-pi-ai`), so an `llm-service-lite` row opens a read-only
card pointing at the patch file. The plugin's own page on the **Plugins** screen
is the in-page surface instead — it edits the row's own `config`, so a save is
the same document the Host already loads. The page covers the fields a profile
needs day to day; hand-written fields it does not render (`headers`,
`extraBody`, `imageTokens`, `imagePixelBudget`, `imageMaxBytes`, `catalog`,
`retryPolicy`, and the per-model `defaults`) are preserved by every save and
remain editable in the patch.

Credentials are named, not inlined, in a managed profile: set `apiKeyEnv` to the
reference (`DEEPSEEK_API_KEY`, say) and store the secret through the harness
credential service, export it in the launching environment, or keep it in the
harness home's `.env`. The reference is resolved on every request, and a named
reference that resolves to nothing fails the request with `MISSING_CREDENTIAL`
instead of sending it unauthenticated. A profile imported verbatim from OWCode
may keep its inline `apiKey`.

Mount it exactly once. When a composition already carries an `llm-service-lite`
row (the archived [dsh-lite](https://github.com/snnh/dsh-lite) fork's `dsh-base`
bundle shipped one), that row already reaches this package: install without
activating it as a bundle — `dsh plugin --profile web add -D
@snnh/dsh-llm-service-lite` — and configure the existing row. Keep exactly one
layer for the row: a later layer's same-id insert replaces the earlier row and
its **whole `config`** — patch layers never deep-merge — so a second row
silently discards what the first configured; it does not mount a second
instance.

### Route names

Route names must be unique across the adapters mounted in one composition. On
stock upstream profiles the shipped `llm-pi-ai` catalog already declares common
provider names (`deepseek`, `openai`, `anthropic`, and similar), so prefer a
distinct route id that names the endpoint itself — `deepseek-direct`,
`company-gateway` — rather than a name an installed catalog may own. A profile
whose route name another adapter already owns is skipped with one warning naming
the owner instead of failing the mount, the rest of the profiles register, and a
newly written profile that claims such a name is refused where it is written;
renaming its route is the repair. The plugin also refuses, by name, the routes
the first-party DeepSeek channel owns; see [Use this package](#use-this-package).

### Compatibility

This package drives the public seam of `@deepseek-ai/dsh-llm` and the
`@deepseek-ai/cordis` service layer, so it runs against a published harness
rather than a checkout: its peers are the harness packages, and the profile
that loads it already owns the copies the runtime uses. The development
baseline is harness `0.2.1-rc.2` — `devDependencies` pin those packages and the
test suite runs against them — while the `^0.2.1-alpha.2` peer ranges also admit
the `0.2.1` alpha line, so an older `0.2.1` harness loads the same package.

Two declarations of the archived [dsh-lite](https://github.com/snnh/dsh-lite)
fork are used when the running harness carries them and skipped when it does
not: the model-defaults registration seam a configuration surface asks for
declared model ids, and the `outputModalities` field on a model's info. Upstream
`0.2.1-rc.2` carries neither, so both are inert there: the adapter keeps its
family defaults on the request path, where they still fill the fields a profile
left open, and the extra field is simply ignored by the runtime.

## Summary

`@snnh/dsh-llm-service-lite` adapts third-party model endpoints: one route per configured provider profile, all answered over its transports — the OpenAI-compatible chat-completions wire, the Anthropic Messages protocol, and the OpenAI Responses API — so no provider SDK and no installed catalog sits in the request path. A profile is self-contained — wire protocol, endpoint, credential reference, request-body extras, concurrency, image input, and the models served — so a gateway, a national API, and a corporate proxy reach one code path. The shape ports OpenWebCode's model-provider layer onto the harness seam: one document describes every provider, and the route set follows it live.

## Table of Contents

- [Install](#install)
- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a deployment wants to describe its model providers itself instead of naming providers an installed catalog already knows. The `providers` dictionary is the whole configuration surface: each key is the provider route a request selects with `GenerateOptions.provider`, and the value is everything that endpoint needs.

### When to choose it

This plugin adapts third-party endpoints and nothing else: every route it registers comes from a profile a deployment wrote, and the first-party DeepSeek channel keeps its own adapter. DeepSeek is that channel by default, so the route names it owns — `deepseek-official` and `deepseek-account`, registered by `@deepseek-ai/dsh-llm-deepseek-api-key` and `@deepseek-ai/dsh-llm-deepseek-account` — are refused here by name, with the owner in the diagnostic, rather than claimed and left to fail plugin loading. DeepSeek itself keeps those modules — this adapter is not a substitute for that channel. Any other route name is free: a deployment that reaches a DeepSeek-compatible endpoint through this adapter names its own route and declares that endpoint's own capabilities. Choose this adapter when the same composition serves several endpoints — a national model API, a self-hosted vLLM or SGLang gateway, and a proxy on the corporate network — and each must be described completely rather than derived from a catalog. Choose `dsh-llm-pi-ai` when a pi-ai catalog entry already supplies the protocols and model capabilities. Both adapters can be mounted together: a profile whose route name another adapter already owns is reported and skipped at mount, and a write that claims such a name is refused where it is written (see [Route names](#route-names)).

### Configure provider profiles

```yaml
- id: llm-service-lite
  name: '@snnh/dsh-llm-service-lite'
  config:
    providers:
      # A provider reached at its published API, with the key from the seam.
      # (`deepseek-direct`, not `deepseek`: the stock llm-pi-ai catalog already
      # declares the plain vendor names — see Route names above.)
      deepseek-direct:
        displayName: DeepSeek
        interfaceType: openai-chat-completions
        baseURL: https://api.deepseek.com/v1
        apiKeyEnv: DEEPSEEK_API_KEY
        includeUsage: true
        models:
          - id: deepseek-chat
            contextWindow: 131072
            maxTokens: 8192
          - id: deepseek-reasoner
            contextWindow: 131072
            maxTokens: 65536
            capabilities:
              effort: [low, medium, high]
              thinking: [enabled, disabled]
              reasoningContent: true
      # A self-hosted gateway: body fields only this server understands.
      vllm:
        interfaceType: openai-chat-completions
        baseURL: http://127.0.0.1:8000/v1
        extraBody:
          top_k: 40
        maxConcurrent: 1
        models:
          - id: Qwen3-32B
            contextWindow: 32768
            maxTokens: 8192
            capabilities:
              effort: [low, high]
              thinkingStyle: enable_thinking
      # An endpoint reached over the Responses API, with encrypted reasoning
      # replay declared.
      openai-direct:
        interfaceType: openai-responses
        baseURL: https://api.openai.com/v1
        apiKeyEnv: OPENAI_API_KEY
        models:
          - id: gpt-5
            contextWindow: 400000
            maxTokens: 128000
            capabilities:
              effort: [minimal, low, medium, high]
              thinking: [disabled]
              responsesEncryptedReplay: true
      # An endpoint reached over the Anthropic Messages protocol, with prompt
      # caching and its thinking modes declared.
      claude:
        interfaceType: anthropic-messages
        baseURL: https://api.anthropic.com/v1
        apiKeyEnv: ANTHROPIC_API_KEY
        promptCaching: true
        models:
          - id: claude-sonnet-4-5-20250929
            contextWindow: 200000
            maxTokens: 64000
            capabilities:
              thinking: [enabled, disabled]
              # This endpoint reads a later system message as the effective
              # prompt and activates tools inside the conversation.
              systemPromptUpdate: in-history
              toolUpdate: in-history
      # A gateway that routes by header and needs no credential of its own.
      proxy:
        interfaceType: openai-chat-completions
        baseURL: https://proxy.example.com/v1
        headers:
          x-tenant: acme
        streamIdleTimeoutMs: 60000
```

| Field | Default | Meaning |
|---|---|---|
| `displayName` | the route key | Label shown by selection surfaces; the `providers` key stays the route a request selects |
| `enabled` | `true` | Whether the route registers at all |
| `interfaceType` | required | `openai-chat-completions`, `anthropic-messages`, or `openai-responses`; each selects its own transport |
| `baseURL` | protocol default | Endpoint of every model on the route; the protocol's usual host and version segment apply when omitted |
| `catalog` | none | Official-format model configuration this route starts from: the path of a provider file, or its parsed content |
| `apiKeyEnv` | absent | Credential reference resolved per request through the credential seam |
| `apiKey` | absent | Inline credential, for a profile imported from another tool |
| `headers` | none | Static request headers; a named credential still wins over `authorization` |
| `promptCaching` | `false` | Whether the route may mark cache breakpoints (anthropic-messages only) |
| `includeUsage` | `false` | Whether the request asks for a streamed usage report (chat-completions only) |
| `extraBody` | none | Extra top-level request-body fields the endpoint understands |
| `maxConcurrent` | `3` | Concurrent requests before further calls queue |
| `streamIdleTimeoutMs` | `300000` | Maximum idle interval between two stream events |
| `retryPolicy` | normal, 5 retries | Provider-owned policy executed by `dsh-llm-retry` |
| `models` | `[]` | The models this route advertises, with their capacities and capabilities |
| `defaultContextWindow` | `256000` | Context capacity for a model that declares none |
| `defaultMaxTokens` | `65536` | Output capability for a model that declares none |
| `imageRequestMaxBytes` | `20971520` | Accumulated base64 image payload one request carries |
| `imageRequestMaxImages` | `600` | Image occurrences one request carries |
| `imageOffloadByteQuantum` | `10485760` | Payload removed as one deterministic offload step |
| `imageOffloadCountQuantum` | `20` | Occurrences removed as one deterministic offload step |

Each entry of `models` describes one model the route serves:

| Field | Default | Meaning |
|---|---|---|
| `id` | required | Exact model id sent on the wire and named by `GenerateOptions.model` |
| `name` | the id | Display name shown by selection surfaces |
| `contextWindow` | route `defaultContextWindow` | Context capacity in tokens |
| `maxTokens` | route `defaultMaxTokens` | Output capability the model declares; the Responses wire also uses it as the request cap |
| `capabilities` | none | Endpoint capabilities declared under [Declare what a model can do](#declare-what-a-model-can-do) |
| `imagePixelBudget` | source dimensions | Pixel budget (`width × height`) each request image is projected into, or `low` for the published low-detail grid |
| `imageMaxBytes` | adapter default (2 MiB) | Encoded-byte target for one request image; the encoder keeps the smallest ladder step when no step fits |
| `imageTokens` | none | Visual-token accounting used to price image-bearing contexts |
| `defaults` | none | Request parameters (`temperature`, `topP`, `topK`, `maxTokens`) the endpoint wants when the caller states none |

### Start from an official configuration file

An official deployment publishes one provider file per provider — an API-keyed map of `chat:` entries. `catalog` converts such a file into this adapter's own vocabulary: the API becomes the route's `interfaceType` (`openai-completions` to `openai-chat-completions`, `openai-responses`, `anthropic-messages`), `baseUrl` becomes `baseURL`, a header set every model shares becomes the route's headers, and each chat entry becomes a model with its id, name, `contextWindow`, `maxTokens`, input modalities, and thinking levels. A model's `samplingParams` become its `defaults`, so an endpoint's own sampling settings arrive as configuration rather than as a caller concern. Fields this adapter has no counterpart for — `cost`, `compat` flags it does not model, `inputLimits`, and model types it does not serve — are reported one line each instead of guessed, and the route still serves. A header set every entry shares becomes the route's `headers`; only header sets that disagree, which one route cannot carry, are reported. The profile's own fields win over the conversion; an absent or empty `models` list keeps the catalog's models; and a file that mixes protocols or endpoints, names no chat model, or cannot be read leaves the route with a diagnostic rather than a half-converted one.

```yaml
providers:
  kimi-coding:
    catalog: /etc/dsh/official/kimi-coding.json
    apiKeyEnv: KIMI_CODING_API_KEY
```

### Declare what a model can do

A model entry's `capabilities` are declarations about the endpoint, never guesses: a capability left out is one this adapter does not claim, and one it declares is honoured or refused by name — never accepted with nothing behind it. `effort` lists the selectable reasoning levels and its values are the wire spellings, so a gateway with its own vocabulary declares that vocabulary. `thinking` lists the accepted thinking modes (`enabled`, `disabled`, `adaptive`). `thinkingStyle` says how the endpoint spells the switch: `thinking: { type: … }`, a top-level `enable_thinking` boolean, `fixed` for a model that always thinks, or `effort_only` — the explicit spelling of an endpoint that takes an effort level and has no switch, which is the same request an omitted style sends. `reasoningContent` declares that the endpoint returns reasoning in `reasoning_content`, which is what lets a later request replay prior thinking. `replayReasoning` decides whether that prior thinking actually travels back: absent defers to the model's family (see below), `true` sends it, and a family whose follow-up turns are rejected without it refuses to be turned off. `tools` declares whether tool declarations may be sent at all: a model that turns them off receives none rather than a list its endpoint would reject. `modalities` names what the endpoint accepts — `text`, `image`, `video`. `image` is carried: a retained occurrence is read from the attachment provider at the model's pixel budget (or its source dimensions), re-encoded to the model's byte target, and sent as an inline base64 `image_url` part, while an occurrence the session already offloaded contributes its placeholder text instead. A route's accumulated request is bounded by `imageRequestMaxBytes`, `imageRequestMaxImages`, `imageOffloadByteQuantum`, and `imageOffloadCountQuantum`; a request over budget fails with `IMAGE_OFFLOAD_REQUIRED` naming how many oldest occurrences to offload rather than dropping an image silently. `imageOutput` declares that the model answers with images of its own: the inline picture the endpoint returns is stored through the attachment provider and republished as a durable image block, an image from a model that never declared it fails by name, and the declaration is refused on `anthropic-messages`, whose assistant turn has no image part. `video` is accepted and carried as a file: a video occurrence reaches the model as the same handle text every file contributes, and a native part waits for the harness's own video content block. `responsesEncryptedReplay` is honoured by the Responses transport: the request asks for `reasoning.encrypted_content` and hands each reasoning item back verbatim on the next turn. `systemPromptUpdate` and `toolUpdate` declare the two mid-conversation reads a Messages endpoint can be asked for: the latest system message as the complete effective prompt, and a tool change as an activation or deactivation of a tool the declaration list already names. Declaring either is what makes the harness hand this route `tool-addition` and `tool-removal` blocks instead of restating the prompt and the tool list on every turn, and the declarations of the tools it defers then carry `defer_loading`. Both are refused on the two OpenAI wires, which have no mid-history part to read. `imageTokens` declares the endpoint's own visual-token accounting — `{ kind: area, per: 750 }` for a flat pixel grid, or `{ kind: tiles, tile: 512, base: 85, perTile: 170 }` for a base price plus a price per square tile — which is what the token meter reads to price an image-bearing context; a route that declares none keeps the meter's own structural heuristic rather than a number this adapter guessed.

**Family defaults.** A hand-written profile states what its author knows and leaves the rest to the model's family: `src/model-defaults.ts` is a reviewed table of what the mainstream families document — the image input a vision model takes, the effort ladder and the level its own platform applies by default, the switch spelling, and whether prior reasoning must travel back. The table only fills what the profile left open, so a profile field always wins; a family that shows no entry for a model leaves the adapter's own conservative answer in place; and nothing in it defaults a sampling parameter, because vendors disagree about the reachable ranges and the endpoint's own default beats an invented one. Each entry records the vendor documentation it came from, and only the model owner's own platform is ever a source: what a reseller or gateway requires of the same model id is not.

A model entry's `defaults` state the request parameters its endpoint wants when the caller states none: `temperature`, `topP`, `topK`, and `maxTokens`. Each is written only where the caller's own request left it unstated, so a default can never override an explicit choice; `topK` is refused on `openai-responses`, which has no top-k field; and `defaults.maxTokens` is what a caller that stated no cap receives. A model's own `maxTokens` is a capacity rather than a request default, and the three transports treat the output cap differently: `chat-completions` sends `max_tokens` only when the caller, or a declared `defaults.maxTokens`, supplied one, so an endpoint that defaults its own ceiling keeps it; `anthropic-messages` requires the field on every request and takes the caller's value, then the profile's `extraBody.max_tokens`, then `defaults.maxTokens`, then the model's family cap, then 64K for a model no family speaks for; `openai-responses` also always sends `max_output_tokens`, from the caller's value, then `defaults.maxTokens`, then the model's `maxTokens` (the route's `defaultMaxTokens` when the model declares none), raised to the API's 16-token floor.

An image request needs the attachment provider mounted (`attachments`); a deployment serving text-only routes never mounts one, and a route that declares `image` without it fails the request before the endpoint sees a partial call.

### Change configuration at runtime

Each operation captures the current provider set. A changed route set — or a route's display name or retry policy, which the registry captures at registration — re-registers the same adapter instance in place, so an in-flight request keeps the endpoint it started with and the next request sees the new one. Concurrency is admission-level rather than registration-level: changing `maxConcurrent` updates the route's existing queue on the next request instead of re-registering it, and requests already queued keep their place. A profile that cannot be served is refused where it is written and, when already stored, kept addressable with its diagnostic instead of taking the other routes down with it; a profile whose route name another adapter owns is reported and skipped at mount (see [Route names](#route-names)) instead of aborting the composition.

### Discover models from endpoints

The plugin answers "which models can this endpoint serve?" for a route a configuration surface is editing or drafting. A configured route supplies its stored endpoint, protocol, headers, and credential inside the Host; a draft supplies its own endpoint and protocol, and a one-shot key wins over the stored credential for that query. The listing is protocol-aware: the two OpenAI-compatible wires query `GET {baseURL}/models` with bearer auth, an Anthropic Messages route queries that protocol's own `/v1/models` listing with `x-api-key` and `anthropic-version`, and both published OpenAI-compatible shapes are accepted — the standard `data` array and the enriched `models` map. The reply is candidate metadata a surface may offer for adoption: nothing is stored, and the profile a user saves decides what a route serves. An endpoint that cannot be reached, answers without JSON, or sends more than 4 MiB fails the query with `DISCOVERY_FAILED`; an endpoint error status is reported as `INVALID_REQUEST`, and a protocol with no readable listing is refused as `INVALID_CONFIG`.

### Failures and recovery

Failures carry stable codes: a named credential that resolves to nothing fails with `MISSING_CREDENTIAL`, a rejected request with `INVALID_REQUEST`, an exhausted quota with `QUOTA` rather than a rate limit, and a request that exceeds the model context with `CONTEXT_WINDOW_EXCEEDED`, which is what lets the agent compact instead of retrying. A stream that ends without a terminal event fails with `TRANSPORT` rather than looking like a finished turn, and a completion that carries no content fails with `EMPTY_RESPONSE`. A provider-requested delay is read from `Retry-After` and handed to the retry layer.

<a id="understand-the-implementation"></a>
## Understand the implementation

### Design philosophy

Three rules shape the package. A profile is the whole truth: nothing is inferred from an installed catalog, so an endpoint that is not OpenAI, Anthropic, or DeepSeek is configured, not special-cased. A declared capability is a promise: the request path sends only what the profile declares and never invents a knob. And a failure is classified where it happens: the transport turns each HTTP status and error body into one stable code, because that is the only point that sees the whole provider answer.

### Source map

| File | Role |
|---|---|
| `src/index.ts` | Plugin: profile resolution, route registration, directory, discovery |
| `src/client/*` | Browser half: the provider-configuration page on the Plugins screen (`plugins.row.config`), its draft controller, validation, and the client bundle entry |
| `src/config.ts` | Configuration schema and the profile vocabulary |
| `src/profiles.ts` | Validation and materialization of profiles into route facts |
| `src/models.ts` | Projection of model facts onto the seam's model vocabulary |
| `src/adapter.ts` | The adapter: per-route snapshot, admission, idle watchdog, dispatch |
| `src/chat-completions.ts` | Request assembly and stream translation for the chat-completions wire |
| `src/anthropic-messages.ts` | Request assembly, pairing repair, and thinking-signature replay for the Messages wire |
| `src/anthropic-stream.ts` | Messages event-stream translation into the harness chunk vocabulary |
| `src/openai-responses.ts` | Request assembly, input mapping, and reasoning replay for the Responses wire |
| `src/responses-stream.ts` | Responses event-stream translation into the harness chunk vocabulary |
| `src/sse.ts` | Server-sent-event framing with a data-only idle pulse |
| `src/errors.ts` | Provider-failure classification |
| `src/limiter.ts` | Per-route FIFO admission control |
| `src/discovery.ts` | Endpoint interrogation for configuration surfaces |

### Registration and directory

A mount with no profiles registers nothing: the plugin holds no route until its settings section supplies one, which is why the base bundle can mount it dormant. Every route this instance mounts appears in the configurable-provider directory, including one that is disabled or currently unserviceable, so a settings surface can address and repair it by name. A profile skipped because another mounted adapter already owns its route name stays out of the directory — that name belongs to the other family, and renaming the profile's route is the repair (see [Route names](#route-names)).

### Wire translation

Three transports answer one seam. `openai-chat-completions` speaks the OpenAI-compatible wire and `anthropic-messages` the Messages protocol, and both own the three things a provider stream does not: block identity and ordering, tool-call assembly across streamed fragments, and the difference between a stream that ended and one that was cut off.

Both also repair their protocol's pairing rules on the way out, because a durable history can hold shapes no endpoint accepts. A result whose call is gone is dropped; a call id one assistant turn declares twice, or that a later turn declares again, collapses to its first occurrence; a repeat result for one call is dropped and its first occurrence kept; a call nothing ever answered is answered with a placeholder rather than left to a 400; and the results of one parallel batch merge into the single user turn both protocols require. The repair happens in the wire projection, so the durable log is never rewritten to make a request acceptable.

Reasoning is replayed only for a route whose target model declares it, and only for history the same provider produced. `openai-chat-completions` replays it through `reasoning_content` and matches the history on the provider alone; `anthropic-messages` and `openai-responses` additionally require the source model to match, and replay signed/redacted thinking blocks or the provider's own reasoning items through adapter-private replay metadata on the assistant message. The Messages protocol rejects a thinking block returned without its signature, and metadata another provider, another model, or another adapter wrote degrades that one turn to plain text instead of failing the request.

The Responses transport maps the conversation onto the API's flat item list — an assistant `message`, a `function_call` per call, and a `function_call_output` carrying the same id — and repairs that list the same way, with one difference the protocol forces: a call nothing answered is dropped rather than answered with a placeholder, because strict gateways reject a fabricated output, and a turn's parallel calls are grouped so the API folds them into one assistant turn. Its reasoning follows the model's declaration: `reasoningContent` replays the thinking text as `reasoning_text`, and `responsesEncryptedReplay` hands the provider's own item back verbatim. The protocol carries no stop sequences, so a caller's `stop` is omitted rather than approximated.

The Messages transport reads its prompt from `system`, else from a leading system message. A later system or developer message folds into a user turn where it stands and a mid-conversation instruction keeps its position — unless the model declared `systemPromptUpdate` or `toolUpdate`, in which case that message travels as the `system`-role history message this protocol reserves for mid-history changes, with tool additions and removals spelled as references to the declared tools. Such a message is held back until the turn it follows is a user turn, because the protocol reads it as an instruction between turns, and a change that would land earlier is refused by name rather than moved. Tool results carry their media inline as image blocks beside their text, `max_tokens` is always sent because the protocol requires the cap, and `promptCaching` marks this protocol's own breakpoints: the system prompt and the last tool declaration.

<a id="further-exploration"></a>
## Further Exploration

- [LLM streaming subsystem](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/llm-streaming.md) — the message and block types, the assembled request, and the adapter contract this package implements.
- [Providers guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md) — how a deployment configures providers on the shipped profiles.
- [OpenWebCode](https://github.com/snnh/openwebcode) — the provider-profile model this adapter follows.

<a id="model-experience"></a>
## Model Experience

The provider-configuration page under **Plugins** is operator-only: it edits Host configuration and contributes no model-visible prompt, tool, or context surface. The model experience described below is unchanged by the page.

### Provider request through the adapter

#### What the model sees

The conversation exactly as the harness assembled it: the system prompt as a leading system message, user and assistant turns in order, tool declarations as function schemas, and each tool result attached to the call it answers. A request adds the endpoint's own `extraBody` fields and, when the model declares how it spells them, the effort level and thinking switch the caller selected.

#### Token effect

The request carries no adapter-authored system-prompt text; the only text this adapter itself contributes is deterministic framing — the `Attached media from tool result:` note the two OpenAI wires lead a tool-result media follow-up with, a placeholder for a tool result that never landed, and the `[context trimmed]` marker for a Messages assistant turn that cannot otherwise be carried. `max_tokens` is present on a chat-completions request only when the caller configured one, so an endpoint that defaults its own ceiling keeps it; the Messages and Responses protocols require an output cap, so both always send one — from the request, the profile's `defaults`, or the model's declared cap (Responses raises a value below the API's 16-token floor).

#### KV Cache effect

Nothing in the translation is per-request random: the same history produces the same request bytes, so provider-side prefix caching keeps working across turns. A route marked `promptCaching` uses the protocol's own cache marking — the Messages transport marks the system prompt and the last tool declaration — and otherwise the adapter adds no cache breakpoints of its own.

### Provider response

#### What the model sees

Content deltas become text blocks, `reasoning_content` becomes reasoning blocks, signed thinking becomes a reasoning block whose signature is kept as replay metadata, and streamed tool-call fragments become one call each. The model's own stop reason is mapped onto the harness vocabulary, and a stream that ends without one is a transport failure rather than a completed turn.

#### Token effect

Usage is reported when the endpoint sends it, with cached prompt tokens separated out of the input count exactly as the harness contracts: `inputTokens` excludes what the provider served from cache, which is reported as `cacheReadTokens`.

#### KV Cache effect

Replayed reasoning is byte-identical to what the provider returned, so a route that echoes reasoning back keeps its cache prefix stable; a route that does not declare `reasoningContent` sends no reasoning at all rather than a paraphrase.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Three protocols, three shapes.** Every declared protocol has a transport, and each carries that protocol's own features: the Responses API's server-side tools (`web_search_call` items) are not carried, and no `store` field is sent, so a deployment keeps provider-side state out of the request path.
- **Configuration lives on the plugin page or in the patch, not the Models page.** The upstream Models page does not lay out this adapter's namespace; providers are edited on this bundle's page under **Plugins** (or in the profile's `cordis.patch.yml`, see [Mount](#mount)). The plugin page does not render every hand-written field, and it does not show a Model-defaults editor; those stay in the patch.
- **Video input arrives as a file, not as moving pictures.** A declared `video` input is carried as the file handle every attachment contributes, because no wire here has a video part and the harness has no video content block yet. `image` input is carried, and so is the token accounting a profile declares through `imageTokens`; a route that declares none keeps the meter's structural heuristic, and no adapter-authored handle text travels beside the bytes, so a priced occurrence counts the visual tokens the endpoint charges and nothing this adapter invented.
- **No adapter-side retries.** One call is one provider attempt, so the provider's retry policy is executed by `dsh-llm-retry` at the durable step boundary, and a retry re-derives the whole request.
- **Replay metadata is protocol-specific.** The Messages transport writes and reads its own envelope for thinking signatures, and the Responses transport keeps each reasoning item (id and encrypted payload) for the model that asked for encrypted replay; neither envelope is portable across providers.
- **Mid-history changes are the endpoint's own contract.** A route that declared `systemPromptUpdate` or `toolUpdate` receives them as `system`-role history messages, so an endpoint that gates that part behind a beta header is configured with that header in `headers`: nothing is injected on the endpoint's behalf, and a change that arrives with no user turn to follow fails the request with `UNSUPPORTED_CONTENT` instead of being silently moved or dropped.
- **No streaming usage in the absence of a report.** An endpoint that never sends a usage chunk leaves token accounting to the harness's estimator.

<a id="dev-note"></a>
### Dev Note

The two coexist deliberately: the catalog route is the shortest path to a known provider, this one the honest path to any endpoint that is not.

<a id="development"></a>
## Development

```sh
pnpm install              # installs the published harness peers
pnpm run typecheck        # tsc -b: src -> lib/types
pnpm run typecheck:tests  # tsconfig.test.json: src + tests, no emit
pnpm run check            # typecheck, typecheck:tests, and the test suite
pnpm test                 # vitest, tests/**/*.spec.ts
pnpm run build            # typecheck, host bundle, then the browser bundle
```

`tsconfig.test.json` typechecks the specs, which the shipping `tsconfig.json`
does not include; CI runs `pnpm run check` on Node 22 and 24. The package is
plain ESM and bundles only its own code: every harness package stays external,
because the profile that loads the plugin owns the single runtime copy of them.
`build/client-bundle.mjs` wraps the emitted browser half into the client module
system's factory format (`lib/client.js`, the target of the `./client` export),
leaving React and the shared UI packages to the page's frozen module table.

Beyond the runtime entry, the package carries its own declarations:
`cordis.patch.yml` is the bundle layer that mounts the plugin row,
`package.json`'s `dsh.bundle.patch` points at it, and `locale/*.json` plus
`icon.svg` are the display resources a plugin inventory reads without loading
the plugin. `tests/declaration.spec.ts` holds the three together, so keep
`exports` and `files` covering every added asset.

## License

MIT. The harness interfaces this plugin implements are
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (also MIT);
the plugin itself is community code maintained by
[snnh](https://github.com/snnh).
