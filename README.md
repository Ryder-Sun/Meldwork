# Meldwork Landing

单屏全屏背景 Landing Page，静态 HTML + CSS + 原生 JS，无构建步骤。风格参照「视频背景 + 点阵显示字体 + 白色 pill 导航」的参考 prompt，视觉系统完全适配 Meldwork 品牌。

## 产品文案定位

核心表达：**提出目标，让 Agent 们协作完成。** Meldwork 是本地优先的多 Agent 协作工作空间，让选定的 Agent 共享上下文、讨论方案、在授权范围内执行并相互检查，减少用户转述和协调下一步的工作。用户设定目标和权限，在需要补充信息、授权或关键决策时介入。

过程记录用于回看进度与产物，不宣传为完整的事实核验或证据溯源能力，也不承诺所有任务都能无人干预完成。首页正文、搜索摘要、社交分享摘要和 JSON-LD 使用同一定位。

## 打开方式

直接双击 `index.html`，或本地起服务：

```bash
npx serve .   # 或 python3 -m http.server
```

## 品牌物料复用（assets/）

| 物料 | 来源 | 用途 |
| --- | --- | --- |
| `meldwork-mark-v3.svg` | frontend/public/logos | 头部圆形 logo 徽章 |
| `meldwork-wordmark-v3-dark.svg` | frontend/public/logos | 产品弹窗品牌字标 |
| `meldwork-favicon*.png` | frontend/public/logos | 站点图标 |
| `screenshots/meldwork-group-collaboration.png` | assets/ | Open Graph 分享图及协作画廊 |
| `agents/*` (13 个 CLI logo) | frontend/public/agent-logos | 信任条头像环（取 Codex / Claude / Gemini / Qwen / Kimi 5 枚） |
| `screenshots/*` (4 张) | assets/ | Product 弹窗实拍画廊 |
| `bg-keyframe.png` | AI 生成（Trace mark 视觉语言：珊瑚色工作线 + 点阵节点） | 背景层 + video poster |

## 设计决策

- 配色取自产品暗色主题 token（`#121516` 底、`#93a0a5` 弱化文字）与 logo 珊瑚色 `#EF5A45`；导航激活的三点指示器刻意使用珊瑚色，呼应 Trace mark 的「人类采用点」。
- 中英文标题采用本地 Fusion Pixel 字体，附带 OFL 许可证。
- 统计条展示：13 个已支持 CLI、3 种协作模式、本地优先工作空间、1 个共享任务；Agent 模型调用仍可能访问各自配置的服务商。
- 动效遵循 `prefers-reduced-motion` 降级；弹窗/移动菜单支持 Escape 与遮罩关闭并锁定背景滚动。

## 语言

右上角可切换中文 / EN，默认跟随浏览器语言，选择保存在 `meldwork-landing-locale`。正文与富文本翻译使用 `index.html` 的 `data-zh` 属性，`i18n.js` 统一更新语言、辅助标签、页面标题、分享摘要和中文 FAQ 结构化数据。即使本地存储不可用，也可在当前页面切换。官网不依赖 Vue 或额外构建步骤。

中英文标题与状态标签使用本地 Fusion Pixel 12px 等比例像素字体；正文使用 Inter 与系统中文无衬线字体。字体版本为 2026.10.16，来源为 [Fusion Pixel](https://github.com/TakWolf/fusion-pixel-font/releases/tag/2026.10.16)，字体及上游 OFL 声明保留在 `assets/fonts/fusion-pixel/`。

## 案例卡片与颜色

案例区继续使用项目已有的原生 Stepper。五条记录始终可读；自动播放只推进当前节点与轻量位移动画，按文本长度留出至少 7 秒阅读时间，到最后一条停止。悬停、键盘焦点、页面隐藏或离开案例区时暂停，手动翻页后可主动继续。减少动态效果模式默认展示完整记录，禁用自动播放。

官网强调色对齐产品：暗色 `#d98568`、浅色 `#d45f52`。透明色从同一组 RGB 变量派生，降低发光与背景视频饱和度；现有品牌标志不改色。

案例卡片通过背景明度和阴影区分当前贡献，不使用左侧描边。Agent Logo 采用白色底座，便于识别深色或透明图标。

## 全页字符余烬背景

`glyph-embers.js` 是原生 Canvas 实现，视觉方向参考 [React Bits Pro Glyph Ember](https://pro.reactbits.dev/docs/components/glyph-ember) 的公开描述：字符火焰、亮色底床与上升余烬。当前官网没有 React/shadcn 环境，且未配置 `REACTBITS_LICENSE_KEY`，因此没有安装 Pro 注册表组件，也没有复制其付费源码或新增 `components.json`。

背景固定覆盖整个视口。多层连续噪声向上平流并扭曲火舌，混合字母与符号按热度映射为字符密度；底床由暖橙过渡至象牙白，独立的模糊辉光层与漂浮火星提供层次。卡片保持实色以保护阅读，首页原视频降低为次要背景。绘制上限为 20fps、280 列、110 行、1.5 倍像素比；页面隐藏时取消动画帧，减少动态效果模式仅绘制静态版本。背景不接收鼠标事件，并从辅助技术中隐藏。

## 验证

先安装现有前端开发依赖，再运行专项测试：

```bash
node --test meldwork-landing/test/landing.test.cjs
```

该命令从仓库根目录执行，使用现有前端依赖中的 JSDOM，覆盖双语、语言记忆、完整文案、播放节奏、键盘控制与减少动态效果。视觉检查使用本地 HTTP 服务，同时检查中英文、明暗主题与窄屏。更新样式或脚本时同步刷新 `index.html` 中的资源版本参数。

## 升级为视频背景（可选）

当前背景为关键帧 + Ken Burns 缓慢推拉动画（`styles.css` 的 `.bg-still`）。生成一段与 `bg-keyframe.png` 同构的 10s 循环视频（Seedance image_to_video，提示词：coral trace line gently drawing forward, particles drifting, slow push-in, no text），保存为：

```
assets/meldwork-bg.mp4
```

`<video>` 层会自动覆盖静态层，无需改代码；视频加载失败时仍回退到静态关键帧。

官网原创代码及文档采用 Apache-2.0，允许商用；第三方字体和 Agent 标志保留各自条款。见 LICENSE、NOTICE 和 COMMERCIAL_USE.md。
