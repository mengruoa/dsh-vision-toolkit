# 按工具组可见性开关（toolVisibility）实现规格

## 目标

在 `vision-toolkit` 配置下新增一个粗粒度可见性开关组，按"会话头快照"生效：

- 开 → 该组工具在**下一个 agent 对话**（下次激活）可见；
- 关 → 不可见；已激活 agent 维持激活时的旧快照，不实时增删（激活时截取快照语义）。
- 保留全局兜底 `vision_toolkit_activate`，但语义改为"显式刷新/重载视觉工具集"，AI 只在用户要求时调用。

## 三个开关与工具分桶

新配置段（全局一份，旧配置自动兼容，缺省即默认值）：

```yaml
vision-toolkit:
  toolVisibility:
    local: true     # 本地处理工具，默认开
    online: true    # 联机图片工具 + concurrency，默认开
    video: false    # 视频理解工具，默认关（UI 标注「测试」）
```

| 桶 | 开关字段 | 工具 | 走 concurrency？ |
|----|---------|------|----------------|
| **local** | `toolVisibility.local` | `vision_trace`、`vision_crop`、`vision_pixel_diff`、`vision_extract_foreground`、`vision_dominant_colors`、`vision_html_screenshot`、`vision_video_info` | 否（本地处理，无并联限制） |
| **online** | `toolVisibility.online` | `vision_glance`、`vision_ground`、`vision_detect`、`vision_long_screenshot_ocr`、`vision_concurrency` | 是（受 session 并发限流） |
| **video** | `toolVisibility.video` | `vision_video_understand` | 是（走后端能力） |
| 兜底 | 永远可用 | `vision_toolkit_activate` | — |

> 说明：
> - `vision_concurrency` 归 `online` 桶，且其语义改为"当前**联机服务**的可用并发配额"，本地工具不受并行限制。工具描述 / 返回需随之更新。
> - 上游"那 10 个工具"被拆进 local 与 online 两桶，二者默认均开，构成完整上游集 + `video_info`。
> - 默认全开（local+online），video 默认关。

## 可见性判定

对某个工具 `T`：**激活 agent 作用域工具集时**，根据当时读到的 `toolVisibility` 快照，逐个决定是否注册该工具的定义。

- `local` 桶工具 → 若 `toolVisibility.local === true`。
- `online` 桶工具 → 若 `toolVisibility.online === true`。
- `video` 桶（`vision_video_understand`） → 若 `toolVisibility.video === true`；**不再**受 `videoSupportEnabled` 门控决定"是否暴露"。
- 激活后不再变动；后续设置改动只影响下一个 agent 的激活。

## 视频工具与后端能力的解耦

`videoSupportEnabled`（provider 的 `videoSupport` 标记）**不再**决定 `vision_video_understand` 是否出现在工具列表。

- 工具可见性：仅由 `toolVisibility.video` 决定。
- 工具成功率：调用 `videoUnderstand` 时，若无任何具备视频能力的可用 provider/模型，**返回明确的"视频理解不可用"错误**（沿用 `config` 类错误，文案如 `no enabled vision service has video support; enable it in Settings first`），而不是在暴露阶段就隐藏。

## `vision_toolkit_activate` 兜底改造

- **始终存在、不分桶**。
- **描述改写**：从"激活 vison 工具"改为"**当用户显式要求刷新/重载当前会话的视觉工具时调用**"。要求模型仅在用户显式触发时使用，不作为普通激活路径。
- 调用后按**当时**的 `toolVisibility` 快照重新生成工具集（重载），并返回当前实际可用的工具清单，让 AI 自查。
- 保持"激活后从模型视野收起"的既有行为，但语义对齐上述描述。

## 配置 / UI

- `src/config.ts`：新增 `toolVisibility` 字段（`local`/`online`/`video` 三个 bool），schema 默认 `{local:true, online:true, video:false}`，迁移兼容旧配置。
- `src/client/index.tsx`：视觉工具高级设置区新增三个开关，label：
  - 本地工具（默认开）
  - 联机图片工具（默认开）
  - 视频工具（默认关，文案标注「（测试）」）
- `src/runtime.ts`：`videoSupportEnabled` 语义保持"存在 video-capable provider"；`videoUnderstand` 在无视频 provider 时返回"视频理解不可用"。

## 涉及文件

- `src/config.ts`（schema / defaults / 迁移）
- `src/index.ts`（将 toolVisibility 快照传入 exposure 生成逻辑）
- `src/exposure.ts`（激活时按快照生成对应桶子集；重载语义；activate 描述改写）
- `src/tools.ts`（按桶把工具定义分组；concurrency 描述/语义调整；video 工具与 capability 解耦）
- `src/runtime.ts`（`videoUnderstand` 无能力即报错）
- `src/client/index.tsx`（高级设置 UI：三个开关 + 文案）
- `assets/skill/SKILL.md`（描述补充：按桶可用性、concurrency 语义、activate 的新语义）
- `docs/plan-per-tool-visibility.md`（本文件）

## 待实现时再确认的细点（标记，非阻塞）

- `vision_video_info` 归 local 桶；如需并入 video 桶再调整。
- `vision_concurrency` 返回改写为"联机并发可用额度 + 本地无限制"的说明文案。
- 空桶（如 local 关但 online 开）时无工具可注册，exposure 需正确处理"只有兜底 activate"的情况。