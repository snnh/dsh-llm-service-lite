# @snnh/dsh-llm-service-lite

[English](README.md) | 中文

> **社区插件。** 由 [snnh](https://github.com/snnh) 维护。它不是 DeepSeek 官方包：
> DeepSeek 既不发布也不支持它，问题请提到本仓库。

## 安装

harness 从每个 profile 自己的安装目录加载插件，所以本包装进 profile，而不是装进 harness 本体：

```sh
# 从已发布的包安装：
dsh plugin --profile web add @snnh/dsh-llm-service-lite

# 或直接从本仓库安装。pnpm 会在安装时构建这份检出，因此 profile 要先放行构建：
# 先跑一次命令，把 pnpm 打印出的那个键加进 <profile>/pnpm-workspace.yaml 的
# `allowBuilds`，再跑一次。
dsh plugin --profile web add github:snnh/dsh-llm-service-lite
```

### 挂载

<a id="mount"></a>

本包同时把自己声明成一个 bundle（`dsh.bundle.patch`）：上面那条安装命令会连同挂载一起完成，
自动插入 `llm-service-lite` 行，不必再手写条目。这样挂载是休眠的——profile 声明第一条档案之前，
本插件不注册任何路由。

同一份文档有两个编辑面。在 Web UI 里打开 **Plugins**，选中本包，进入它的
`llm-service-lite` 行，选 **Configure**：页面会列出所有服务商，可新增/删除档案、编辑端点、
协议、能力与模型目录、通过 harness 凭据服务保存 API 密钥，还能向端点询问它提供哪些模型。
同一份文档也可以手写在该 profile 自己的 `cordis.patch.yml` 里
（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`；Web UI 的 **Settings → Open
configuration file** 会打开它）：把[配置服务商档案](#configure-provider-profiles)
里说的 `providers` 字典写进 `llm-service-lite` 行的 `config`。profile 自身的 patch 在所有
bundle 层之后应用，因此该条目的 `config` 会整体替换那一行的空默认值；同一条目也适用于自己
声明行、不加 bundle 层的 composition，因为它写明了要加载哪个模块：

```yaml
- id: llm-service-lite
  name: '@snnh/dsh-llm-service-lite'
  config:
    providers:
      # ... 每个端点一条服务商档案
```

安装后请刷新一次 Web 页面：浏览器半区由客户端模块系统提供，新页面在 shell 下次启动时出现，
位于本 bundle 的页面与其 `llm-service-lite` 行上——该行的 **Configure** 控件打开它。

本包在 Host 提供自己的设置命名空间期间，填充 **Models** 页的适配器家族扩展席位：每张
`llm-service-lite` 服务商卡片都使用本插件自己的编辑器，页面底部则提供同一套添加服务商构建器。
构建器要求选择预设、路由、协议、端点与可选密钥，并在写入前运行连接测试；编辑器覆盖协议、端点、
凭据、请求行为、连接测试与模型目录。模型目录是可筛选的紧凑列表，只展开一个模型编辑器；推理档位与
思考模式是本地化的胶囊开关，**补全能力**会把已核对的家族默认值填进模型留空的字段。`extraBody`
收在高级折叠区里，JSON 非法时阻止保存。**Plugins** 页里本 bundle 的配置页编辑同一行 `config`。
它不渲染的手写字段（`headers`、`imageTokens`、`imagePixelBudget`、`imageMaxBytes`、`catalog`、
`retryPolicy`，以及逐模型的 `defaults`）每次保存都会原样保留，仍可在 patch 里编辑。

托管 profile 里的凭据是引用而不是内联值：把 `apiKeyEnv` 设为引用名（例如
`DEEPSEEK_API_KEY`），再通过 harness 凭据服务保存密钥、在启动环境里导出它，或写进 harness home
的 `.env`。引用按请求解析；一个被点名却解析不到任何值的引用会让请求以 `MISSING_CREDENTIAL`
失败，而不是在未认证的情况下发出。从 OWCode 原样导入的档案可以保留内联 `apiKey`。

只挂载一次。若某套 composition 已经带了 `llm-service-lite` 行（已归档的
[dsh-lite](https://github.com/snnh/dsh-lite) fork 的 `dsh-base` bundle 曾带一行），那一行已经
接到本包：以不激活 bundle 的方式安装（`dsh plugin --profile web add -D
@snnh/dsh-llm-service-lite`）并沿用既有行即可。这一行只保留一层：后一层插入的同 id 行会替换
先前那行及其**整个 `config`**——patch 层从不深合并——因此第二行会静默丢掉第一行配置过的东西，
而不会挂载第二个实例。

### 路由名

<a id="route-names"></a>

同一套 composition 里挂载的各适配器之间，路由名必须唯一。上游标准 profile 随附的 `llm-pi-ai`
目录已经声明了常见服务商名（`deepseek`、`openai`、`anthropic` 等），因此优先选一个能点明端点
本身、又不会撞上已安装目录的独立路由 id——`deepseek-direct`、`company-gateway` 之类。路由名
被别的适配器占用时，该档案会被跳过并记录一条点明占用者的警告，而不会让整个挂载失败；其余档案
照常注册。写入时若有新增档案占用已被别的适配器声明的路由名，会在写入处被拒绝；改掉路由名就是
修复方式。插件也会按名拒绝第一方 DeepSeek 通道所拥有的路由；见[使用本包](#use-this-package)。

### 兼容性

本包走 `@deepseek-ai/dsh-llm` 的公开缝与 `@deepseek-ai/cordis` 的服务层，因此它面向**已发布的
harness 版本**而不是某个检出：它的 peer 就是这些 harness 包，而加载它的 profile 本就持有运行时
使用的那份拷贝。开发基线是 harness `0.2.1-rc.2`——`devDependencies` 固定这些包，测试套件也在
它们之上运行——而 `^0.2.1-alpha.2` 的 peer 范围同样接受 `0.2.1` 的 alpha 线，所以更早的
`0.2.1` harness 也能加载同一个包。

有两条[已归档 dsh-lite](https://github.com/snnh/dsh-lite) fork 专属声明：运行时的 harness
带它们就用，不带就跳过——一条是配置界面查询"某个模型 id 该声明什么"的模型默认值注册缝，另一条
是模型信息上的 `outputModalities` 字段。上游 `0.2.1-rc.2` 两者都没有，因此两者在那里都是惰性
的：本适配器把家族默认值留在请求路径上，档案没写的字段照样会被填上；多出来的字段则被运行时
直接忽略。

## 概述

`@snnh/dsh-llm-service-lite` 负责适配第三方模型端点：每条已配置的服务商档案一条路由，统一走自己的传输——OpenAI 兼容的 chat-completions 线协议、Anthropic Messages 协议与 OpenAI Responses API——因此请求路径里既没有服务商 SDK，也没有已安装目录。一条档案是自包含的——线协议、端点、凭据引用、请求体附加字段、并发度，以及该端点所服务的模型——因此自建网关、国产模型 API 与公司网络里的代理走同一条代码路径，也不必有人事先认识这个服务商。

## 目录

- [安装](#install)
- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当一个部署想自己描述模型服务商，而不是只能点名某个内置目录已经认识的厂商时，就挂载本插件。`providers` 字典就是全部配置面：每个键是一条路由，请求用 `GenerateOptions.provider` 选中它；值是这条端点所需的一切。

### 何时选它

本插件只做第三方端点的适配：它注册的每条路由都来自部署自己写的档案，第一方 DeepSeek 渠道保留自己的适配器。DeepSeek 默认就是那条渠道，因此它拥有的路由名——`deepseek-official` 与 `deepseek-account`，分别由 `@deepseek-ai/dsh-llm-deepseek-api-key` 与 `@deepseek-ai/dsh-llm-deepseek-account` 注册——在此处被按名拒绝，诊断里写明归属方，而不是先占用、再让插件加载失败。DeepSeek 自身就走那些官方模块——本适配器不是那条渠道的替代品。其余路由名不受限制：若某部署要通过本适配器接入一个兼容 DeepSeek 的端点，就用自己的路由名，并声明该端点自己的能力。同一个组合要服务多个端点时选它——国产模型 API、自建的 vLLM 或 SGLang 网关、公司网络里的代理——每一条都需要被完整描述，而不是从目录里推导。当 pi-ai 目录里已经有对应条目、能提供协议与模型能力时，选 `dsh-llm-pi-ai`。两者可以同时挂载：路由名已被别的适配器占用的档案会在挂载时被报告并跳过，而写入一条占用该名字的新档案会在写入处被拒绝（见[路由名](#route-names)）。

### 配置服务商档案

<a id="configure-provider-profiles"></a>

```yaml
- id: llm-service-lite
  name: '@snnh/dsh-llm-service-lite'
  config:
    providers:
      # A provider reached at its published API, with the key from the seam.
      # （这里用 `deepseek-direct` 而非 `deepseek`：上游标准 profile 的 llm-pi-ai
      #   目录已经声明了纯厂商名——见上文「路由名」。）
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

| 字段 | 默认值 | 含义 |
|---|---|---|
| `displayName` | 路由键 | 选择面展示的标签；`providers` 的键仍然是请求选择的路由 |
| `enabled` | `true` | 该路由是否注册 |
| `interfaceType` | 必填 | `openai-chat-completions`、`anthropic-messages` 或 `openai-responses`；每个值各自选择一条传输 |
| `baseURL` | 协议默认端点 | 该路由所有模型的端点；省略时采用该协议惯用的主机与版本段 |
| `catalog` | 无 | 该路由的起始官方格式模型配置：服务商文件的路径，或它解析后的内容 |
| `apiKeyEnv` | 无 | 凭据引用，按请求经凭据缝解析 |
| `apiKey` | 无 | 内联凭据，供从别的工具导入的档案使用 |
| `headers` | 无 | 静态请求头；若同时点名凭据，凭据仍然覆盖 `authorization` |
| `promptCaching` | `false` | 该路由是否可标记缓存断点（仅 anthropic-messages） |
| `includeUsage` | `false` | 是否要求流式返回用量报告（仅 chat-completions） |
| `extraBody` | 无 | 该端点认识的其他顶层请求体字段 |
| `maxConcurrent` | `3` | 超过该并发后请求排队 |
| `streamIdleTimeoutMs` | `300000` | 两次流事件之间的最大空闲时长 |
| `retryPolicy` | normal，5 次 | 由 `dsh-llm-retry` 执行的服务商重试策略 |
| `models` | `[]` | 该路由对外声明的模型及其容量与能力 |
| `defaultContextWindow` | `256000` | 未声明上下文的模型所用的上下文容量 |
| `defaultMaxTokens` | `65536` | 未声明输出上限的模型所用的输出能力 |
| `imageRequestMaxBytes` | `20971520` | 单个请求承载的 base64 图片累计字节 |
| `imageRequestMaxImages` | `600` | 单个请求承载的图片出现次数 |
| `imageOffloadByteQuantum` | `10485760` | 一次确定性卸载步骤移除的字节 |
| `imageOffloadCountQuantum` | `20` | 一次确定性卸载步骤移除的出现次数 |

`models` 的每个条目描述该路由服务的一个模型：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `id` | 必填 | 线上发送的精确模型 id，也是 `GenerateOptions.model` 所点的名字 |
| `name` | 即 `id` | 选择面展示的模型名 |
| `contextWindow` | 路由的 `defaultContextWindow` | 上下文容量（token） |
| `maxTokens` | 路由的 `defaultMaxTokens` | 模型声明的输出能力；Responses 线也把它当作请求上限 |
| `capabilities` | 无 | 在[声明模型能做什么](#declare-what-a-model-can-do)中声明的端点能力 |
| `imagePixelBudget` | 源尺寸 | 每张请求图片投影进的像素预算（`宽 × 高`），或 `low` 表示官方低细节网格 |
| `imageMaxBytes` | 适配器默认（2 MiB） | 单张请求图片的编码字节目标；没有一档能装下时取质量阶梯中最小的结果 |
| `imageTokens` | 无 | 为含图片的上下文计价所用的视觉 token 计价方式 |
| `defaults` | 无 | 调用方未给值时端点希望的请求参数（`temperature`、`topP`、`topK`、`maxTokens`） |

### 从官方配置文件开始

官方发行版为每个服务商发布一个配置文件——一张以 API 为键、条目键为 `chat:<id>` 的映射。`catalog` 把这样的文件转换为本适配器自己的词汇：API 成为路由的 `interfaceType`（`openai-completions` 转 `openai-chat-completions`，另有 `openai-responses`、`anthropic-messages`），`baseUrl` 成为 `baseURL`，所有模型共用的请求头成为路由的请求头，每个 chat 条目成为一个模型，带上它的 id、名称、`contextWindow`、`maxTokens`、输入模态与思考档位。模型的 `samplingParams` 成为它的 `defaults`，端点的采样设置因此是配置，而不是调用方的事。本适配器没有对应物的字段——`cost`、未建模的 `compat` 标志、`inputLimits`、以及它不服务的模型类型——会逐条报告而不是被猜测，路由照常服务。所有条目共用的请求头成为路由的 `headers`；只有彼此不一致、一条路由无法承载的请求头集合才会被报告。档案自己的字段优先于转换结果；`models` 缺省或为空时保留目录中的模型；协议或端点不一致、没有任何 chat 模型、或无法读取的文件，会让这条路由留下诊断，而不是变成一个转了一半的路由。

```yaml
providers:
  kimi-coding:
    catalog: /etc/dsh/official/kimi-coding.json
    apiKeyEnv: KIMI_CODING_API_KEY
```

### 声明模型能做什么

<a id="declare-what-a-model-can-do"></a>

模型条目的 `capabilities` 是对端点的声明，不是猜测：没写的就不声明，写下的要么被履行、要么在声明处被按名拒绝——绝不"接受却无人在用"。`effort` 列出可选的推理档位，其值即线上拼写，因此自有词汇表的网关直接声明自己的词汇。`thinking` 列出可接受的思考模式（`enabled`、`disabled`、`adaptive`）。`thinkingStyle` 说明端点如何表达这个开关：`thinking: { type: … }`、顶层 `enable_thinking` 布尔值、始终思考的 `fixed`，或 `effort_only`——"只收档位、没有开关"的显式写法，与省略样式发出的是同一个请求。`reasoningContent` 声明端点会以 `reasoning_content` 返回思考，这正是后续请求得以回带既有思考的依据。`replayReasoning` 决定这份既有思考是否真的发回：缺省交给模型家族（见下），`true` 表示发回；后续轮次缺它就被拒绝的家族，不允许关闭。`tools` 声明是否允许发送工具声明：关闭的模型收到的请求里没有工具列表，而不是一份会被端点拒绝的清单。`modalities` 声明端点接受哪些输入——`text`、`image`、`video`。其中 `image` 已被承载：保留的图片按模型声明的像素预算（或源尺寸）从附件提供方读取，按模型的字节目标重新编码，并以 base64 `image_url` 内联部分发出；已被会话卸载的图片则贡献它的占位文本。整条路由累计的请求由 `imageRequestMaxBytes`、`imageRequestMaxImages`、`imageOffloadByteQuantum` 与 `imageOffloadCountQuantum` 约束；超预算的请求以 `IMAGE_OFFLOAD_REQUIRED` 失败并给出必须卸载的最旧图片数量，而不是静默丢弃图片。`imageOutput` 声明该模型会自己产出图片：端点返回的内联图片经附件提供方落盘，并以可持久化的图片块重新发布；未声明该能力的模型若返回图片，会按名失败；而该声明在 `anthropic-messages` 上会被拒绝——那条协议的助手回合没有图片部件。`video` 被接受并以文件承载：一次视频出现以任何文件都会贡献的句柄文本抵达模型，原生部件要等 harness 自己的视频内容块。`responsesEncryptedReplay` 已由 Responses 传输履行：请求会索要 `reasoning.encrypted_content`，并在下一回合把每个 reasoning item 原样交回。`systemPromptUpdate` 与 `toolUpdate` 声明 Messages 端点可以被要求的两种"会话中途读取"：把最新的 system 消息读作完整的生效提示词，以及把一次工具变更读作对声明列表中已有工具的启用或停用。声明其中任意一条，harness 才会把 `tool-addition` 与 `tool-removal` 块交给这条路由，而不是每回合重述提示词与工具列表；被推迟的工具，其声明随之带上 `defer_loading`。两条声明在两种 OpenAI 线上都会被拒绝——那里没有可供读取的中途部件。`imageTokens` 声明端点自己的视觉 token 计价——扁平像素网格用 `{ kind: area, per: 750 }`，底价加逐方形瓦片计价用 `{ kind: tiles, tile: 512, base: 85, perTile: 170 }`——token meter 正是据此为含图片的上下文计价；未声明该字段的路由保留 meter 自己的结构化启发式，而不是本适配器臆造的数值。

**家族默认值。** 手写的档案写下作者已知的部分，其余交给模型家族：`src/model-defaults.ts` 是一张经过核对的表，记录主流家族官方文档里的参数——视觉模型接受的图片输入、家族平台自己的推理档位与默认档、思考开关的拼写，以及既有思考是否必须回传。表只填补档案留空的部分，因此档案写下的值永远优先；表里没有条目的模型保留适配器自己的保守答案；表内不设任何采样参数默认，因为各家的可用范围不一致，端点自己的默认胜过臆造的数值。每条都记下出处文档，且只认模型自家平台：中转商或网关对同一模型 id 的要求不作为依据。

模型条目的 `defaults` 声明该端点在调用方未给值时所希望的请求参数：`temperature`、`topP`、`topK` 与 `maxTokens`。每个值只在调用方自己没写时才会写出，因此默认值永远不会覆盖显式选择；`topK` 在 `openai-responses` 上被拒绝，因为那条协议没有 top-k 字段；`defaults.maxTokens` 是未声明输出上限的调用方拿到的值。模型自己的 `maxTokens` 是能力而不是请求默认，而三条传输对输出上限的处理各不相同：`chat-completions` 仅在调用方（或声明的 `defaults.maxTokens`）给出上限时才发送 `max_tokens`，因此自己设有默认上限的端点会保留它；`anthropic-messages` 强制每个请求都带该字段，取值顺序是调用方的值 → 档案的 `extraBody.max_tokens` → `defaults.maxTokens` → 模型家族上限 → 没有家族时的 64K；`openai-responses` 同样总是发送 `max_output_tokens`，取值顺序是调用方的值 → `defaults.maxTokens` → 模型的 `maxTokens`（模型未声明时用路由的 `defaultMaxTokens`），并抬到该 API 的 16 token 下限。

图片请求需要挂载附件提供方（`attachments`）；只服务纯文本路由的部署从不挂载它，而声明了 `image` 却没有附件提供方的路由，会在端点看到任何部分调用之前就让请求失败。

### 运行期改配置

每次操作都会捕获当前的服务商集合。路由集合变化——或某条路由的显示名、重试策略变化（注册表在注册时捕获这些）——会就地把同一适配器实例重新注册，因此进行中的请求保持它启动时的端点，下一次请求才看到新配置。并发度属于准入层而非注册层：修改 `maxConcurrent` 会在下一次请求时更新该路由已有的队列，而不是重新注册，已经排队的请求保持原位。无法服务的档案在写入处就被拒绝；已经存下来的则保留其诊断、仍可被按名寻址，而不是把其他路由一起拖垮；路由名被别的适配器占用的档案会在挂载时被报告并跳过（见[路由名](#route-names)），而不是让整个组合失败。

### 从端点发现模型

配置面在编辑或起草一条路由时，本插件回答"这个端点能提供哪些模型"。已配置的路由在 Host 内部提供已存的端点、协议、请求头与凭据；草稿提供自己的端点与协议，它带的一次性凭据在该次查询中优先于已存凭据。列表读取是协议感知的：两条 OpenAI 兼容线查询 `GET {baseURL}/models` 并走 bearer 认证，Anthropic Messages 路由查询该协议自己的 `/v1/models` 列表（带 `x-api-key` 与 `anthropic-version`），两种公开的 OpenAI 兼容形态都接受——标准 `data` 数组与增强的 `models` 映射。回复只是候选元数据，供配置面采用：不落盘任何内容，路由服务什么由用户保存的档案决定。端点不可达、返回的不是 JSON、或列表超过 4 MiB 时，查询以 `DISCOVERY_FAILED` 失败；端点返回错误状态时报为 `INVALID_REQUEST`，没有可读列表的协议则按 `INVALID_CONFIG` 拒绝。

### 失败与恢复

失败携带稳定错误码：点名的凭据解析不到时是 `MISSING_CREDENTIAL`，请求被拒是 `INVALID_REQUEST`，配额耗尽归为 `QUOTA` 而不是限流，超出模型上下文是 `CONTEXT_WINDOW_EXCEEDED`——正是它让 agent 去压缩而不是重试。没有终止事件就结束的流报 `TRANSPORT`，而不会看起来像一次完成的回合；没有任何内容的补全报 `EMPTY_RESPONSE`。服务商要求的等待时长从 `Retry-After` 读出并交给重试层。

<a id="understand-the-implementation"></a>
## 理解实现

### 设计信条

三条规则塑造了这个包。档案即全部事实：不从内置目录推导任何东西，因此不是 OpenAI、Anthropic、DeepSeek 的端点是被"配置"出来的，而不是被特判的。声明即承诺：请求路径只发送档案声明过的东西，绝不自行发明开关。失败在发生处归类：传输层把每个 HTTP 状态与错误体收敛成一个稳定错误码，因为只有它看到了服务商的完整回答。

### 源码地图

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件：档案解析、路由注册、配置目录、模型发现 |
| `src/config.ts` | 配置 schema 与档案词汇表 |
| `src/profiles.ts` | 校验档案并物化为路由事实 |
| `src/models.ts` | 把模型事实投影到服务缝的模型词汇 |
| `src/adapter.ts` | 适配器：按路由快照、准入、空闲看门狗、派发 |
| `src/chat-completions.ts` | chat-completions 的请求组装与流翻译 |
| `src/anthropic-messages.ts` | Messages 的请求组装、配对修复与思考签名回放 |
| `src/anthropic-stream.ts` | 把 Messages 事件流翻译成 harness 的分块词汇 |
| `src/openai-responses.ts` | Responses 的请求组装、输入项映射与推理回放 |
| `src/responses-stream.ts` | 把 Responses 事件流翻译成 harness 的分块词汇 |
| `src/sse.ts` | 只在数据帧上打点的 SSE 分帧 |
| `src/errors.ts` | 服务商失败分类 |
| `src/limiter.ts` | 按路由的 FIFO 准入控制 |
| `src/discovery.ts` | 供配置面使用的端点问询 |

### 注册与配置目录

没有档案的挂载不注册任何路由：在其设置段提供档案之前，插件不持有路由——这正是基础组合可以把它挂成休眠态的原因。本实例挂载的每条路由都会出现在可配置服务商目录里，包括已停用或当前无法服务的那些，配置面因此能按名寻址并修复它们。若某条档案的路由名已被另一个挂载的适配器占用而遭跳过，它不会出现在目录里——那个名字属于另一家族，改掉档案的路由名才是修复方式（见[路由名](#route-names)）。

### 线上翻译

三条传输服务同一道缝：`openai-chat-completions` 说 OpenAI 兼容的线协议，`anthropic-messages` 说 Messages 协议；两者都承担了三件服务商不做的事：块的身份与顺序、跨流式分片拼装工具调用，以及区分"流结束了"与"流被截断了"。

两者也都在出门时修复各自协议的配对规则，因为持久历史可能持有端点无法接受的形态。调用已不在的结果被丢弃；同一条助手回合内重复声明、或后续回合再次声明的调用 id，折叠为其首次出现；同一个调用的重复结果只留首条；无人回答的调用补一个占位结果，而不是留给端点回一个 400；同一并行批次的结果合并为两种协议都要求的单个 user 回合。修复发生在线上投影里，因此持久日志绝不会为了请求可被接受而被改写。

思考只在目标模型声明过、且历史由同一服务商产生时才回带。`openai-chat-completions` 经 `reasoning_content` 回带，并且只按 provider 匹配历史；`anthropic-messages` 与 `openai-responses` 还要求来源模型一致，分别通过助手消息上的适配器私有回放元数据回带带签名/redacted 的思考块或服务商自己的 reasoning item。Messages 协议拒绝没有签名就返回的 thinking 块；由别的服务商、别的模型或别的适配器写下的元数据只把那一个回合降级为纯文本，而不是让请求失败。

Responses 传输把对话映射为该 API 的扁平 item 列表——助手 `message`、每个调用的 `function_call`、以及携带同一 id 的 `function_call_output`——并按同样方式修复这份清单，只有一处是该协议强制的差异：无人回答的调用被丢弃，而不是补占位结果，因为严格的网关会拒绝伪造的输出；一个回合内的并行调用会被归组，使该 API 把它们折叠进同一个助手回合。它的推理遵循模型声明：`reasoningContent` 把思考文本按 `reasoning_text` 回带，`responsesEncryptedReplay` 则把服务商自己的 item 原样交回。该协议不携带停止序列，因此调用方的 `stop` 被省略，而不是被近似。

Messages 传输的提示词取自 `system`，否则取自首条 system 消息。其后出现的 system 或 developer 消息就地折叠为一个 user 回合，会话中途的指令得以保持位置——除非该模型声明了 `systemPromptUpdate` 或 `toolUpdate`：此时该消息以本协议专为中途变更保留的 `system` 角色消息出行，工具增删写成对被声明工具的引用。这类消息会等到它前面是 user 回合才落位，因为该协议把它读作回合之间的指令；若它本会落在更早的位置，则被按名拒绝，而不是被搬走。工具结果把随附媒体以内联图片块的形式放在文本旁边；`max_tokens` 必发，因为该协议强制要求输出上限；`promptCaching` 标记该协议自己的断点：system 提示与最后一条工具声明。

<a id="further-exploration"></a>
## 延伸阅读

- [LLM 流式子系统](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/llm-streaming.zh.md) —— 本包实现的消息与块类型、组装后的请求，以及适配器契约。
- [服务商指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.zh.md) —— 部署如何在发行组合上配置服务商。
- [OpenWebCode](https://github.com/snnh/openwebcode) —— 本适配器遵循的服务商档案模型。

<a id="model-experience"></a>
## 模型体验

**Plugins** 页上的服务商配置页只面向操作者：它编辑 Host 配置，不向模型贡献任何提示词、工具或上下文面。下面描述的模型体验不受该页面影响。

### 经适配器发出的请求

#### 模型看到什么

harness 组装出的对话原样：系统提示词作为开头的 system 消息，用户与助手回合按序排列，工具声明为函数 schema，每个工具结果紧邻它所回答的调用。请求会附加该端点自己的 `extraBody` 字段，以及——当模型声明了如何拼写时——调用方选中的档位与思考开关。

#### token 影响

请求不携带适配器撰写的系统提示词文本；本适配器自己贡献的文本只有确定性的框架文本：两条 OpenAI 线在工具结果携带媒体时用作引导的 `Attached media from tool result:` 说明、为始终没有落地的工具结果补的占位文本，以及 Messages 助手回合无法以其他方式承载时出现的 `[context trimmed]` 标记。chat-completions 请求里的 `max_tokens` 仅在调用方配置过时才出现，因此自己设有默认上限的端点会保留它；Messages 与 Responses 协议强制要求输出上限，因此两者总是发送：取自请求、档案的 `defaults`，或模型声明的上限（Responses 会把低于该 API 16 token 下限的值抬高）。

#### KV 缓存影响

翻译里没有任何逐请求随机量：同一段历史产生同一份请求字节，服务商侧的前缀缓存因此跨回合持续有效。标记了 `promptCaching` 的路由使用协议自身的缓存标记——Messages 传输会标记 system 提示与最后一条工具声明——除此之外本适配器不添加自己的缓存断点。

### 服务商的响应

#### 模型看到什么

内容增量成为文本块，`reasoning_content` 成为思考块，带签名的思考成为思考块并把签名留存为回放元数据，流式工具调用分片拼成一个个调用。服务商自己的停止原因被映射到 harness 词汇；没有停止原因就结束的流是传输失败，而不是完成的回合。

#### token 影响

端点发送用量时才上报用量，缓存命中的提示词 token 按 harness 契约从输入计数中分离：`inputTokens` 不含服务商从缓存提供的那部分，后者计入 `cacheReadTokens`。

#### KV 缓存影响

回带的思考与服务商返回的字节一致，因此会回显思考的路由保持其缓存前缀稳定；未声明 `reasoningContent` 的路由完全不发思考，而不是发一段转述。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **三条协议，三种形态。** 每个被声明的协议都有自己的传输，各自承载本协议的特性：Responses API 的服务端工具（`web_search_call` item）未被承载，也不发送 `store` 字段，因此想要服务端状态的部署应把它排除在请求路径之外。
- **配置在 Models 页扩展席位、插件页或 patch 里。** 本包填充 Models 页的适配器家族扩展席位，也提供 **Plugins** 页里本 bundle 的配置页；其余手写字段仍写在 profile 的 `cordis.patch.yml` 里（见[挂载](#mount)）。
- **视频输入以文件抵达，而不是活动画面。** 声明的 `video` 输入以任何附件都会贡献的文件句柄承载，因为这里没有哪条线有视频部件、harness 也还没有视频内容块。`image` 输入已被承载，档案通过 `imageTokens` 声明的计价同样被承载；未声明该字段的路由保留 meter 的结构化启发式；字节旁边也不会附带适配器自撰的说明文本，因此一条被计价的出现次数只计入端点实际收取的视觉 token，不计入本适配器臆造的部分。
- **适配器侧不重试。** 一次调用就是一次服务商尝试，重试策略由 `dsh-llm-retry` 在持久步骤边界执行，重试会重新推导整个请求。
- **回放元数据是分协议的。** Messages 传输为自己写下的思考签名维护专属信封，Responses 传输则保留每个 reasoning item（id 与加密载荷）供索要加密回放的模型使用；两种信封都不跨服务商移植。
- **中途变更属于端点自己的契约。** 声明了 `systemPromptUpdate` 或 `toolUpdate` 的路由会以 `system` 角色历史消息接收它们，因此若某端点把该部件挡在 beta 头之后，部署须在 `headers` 里写明该头：本适配器不代端点注入任何东西；而一个前面没有 user 回合可跟随的变更会让请求以 `UNSUPPORTED_CONTENT` 失败，而不是被静默搬移或丢弃。
- **没有用量报告就没有流式用量。** 从不发送用量块的服务商，其 token 记账交给 harness 的估算器。

<a id="dev-note"></a>
### 开发备注

两者是刻意共存的：目录路由是通往已知服务商的最短路径，这条路由则是通往任何"非已知"端点的诚实路径。

<a id="development"></a>
## 开发

```sh
pnpm install              # 安装已发布的 harness peer
pnpm run typecheck        # tsc -b：src -> lib/types
pnpm run typecheck:tests  # tsconfig.test.json：src + tests，不产出
pnpm run check            # typecheck、typecheck:tests 与测试套件
pnpm test                 # vitest，tests/**/*.spec.ts
pnpm run build            # 先类型检查，再打 host 包，最后打浏览器包
```

`tsconfig.test.json` 负责类型检查测试；随包发布的 `tsconfig.json` 不包含它们。CI 在 Node 22 与
24 上运行 `pnpm run check`。本包是纯 ESM，只打包自己的代码：所有 harness 包保持 external，
因为加载插件的 profile 持有它们唯一的那份运行时拷贝。

`build/client-bundle.mjs` 把编译出的浏览器半区包成客户端模块系统的工厂格式
（`lib/client.js`，即 `./client` 导出的目标），React 与共享 UI 包仍由页面的冻结模块表提供。

除运行入口外，本包还自带声明：`cordis.patch.yml` 是挂载插件行的 bundle 层，
`package.json` 的 `dsh.bundle.patch` 指向它，`locale/*.json` 与 `icon.svg` 则是插件清单在不加载
插件代码的前提下读取的显示资源。`tests/declaration.spec.ts` 把这三者绑在一起，因此新增资源时
记得让 `exports` 与 `files` 覆盖到。

## 许可证

MIT。本插件实现的 harness 接缝来自
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（同为 MIT）；
插件本身是由 [snnh](https://github.com/snnh) 维护的社区代码。
