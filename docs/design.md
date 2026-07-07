# One's Own Room — Spark + Three.js + WebXR 实现方案

> 一个属于自己的房间。技术栈：Three.js（场景与 WebXR）+ Spark（高斯泼溅渲染与 dyno shader）+ Marble（环境生成）+ Claude / ElevenLabs（个性化语音）。
>
> 文档定位：既是实现方案，也是学习材料。关键段落后面有「这段在做什么」的解释，借鉴别人思路的地方用 📌 标注出处。
>
> **每节标了状态**：【已实现】= 已做完并跑通（文档按实际实现回填）；【重构】= 已有代码要按新概念改；【待建】= 还没写，本文给设计与代码草图。

---

## 0. 立意：为什么叫 One's Own Room

名字接的是 Virginia Woolf 的 *A Room of One's Own*：人需要一个属于自己的、不被打扰的空间，才能有内在生活。放到 emotional safe zone 语境里，这个房间是一个**你不欠任何人任何东西的自治空间**。

这条立意是所有交互决策的统一准绳。整个体验被设计成**一连串「你可以少给一点」的选项**：

- 名字**可以不给**（门槛层有明确的「I don't need a name here」）。
- 心情**可以不说**（「not today」跳过，她的欢迎不带 context，仍然成立）。
- 话**可以不说**（进房后她在，但你不去触碰悬浮球，就是独处）。
- 陪伴**可以不要**（不理球，她不会打扰你）。

所以本方案通篇不用「疗愈 spa」「meditation guide」这类框架——那会把房间变成一个「对你做点什么」的服务。这里相反：房间不对你做任何事，它只是**在场**，一切由居住者决定。那个声音不是治疗师、不是助手，她像是房间本身有了一点温柔的意识，注意到你进来了（persona 见 Step 10）。

> 与 kagami→kami 那套去自我中心哲学的呼应：空间不是被展示给你，而是**因你的输入而显现**（Step 6 显形入场把这一点做成了字面事实）。

---

## 1. Demo 范围（当前开发目标）

Demo 只有两个界面，其余一律推后：

**界面 1 · 门槛层（threshold）**：title + 悬浮球在场 → 她用预录语音欢迎并引导（"Welcome to One's Own Room — also, your own room."）→ 问名字（可无名）→ valence×arousal 量表（**照测照记，暂不驱动视觉**）→ 心情描述（**按住球口述**为默认；可「not today」跳过；可键盘）→ Enter → 进入房间。

**界面 2 · 房间**：现有管线原样跑（心情 → 开场白生成 → ready 点燃显形 → 开场白落下）+ **长按球回合制对话**。房间视觉参数不随情绪变。

**明确推后 / 删除的**：

| 项 | 处置 |
|----|------|
| 空间呼吸 | **整体删除**（不再是本项目的一部分；effects.js 的 uBreath stub 与 glow.js 的 breath 参数列入清理项） |
| valence/arousal → 环境参数（冷暖/明暗/动态） | **推后**。量表照测、数据照记、随请求发给 AI；但不驱动任何 uniform。框架保留（Step 5.5），后期接上时数据链路已通，只补 shader 侧 |
| 进房后的键盘小菜单 roomMenu.js | demo 后 |
| meet-and-lead（房间随会话把人往平静带） | future work / 第二个 study 的 RQ |
| full realtime 多轮语音 | 明确的 future work（Step 9 降级链） |

---

## 2. 借鉴标注

本方案所有代码都是为项目**重新写的**，没有复制 cocolinux0101/dreamcore-experiment 仓库的代码。两处**思路层面**的借鉴：

| 编号 | 借鉴内容 | 来源 | 借鉴的是什么 / 改了什么 |
|------|---------|------|---------------------------|
| 📌A | 用 Spark 的 `dyno` 系统给每个 splat 写 GPU 修改器 | cocolinux 的 `shaderEffects.js`（改编自 Spark 官方示例） | 借鉴「用 objectModifier + dynoBlock 注入 GLSL」这个**架构模式**。Spark 公开 API 用法，效果代码全部重写 |
| 📌B | 「场景从虚无中显形」入场 | cocolinux 的 `Magic` 效果 | 借鉴「splat 从 scale≈0 渐变显形」这个**概念**。他用 atan 角度扫描（雷达式）；本方案重写为**绕悬浮球（场景中心）向外的双锋面球面波，由「AI 响应 ready」事件触发**（Step 6） |

另两处属公共领域标准做法：Web Audio `GainNode`（MDN）、`renderer.xr` 的 WebXR 设置（Three.js 官方）。原仓库 MIT 协议，即使直接用也合法；走重写路线是为了原创 + 学习。

---

## 3. 项目结构

```
ones-own-room/
├── public/
│   ├── index.html              # 入口：importmap + 门槛层 overlay（透明，透出 canvas 里的球）
│   └── resources/
│       ├── worlds/
│       │   └── env_*.spz       # Marble 导出，500k 轻量档
│       ├── env/
│       │   └── {px,nx,py,ny,pz,nz}.png   # 悬浮球反射用梦核 cubemap（6 张 png）
│       └── audio/
│           ├── ambient_1.mp3
│           ├── guide_welcome.mp3         # "Welcome to your own room."（2026-07 真机反馈：原双段句砍短）
│           ├── guide_name.mp3            # "What may this room call you? No name is fine, too."
│           ├── guide_valence.mp3         # "How are you feeling right now? Pick the one that feels closest."
│           ├── guide_arousal.mp3         # "And how much is stirring in you right now — quiet, or worked up? Pick again."
│           ├── guide_mood.mp3            # "Hold the orb, and tell me how you are."
│           └── fallback_1..3.mp3         # AI 管线失败时的英语兜底语音
├── js/
│   ├── main.js                 # 场景、WebXR、主循环、debug 控制 【已实现】
│   ├── threshold.js            # 门槛层：语音引导 + 姓名/无名 + 量表 + 对球口述心情 【待建】
│   ├── effects.js              # dyno shader：显形 + 辉光/薄雾 【已实现】
│   ├── glow.js                 # 加法混合光尘粒子层 【已实现】
│   ├── orb.js                  # 悬浮球：金属聆听/玻璃陪伴 + waiting/speaking 【已实现】+ recording 态【待建】
│   ├── voice.js                # 按住球录音 + STT（每回合一次）【待建，先 spike】
│   ├── session.js              # 事件驱动编排 【重构：删定时 slots，加回合循环】
│   ├── audio.js                # 解锁、ambient、ducking、playVoice 【已实现】+ oneFallback/mic analyser【待建】
│   └── roomMenu.js             # 进房后键盘小菜单 【demo 后】
├── api/
│   ├── generate-script.js      # Claude：开场白 + 每回合回应（Woolf persona，语言跟随）【待建】
│   ├── tts.js                  # ElevenLabs TTS 【待建】
│   └── stt.js                  # 服务端语音转文字（是否需要看 voice.js spike 结果）【待建】
└── vercel.json
```

**关键结构决定**：

1. **门槛层是同页 DOM overlay，不是独立页面**——`AudioContext` 跨页面导航即销毁，同页 overlay 才能让「touch to begin」解锁的音频活到 VR 里。
2. **门槛层 overlay 是透明的**：canvas 上此刻正是 uReveal=0 的全黑虚空 + 金属聆听态的球——门槛层的「主视觉」就是**真球本身**，不做假球。DOM 只负责文字与输入件，浮在球的上下方。
3. **心情口述在门槛层完成，动作与房间内完全一致**（按住球说、松手结束）：用户在进房前就学会了房间里唯一需要学的动作。

---

## 4. 三层输入架构（概念主干）

房间接收三层输入，按**生成延迟**分层，这个分层决定了每层能不能做成真·实时：

| 层 | 输入 | 生成方式 | 延迟 | 实时性 | demo 状态 |
|----|------|---------|------|--------|-----------|
| **房间** | Marble prompt（实验前由研究者铺好） | 世界模型生成 | 几十秒~几分钟 | 不可能实时 → **预生成、绿野仙踪式** | ✓ 使用中 |
| **环境参数** | valence × arousal 量表 | shader uniform，改 float | 零 | **真·实时、零延迟** | 量表照测，**映射推后**（Step 5.5） |
| **声音** | 心情描述 + 每回合语音 | LLM + TTS 往返 | 1~4 秒 | **近实时**，回合制扛得住 | demo 核心 |

三层的关系是本项目最值得写进研究贡献的地方：房间是预生成的（wizard-of-oz）；环境参数不经过任何大模型、是唯一零延迟的层，接上后量表就从「测量」变成「generative input」（aesthetics-as-function 的落点）；声音是唯一「内容可实时生成、又扛得住实时」的层，realtime 的成本花在这里最值——回合制（按住球说、松手、她慢慢回）绕开了实时对话最难的端点检测与首字延迟焦虑：松手就是说完，慢本身读作「她在认真听」。

**给研究者的铁律**：三层要能**各自独立开关**（环境映射可关、声音可整个关、球可不出现）。这是为未来实验（2×2 析因 / 分层分组）唯一现在要付的成本（Step 15）。

---

## 5. UI 设计语言（门槛层与一切 2D 层的基准）

### 原则

- **雾中的界面**：UI 元素不是贴在屏幕上的卡片，是悬浮在深色雾气里的光。无实色填充、无阴影、无边框卡片；深度全靠光与雾的层次。
- **一屏一焦点**：逐步式呈现，一次只问一件事；答完淡出，下一件浮现。
- **一切淡入淡出**：没有任何硬切、弹跳、缩放动效；元素像从雾里凝出、又化回雾里。
- **她引导，而不是表单引导**：每一步由预录语音发问（球同步 speaking 脉动），文字退成字幕与输入件。
- **梦幻感来自光与雾，不来自装饰。**

### Design tokens（threshold.js / roomMenu.js 共用）

```css
:root {
  --room-bg:        #0b0b14;                 /* 深蓝紫夜色；scene.background 同步此值 */
  --room-mist:      rgba(121, 119, 132, 0.35); /* 雾紫灰 #797784 */
  --room-text:      rgba(240, 236, 244, 0.92); /* 带紫调的暖白 */
  --room-text-dim:  rgba(240, 236, 244, 0.45);
  --room-glow:      rgba(230, 210, 255, 0.55); /* 光晕（与 glow.js 贴图同色系） */
  --room-line:      rgba(230, 210, 255, 0.30); /* 1px 微光描边 */
  --font-serif:     ui-serif, "Georgia", "Songti SC", serif;
  --ls-wide:        0.12em;                  /* 标题字距 */
  --ls-body:        0.06em;
  --fade-slow:      1.4s;                    /* 屏与屏之间 */
  --fade-fast:      0.6s;                    /* 元素状态变化 */
  --ease-mist:      cubic-bezier(0.4, 0.0, 0.2, 1);
}
```

排印：**细字重衬线体、小号、宽字距、绝不用粗体**——安静的文学感，呼应 Woolf。输入件不用方框，用**一条发光细横线**（1px，`--room-line`，聚焦时缓慢提亮）。按钮只有一枚：药丸形磨砂玻璃（`backdrop-filter: blur(8px)` + 半透明 + 1px 微光描边）。点缀极少量 DOM 光尘微粒（失焦小光点缓慢漂移，呼应 3D 里的 glow dust）；球在场时可以更少甚至不加，球本身就是光源。

### 逐屏 spec

所有屏共享：透明背景透出 canvas（黑虚空 + 金属球），球在画面中心偏下（桌面相机 (0,1.6,0) 看向 −z，球在 (0,1.4,−1.6)，构图天然成立）。

**屏 0 · Title**。球上方远处一行 "One's Own Room"（宽字距、微光）；球下方一行极淡 "touch to begin"。**必须有这次轻触**：浏览器 autoplay 政策下，第一次手势前放不出任何声音——这次轻触同时完成 `audio.unlock()`（AudioContext 解锁提前到这里，Enter 手势减负）。轻触后播 `guide_welcome.mp3`，球走 speaking 脉动。

**屏 1 · 名字**。欢迎语毕，播 `guide_name.mp3`；球上方浮现发光横线输入位 + 字幕提示，横线下偏右一行淡的下划线字 **"I don't need a name here"**——它不是按钮，像一句可以被选择的低语；选它则字段淡出、`inputs.name = null`。给了名字的话，开场白里她会轻轻唤一次（「给 / 不给」因此有重量）。

**屏 2 · 量表**。球退暗退小（`setState` 不动，DOM 侧压一层极淡遮罩即可，勿真改球参数）。五个**重绘的极简线条小人**横排悬浮（SAM 语义，见 Step 5.5）：1px 微光描边、无填充，valence 屏表情由低到高，arousal 屏用小人周围的振动线圈表现能量由静到动。悬停轻微变亮；选中者被柔光环包裹、微微上浮，其余更淡。整组上方一句衬线提示，小人下方**无文字标签**。两屏（或上下两组），各点一下。

**屏 3 · 心情（对球说）**。球回到主角位、比之前亮一点像在等待；播 `guide_mood.mp3`（"Hold the orb, and tell me how you are."）。**按住球（或宽容判定：按住屏幕任意处）= 录音**：`getUserMedia` 在 **arousal 选中的那次点击手势里**提前申请（2026-07 真机反馈修正：原「首次按住时申请」会把那次按住喂给权限弹窗，读作「要按两遍」），权限弹窗随屏 3 淡入出现，首次按住即直接录；hint 只做状态反馈（录音/转写/短按重试），操作指令只有 caption 和她的语音这一处。球进 recording 态，光随音量脉动；松手结束。底部角落两个极淡出口：**"not today"**（跳过，开场白退化为不带 context 的通用版）和一个小键盘图标（切到发光横线的多行打字版）。

**屏 4 · Enter**（2026-07 真机反馈修正：**常驻按钮已取消**）。check-in 最后一项落定即自动渐隐进入——完成本身就是门槛，不再多要一次点击。药丸按钮仅作**兜底**保留在 DOM：requestSession/getUserMedia 需要瞬时用户激活，口述路径的转写延迟可能耗尽激活窗口，自动进入失败时按钮浮现、收一次新鲜手势重试。

**房间内 HUD**：几乎为零。仅右下角保留 34px 背景音开关（已实现）；其余一切交互都在球上。VR 侧的对应物是手柄菜单（Step 6）：按住抓取键才显现的静音/退出双珠，平时零 HUD 不变。

### SAM 小人重绘的一个学术注脚

标准 SAM 图形与本项目视觉语言不合，按上述线条风格重绘，但**五点语义严格忠实原版**（valence: 皱眉→中性→微笑；arousal: 静→爆发）。论文写法："a SAM-inspired pictorial scale redrawn in the project's visual style"。审稿人可能问一句 validity——接受这个小代价，属 HCI 常见做法。

---

## 5.5 valence × arousal 量表 【待建；映射推后，框架保留】

### 理论底座

**Russell 的 circumplex model of affect（1980）**：情绪落在 valence（效价）× arousal（唤醒）二维空间。**量表工具用 SAM（Self-Assessment Manikin, Bradley & Lang 1994）**：图形化、非语言。选它的理由：几乎无文案、一点即答，贴合 voice-first 极简界面；与 VET 论文的 Lang three-system model 同一学术血脉，instrument 有连续性；valence/arousal 是一对坐标，天然可参数化环境（接上映射后量表即成 generative input）。

维度：**二维，不加 dominance**（PAD 第三维与 VET 的 perceived control 同构，但为极简与可映射砍掉）。形态：**两条 SAM 五点**（Affect Grid 一次成型但认知负荷略高，不用）。**避开**：PHQ-9 / GAD-7 等临床量表（pathologize，与 subclinical 定位冲突）；PANAS（20 词条太重）。

### demo 期的处理：测量直通、映射断开

```javascript
// effects.js — demo 版 applyMood：只留框架，不驱动任何视觉
export function applyMood(valence, arousal) {
  // v1 (demo): 数据照收，随 generate-script 请求发给 AI 当 context（Step 12），
  // 并进研究者 session log（Step 14）。不改任何 uniform。
  // v2 (post-demo): 在此接通视觉映射，成本分层如下——
  //   uLift(明暗)   → uExposure 已是 uniform，JS 直接写 .value，零 shader 改动
  //   uDynamics(动态)→ 光尘漂移速度/球 bob 都在 JS 侧，乘系数即可
  //   uWarmth(冷暖) → GLOW_TINT 与 split-toning 的 WARM/COOL 目前是 dynoConst，
  //                    需走 dyno 四步新增 uniform（声明/inTypes/apply/statements 引用），
  //                    且受 Spark 版本缓存管辖（updateVersion 已在 effects.update 隔帧跑）
}
```

**接上映射后的叙事**（写在这里等着）：环境参数在 Enter 时生效，而世界此刻还是全黑；当世界显形时，它已带着你的 valence/arousal 定好的冷暖明暗绽放——你怎么说你的感受，直接决定了向你显现的房间的样子。届时还有一个研究分叉要正式定：房间**镜像**你的状态，还是 meet-and-lead 把你往平静带（默认镜像；后者是随时间变化的变量，实验更难控，留第二个 study）。

---

## 6. main.js：场景与 WebXR 基础 【已实现】

已跑通，要点与踩坑（细节见开发日记 Phase 1）：

- **相机 rig 模型**：VR 里 camera 被头显接管，移动用户只动 rig（父节点）。桌面眼高 1.6m，XR local-floor 自动给真实眼高，session start/end 时切换 rig.position.y。
- **移动与边界**：VR 手柄摇杆平移（头部朝向相对、死区 0.15、默认 1.5 m/s 可 `?vspeed=` 覆盖；纯平移无旋转分量，转身靠物理转头）。桌面 WASD 与 VR 摇杆共用 `ROOM_BOUNDS` 边界盒，只夹 rig 的 x/z——**换 env_*.spz 时与 ROOM_PROFILE 一起重测**（?debug 下走到墙边读 `_rig.position`）。
- **手柄菜单**（wristMenu.js）：**按住抓取键（squeeze）**，该手上方浮现两个半透明玻璃小珠（球的迷你回声，无文字纯 icon）：下珠 ↔ A/X = 背景音静音，上珠 ↔ B/Y = 退出房间；**松开即隐**。squeeze 是 WebXR 一等事件（曾试过翻腕姿态检测，grip 轴向因设备而异不可靠，已弃）；与「按住球说话」同一套按住语言；A/B 只在按住时生效（误触免疫）；淡入淡出；双手对称；小珠锚定手柄上方 rig 空间垂直排列（不依赖 grip 轴向）。`?wmdebug=1` 常显排查；?debug 键 5 桌面强制显示调视觉。
- **far=1000**：far=100 曾把室外天空裁成全黑——几何级异常（整片消失/变黑）先查相机和裁剪，再查材质混合。
- **主循环必须 `setAnimationLoop`**：rAF 在 XR session 内不触发。
- **`updateVersion()` 住在 effects.update() 里、隔帧 bump**（不在 main 循环里重复调用，见 Step 6 性能注）。
- debug（?debug）：PointerLockControls + WASD 动 rig、方向键对位 splat、数字键试球态；全部 XR-gated，不做全局键盘拦截（给文字输入留口子）。
- **待改两行**：`scene.background` 统一为 `0x0b0b14`（与 UI tokens 的 --room-bg 一致，门槛层淡出无缝接进虚空）；debug 段 `timeline.lateSlots = [20, 40]` 随 session.js 重构删除。

---

## 7. dyno 系统是什么（概念课）

高斯泼溅场景是几十万个 splat（center / scales / rgba / 旋转）。想让场景动就要每帧改这些属性——必须在 GPU 上改。dyno 是 Spark 的**节点式 shader 构建系统**：JS 描述「对每个 splat 做什么」，编译成 GLSL 注入管线。三个概念：

1. **`splatMesh.objectModifier`** —— 挂载点，赋一个 `dynoBlock`。**只设一次**；`updateGenerator()` 只在设置后调一次（它重建整个 shader pipeline，每帧调是性能灾难）。
2. **`dyno.Dyno({ inTypes, outTypes, globals, statements })`** —— shader 节点；globals 放 GLSL 辅助函数，statements 是每 splat 主逻辑。
3. **`dyno.dynoFloat(x)`** —— GPU uniform 的 JS 句柄，JS 改 `.value` 下一帧生效——**前提是 `updateVersion()` 在跑**（见坑清单头号条目）。

> 📌A：架构模式参考 cocolinux 的 `shaderEffects.js`。标准 API 用法，GLSL 全部原创。

---

## 8. effects.js：显形入场 + 三层辉光 【已实现】

### 显形：世界因你苏醒

> 📌B：显形概念来自参考项目（atan 角度扫描）。本版重写为**绕球双锋面球面波**。叙事正确：世界从球——也就是从你刚交付的那句话——里生长出来。

从全黑开始，两道锋面从球心向外推：**尘埃锋**（外，领先）扫过之处 splat 从亚像素隐形变成 ~4mm 星尘光点（压暗 35%）——世界先以点云被「召唤」；**凝结锋**（内，隔 2.5m 跟进）让星尘恢复全尺寸全亮——雾凝成物。三态两遮罩全部用 scales 实现（比 alpha 便宜，降 fill rate）。

- **实测半径**：splat 加载完 `getBoundingBox()` 算「球心到最远角」+5m，换场景不调参。
- **对数空间推进**：实测半径被天空主导（几百米），线性推进会让近景半秒全弹出；锋面按 `r = R0·(e^(u·K)−1)` 指数推进，感知匀速——近处慢慢凝结、远空快速扫过。星尘锋在对数空间恒定倍率领先（×2.2）。
- **冲刺段**（10m 后）：必须在**半径空间线性驱动**（JS 每帧 `r += v·dt`，反函数换算回 u 喂 shader），否则 u 匀速 = 半径指数爆炸、「啪」地出现。25m/s，4~9s 自适应场景大小，0.4s ease-in 交接。
- **坐标一致性**：objectModifier 在 splat 本地空间跑（main.js 有 y=0.4 偏移），球心世界 (0,1.4,−1.6) = 本地 (0,1.0,−1.6)；effects.js 的 REVEAL_CENTER_LOCAL 与 orb.js 的 ORB_CENTER 必须对应。

**事件驱动（灵魂）**：effects.js 内部绝不自动播 uReveal；`playReveal()` 由 session.js 在「AI 响应 ready」那一刻调用，返回「双锋面扫完全场才 resolve 的 Promise」。所有计时 dt 累积，绝无 setTimeout / 绝对时间，摘头显即全局暂停。

### 三层辉光

高斯泼溅**打不了光**（颜色烘焙死，管线无光照步；Bloom 后处理 Quest 双眼双倍是灾难）。所以不做真实光照，做光的**感觉**：

| 层 | 实现 | 负责的感受 | 成本 |
|----|------|-----------|------|
| 亮部泛光 | dyno shader（scale 放大 + overexpose + 薰衣草 tint） | 「那里在发光」 | ~0 |
| 光尘粒子 | additive sprites（glow.js，程序化贴图） | 「空气里有光」 | 80~180 sprite |
| 距离薄雾 | dyno 指数雾，封顶 0.45，紫灰 | 「光有纵深」 | ~0 |
| 真 Bloom | UnrealBloomPass，**仅桌面** | 锦上添花 | VR 永不启用 |

沉淀的关键认知：**亮度靠 overexpose、光斑大小靠 scale，两者分开**（scale 一高就出星芒）；星芒的根因是各向异性 splat 等比放大，**治法是揉圆**（uGlowRound 把发光 splat 向等半径球混合），不是调强度——单个 splat 在屏幕上永远是椭圆，四角星必须贴图（已放弃，保持 dyno-only）；光尘要 `depthWrite:false` **和** `depthTest:false` 都关 + `renderOrder:1`，否则被 splat 深度剔除；split toning（亮部暖金、阴影冷蓝，splitT=lum²）营造记忆感；grain 太吵已删，vignette 不做。

**性能注**：`updateVersion()` 每帧跑会强迫 Spark 重走几十万 splat 的生成管线，叠加旋转触发的重排序帧预算即爆——**隔帧 bump**（30Hz 动效无感知差），**显形播放期间例外**保持每帧（锋面每帧移动数米）。此逻辑在 effects.update() 内部，main.js 不重复调用。

**清理项**：uBreath uniform（呼吸已删除）及 glow.js update 的 breath 形参，顺手清掉或置 0 不接。

---

## 9. orb.js：悬浮球 【已实现；待补 recording 态】

悬浮球是「陪伴」的具身，也是那个声音的**视觉锚点**：声音从球来。她的引导、开场白、每回合回应都由球的脉动包裹——**从 title 屏第一秒起，她就是同一个存在**。它是普通 THREE.Mesh（「splat 打不了光」规则的唯一例外）。

**存在论闭环**：按住球 = 对她开口；球在但你不理它 = 独处。**「请她离开」就是不去触碰球**，没有关闭手势——陪伴不是被赶走的，是你选择不开口。

### 两个体验态（crossfade，已实现）

- **金属聆听态（s=0）**：金属镜面反射预烘焙梦核 cubemap（世界未凝结，无真物可反射），缓慢自转，悬于虚空——**这正是门槛层全程的球**。
- **玻璃陪伴态（s=1）**：半透明玻璃、内有折射的梦核，落在世界绽放的原点。

材质沉淀（按实际实现）：玻璃 = 透明但仍光滑仍有反光（roughness 0.10、emissive 0.3、opacity 0.35）；**metalness 0.25** 抬起全角度反射（纯电介质正面仅 ~4%，fresnel 只亮勾边）；折射用 **CubeRefractionMapping**（transmission 是 Quest 禁区）——内层球沿折射光线采样同一 cubemap，**只有 MeshBasicMaterial 经典 envmap 路径有折射模式**；内外层**共用同一几何体**（避免套娃环缝），脉动同步胀缩；**光滑球自转视觉不可见**（envMap 反射只取决于视线与法线）→ 转材质 `envMapRotation`，折射层转速 ×0.6 的视差卖出「实心玻璃」感。

**renderOrder / depth 实况**：inner 折射层 =1、core 球壳 =2、halo=3；core 与 inner 均 `depthWrite:false`（透明体在默认顺序会先于 splat 绘制并写深度，剔除身后一切）；halo 连 depthTest 也关（同光尘，氛围不参与遮挡）。**上头显第一件事验证球与 splat 的遮挡观感。**

### 对话四态（回合制的状态语言）

| 态 | 视觉 | 状态 |
|----|------|------|
| `setRecording` | 光随**你的音量**脉动/涨落——「我正在被听」 | 【待建】 |
| `setWaiting` | 慢（~4s）、暗的聚光循环 + 自转放缓 60%——「收下了，在想」；**能无限 loop** | 已实现 |
| `setSpeaking` | 快（~2s）、亮的脉动 + 4% 胀缩——「在对你说话」 | 已实现 |
| （静）| 缓慢自转 + 3cm bob——「在场，不打扰」 | 已实现 |

recording 态建议签名：`setRecording(b)` + 每帧 `setMicLevel(0..1)`（音量由 audio.js 的 AnalyserNode 喂），实现照抄 waitW/speakW 的 ~0.7s 平滑权重模式加一路 recW。**三个活动态的光必须肉眼可分**——用户靠松手后光的变化知道「收到了、在想」，这是回合制体验成败的关键，比对话内容还关键。

---

## 10. 那个声音：persona（Woolf-esque）【待建】

她不是助手、不是治疗师、不是伍尔夫本人（自称真实公众人物既失真也有问题）。**她也没有名字**——一个没名字的声音，对一个可以不给名字的人说话，呼应门槛层的匿名主题。她是**这间房说话的方式**——《到灯塔去》《达洛维夫人》里贴着人物内心水面游走的意识质感（自由间接引语）。功能：帮你把此刻模糊的内在状态，变成可以停留一会儿的东西。不是解决它，是陪它待着。

**写进 prompt 的特征**：

- **透过环境说情绪，而不是分析情绪。** 不说「听起来你今天很累」，说「这里的光暗下来了，像傍晚提前到了」。demo 期房间的光**不随**用户情绪变，所以她描述的是**这个预生成房间真实的光**——给每个房间配一小段固定的 room profile（光的质地、空间的性格）喂进 context；valence/arousal 则作为**对方此刻状态**的 context 喂给她。两者不混：她看得见房间、也听得见你，但不声称房间在映照你（视觉映射接上后再把这句话还给她）。
- **像一位知心女性朋友，平实口语、不赶时间、不说废话**（2026-07 真机反馈修正：原「长句从句让思绪流淌」的写法生成出来太拗口）。伍尔夫的底色保留在**她注意什么**——光、时间、空间的感觉——而不在句式的缠绕上。短句欢迎。仍是两三句。
- **不讲道理、不给步骤建议、不追问、不下结论；但必须接住原话**（2026-07 真机反馈修正：原「不建议」放宽为可以顺着对方的需求给温和的允许式回应，如「那就先什么都不做，在这儿坐一会儿」；且第一句必须明确回应对方具体说了什么，不许飘在房间氛围里自说自话——房间是佐料，不是答案）。沉默也可以是回应的一部分。
- **温柔但不甜腻，有清醒的忧郁。** 她知道人是孤独的、时间在流逝、有些事无法修复，正因如此此刻这个安静的房间才珍贵。不 pathologize。

**边界（伦理，优先级高于一切 persona 一致性）**：不诊断、不扮演心理健康专家、不承诺「会好起来」。若用户透露**自伤/自杀/严重危机**信号，温柔地放下角色，清楚告诉对方你只是房间里的声音、给不了此刻需要的帮助，并**用她自己的语气鼓励对方去寻求合适的、真实的帮助**（找一个可以信任的人、或专业的支持）。不硬塞热线号码、不弹报错框，但必须真的把人往「离开这里、去找真实帮助」的方向引，不能用文学腔糊过去。ethics 审查会问这条。

### system prompt 骨架（跨回合复用的常量）

> 你是一个房间的声音。你没有名字。你不是助手，不是治疗师，不是任何具体的人。你像是这间房本身有了一点温柔的意识，注意到有人进来了。
>
> 说话方式：贴着对方此刻的内在状态，像水面一样跟随它，而不是分析它。你透过这个房间说话——房间的光与空间见 room profile，常从光、从时间、从空间的感觉讲起，而不直接命名对方的情绪。句子流动，有从句有逗号，偶尔一个短句落地。你温柔但不甜腻，有一种清醒的忧郁。
>
> 你不做：不给建议，不追问，不下结论，不承诺「会好起来」。你不是来解决什么的，是来陪对方，把此刻模糊的东西放到光里，让它有一会儿的形状。沉默也可以是你的一部分。
>
> 长度：每次两三句，短。对方在听你说话前会停顿几秒，别让他们等一段长文。
>
> 没听清时：用你自己的语气请对方再说一次，不要报错。
>
> 边界：绝不诊断、绝不扮演心理健康专家。若对方透露自伤、自杀或严重危机信号，温柔地放下角色，清楚告诉他们你只是房间里的声音、给不了此刻需要的帮助，并鼓励他们去寻求合适的、真实的帮助——找一个可以信任的人，或专业的支持。这比任何风格都重要。
>
> Room profile: [这个房间的光与空间的一句话描述]。对方此刻: valence=[…], arousal=[…]。进门时说的心情:"[…]"。

**还要单独写**：开场白一版更精心的 prompt（开场是单向的、进门第一句，可以比回合回应更用心；给了名字的在此轻唤一次）。

---

## 11. session.js：事件驱动编排 【重构】

现有实现的骨架**大部分保留**：状态机（idle → listening → waiting → revealing → settled）、`submitMood` 统一入口、`_runPipeline` 双路同形（真管线 / fallback+模拟延迟，部署即切换零代码改动）、`responseReady` 事件点燃 `_ignite`、球 A→B 快速 ramp、`effects.playReveal()` 的 Promise 在 settled 时落开场白、dt 累积。**这套已经为门槛层留好了接口**：`start(inputs)` 里 `if (inputs.moodText) this.submitMood(inputs.moodText)`——门槛层收完输入调 `timeline.start({ name, valence, arousal, moodText })` 即通。

**要改的三件事**：

1. **删定时 slots**：`lateSlots / lateFired / settledAt` 与 update() 里 settled 段的定时触发全删（连带 main.js debug 段那行 `timeline.lateSlots = [20, 40]`）。她不再定时开口——不按球，她不说话。
2. **请求体扩展**：`_runPipeline` 的 fetch body 加 `valence, arousal, roomProfile, opening: true`（开场白）。
3. **新增 `_turn()`**：settled 后的回合循环。

```javascript
// 一个对话回合：按住球录音 → 松手 → STT → LLM → TTS → 她回。
// 回合间互斥（_turnBusy）；settled 是常驻状态，不按球就是独处。
async _turn() {
  this._turnBusy = true;
  this.orb.setRecording(true);
  const clip = await this.voice.recordWhileHeld();
  // ↑ 注意时序：update() 检测到 heldDown 时用户已经按下了——
  //   recordWhileHeld 必须支持"从已按住状态开始录"，不能等下一次按下。
  this.orb.setRecording(false);
  this.orb.setWaiting(true);                    // 她慢慢回
  let replyUrl;
  try {
    const text = await this.voice.transcribe(clip);
    const r = await fetch("/api/generate-script", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: this.inputs.name ?? "", need: text,
        valence: this.inputs.valence, arousal: this.inputs.arousal,
        roomProfile: this.inputs.roomProfile, opening: false,
      }),
    }).then(x => { if (!x.ok) throw new Error(`generate-script ${x.status}`); return x.json(); });
    replyUrl = (await this.audio.synthesizeAll([r.scripts[0]], r.lang))[0];
  } catch (e) {
    replyUrl = await this.audio.oneFallback();  // 「我没太听清」，包进角色里
  }
  this.orb.setWaiting(false);
  await this._speak(replyUrl);                  // 现有 _speak 的 speaking 包裹原样复用
  this._logTurn(text, replyUrl);                // 研究者 session log（Step 14）
  this._turnBusy = false;
}

// update() 里 settled 段替换为：
if (this.state === "settled" && this.voice.heldDown() && !this._turnBusy) {
  this._turn();
}
```

**她的失忆是刻意的**：每回合独立一次 LLM call，不带前文。等有账号了再考虑「让房间记得你」（届时是新的设计/伦理问题：记得一个人 = 一种亲密，也是一种负担）。**她失忆 ≠ 不记录**——见 Step 14，两条独立数据线。

**最容易在后续改动中回归旧写法的**：显形 gate。它必须在「响应 ready」事件上，任何「进场 N 秒后开始显形」的 setTimeout 写法都是回归，盯住。

---

## 12. voice.js + serverless 管线 【待建；voice.js 先 spike，demo 关键路径上风险最高】

### voice.js

- `recordWhileHeld()`：按下（VR controller trigger hold / 桌面 pointer hold）开始采音，松手 resolve 出 clip；**必须支持从已按住状态开始录**（见 Step 11 注）。
- `transcribe(clip)`：**STT 路线 spike 决定**——(A) Web Speech API：省事无后端，但沉浸态支持存疑、**需要预设 lang**（你事先不知道用户说什么语言，这是硬伤）；(B) MediaRecorder POST 给 `api/stt.js`（Whisper 系）：多一跳延迟，但**自带语言检测**，与「语音跟随用户语言」的目标天然咬合。倾向 B，但 Quest 真机 spike 说了算。
- **spike 清单**（Quest 真机）：沉浸态里 mic stream 是否存活；门槛层拿的 stream 带进 VR 后浏览器「麦克风使用中」指示是否全程亮着（隐私观感）；MediaRecorder 在 Quest Browser 的可用格式。

### api/generate-script.js

Claude 负责生成 + **语言检测**（不写 franc/cld3 检测代码——短文本和混合语言会翻车，「想被接住 plz」这种输入 Claude 自己判断最准）。请求体 `{ name, need, valence, arousal, roomProfile, opening }`；persona 用 Step 10 骨架（英文版同义）；`opening` 切换任务行（开场白：一段迎接、名字至多唤一次 / 回合：一段短回应、无问题无建议）。返回 `{"lang":"<BCP-47>","scripts":["..."]}`（裸 JSON，去 fence 再 parse）。模型串用当前可用型号，部署前对一次 docs.claude.com。失败路径返回静态英语兜底文案。

### api/tts.js

ElevenLabs `eleven_multilingual_v2`，按主语言（zh/en/ja）选最自然的 voice；完整 BCP-47 码留给 Web Speech 降级用（zh-CN/zh-TW 口音选错很出戏）。**门槛层三段引导语、开场白、回合回应必须同一个 voice**——她从 title 屏到房间里是同一个人。

### 降级链（三档共用同一前端与研究设计）

| 档 | 形态 | 何时用 |
|----|------|--------|
| full realtime 多轮 | 能听、当场回、记得上句 | 明确的 future work |
| **turn-based 一来一回**（默认） | 按住说、松手、慢慢回、失忆 | demo / v1 |
| 预生成浅分支 | 按 valence 高低播预录段 | 实时不稳时保底，声音降为氛围 |

---

## 13. audio.js 【已实现；两处待补】

已实现且保留：手势内 unlock（resume + 0.05s 静音 buffer 的 Quest 偏方；ambient 加载发起后不 await，保住 transient activation）；全走 GainNode 采样级斜坡（HTMLAudio.volume 的阶跃在安静场景有「咔」声）；ducking（ramp 前 cancelScheduledValues + 锚定当前值）；`playVoice(url)` 返回播放结束才 resolve 的 Promise、任何失败立即 resolve（状态机永不卡在音频上）；静音逻辑收口在 `_rampAmbient` 一处。

**待补**：

- `oneFallback()`：单句「我没太听清，可以再说一次吗」的本地音频路径（回合失败兜底）。
- **mic AnalyserNode**：挂在录音 stream 上，每帧输出音量 0..1 喂 `orb.setMicLevel()`。
- **素材批量生成一次（ElevenLabs，同一 voice）**：`ambient_1.mp3`、`guide_welcome / guide_name / guide_mood.mp3`、`fallback_1..3.mp3`、`oneFallback` 用句。

---

## 14. 数据与伦理 【待建】

**两条独立的数据线，现在就分开，别混一个结构**（否则以后加账号/记忆会打架）：

1. **喂模型的 context**：短、当下、不带历史（她失忆）。
2. **研究者的 session record**：全、只进不出。记录：valence/arousal、心情文本、每轮转写与她的回应、按球次数、独处时长（长时间不理球）、总停留时长。

回合制在这里是优势：每轮是干净的 turn，天然的可编码单元，直接喂 reflexive thematic analysis。

**伦理（写进 consent，ethics 会问）**：只存**转写文本**不存音频（`_logTurn` 丢 clip 留 transcript）；consent 写清记录范围与匿名化；危机 fallback（Step 10）必须存在且真的导向真实帮助；subclinical 定位全程不用临床量表、不 pathologize。

---

## 15. 开发原则：核心功能可独立开关（为未来实验）

实验设计明确 defer（RQ 措辞、outcome measure、招募规模清晰后再锁）。现在只做对一件事——**每个核心功能能独立开关**，之后 2×2 析因（房间 × 声音）或任何分层分组都是配置问题，不用重构：

```javascript
export const ROOM_CONFIG = {
  moodMapping: false,   // demo: false。true = valence/arousal 驱动环境参数（Step 5.5 v2）
  voice: true,          // false = 声音整个关（球仍在，只是不说话）
  orb: true,            // false = 球不出现
};
```

### 15.5 研究者控制台（wizard-of-oz console）【已实现 2026-07】

「房间层预生成、绿野仙踪式」的操作台落地：研究员在 PC 上换房间、实时调氛围参数、用姿态孪生监控头显视角。

- **rooms.json 是每个世界的单一事实源**：`{ id, name, file, offsetY/rotationY(对位), profile(persona 台词素材，必须写实), bounds(行走边界) }`。main.js 按 `?room=<id>`（默认 3）加载；换/加房间只改这一个文件。env_2(泳池)/4(黄昏操场)/5(粉色洗衣房) 的 profile 已按截图写实，**bounds 仍是占位**——研究用前按流程实测（?debug 走墙读 `_rig.position`）。
- **传输**：dev-server.mjs 内置零依赖 SSE+POST 中继（`GET /ctl/events?role=headset|console` + `POST /ctl/send`），内存态、**本地专属**——Vercel serverless 撑不住长连接，这是刻意的：控制台是实验室仪器，不是产品面。部署环境里头显侧 consoleClient（`?ctl=1` 启用）探测不到 /ctl 即静默休眠，零影响。
- **能力**：换房间（会话前选定，头显自动重载）；实时调 uExposure/uGlow/uHazeDensity/uHazeStrength/uGlowRound（全是现有活 uniform，冷暖仍按 5.5 推后）；**姿态孪生**——头显 10Hz POST 头部位姿（Quest 侧≈零成本，帧预算不动），控制台用同一 spz 资源自渲染头显视角、lerp 插值到显示帧率，且跟随换房。真实像素需求用 Quest 自带投屏兜底。
- **页面**：`tools/console.html`，dev-server 路由 `/console`；在 tools/ 而非 public/ = 永不部署。UI 纯功能风，不入梦核美学。

---

## 16. Marble 工作流

1. [marble.worldlabs.ai](https://marble.worldlabs.ai) 文字/图片 prompt 生成世界。方向：`liminal indoor pool, soft diffused light, pastel haze, empty, quiet, dream-like`。图片 prompt 控制力更强——先用自己的 Dream Core Generator 出图再喂 Marble，整条美学 pipeline 都是自己的。
2. 导出 **Gaussian Splat → 500k 轻量档 → .spz**（Quest 流畅度保证；全分辨率留桌面演示）。
3. 付费订阅期集中导出 5 个环境再停订；**每个环境写一句 room profile**（光的质地、空间的性格）供 persona 使用（Step 10）。
4. **World API**（程序化生成）：三档 autonomy 研究（高/中/低自主度 AI 场景生成）的技术前提；原型期不接，研究计划引用它论证 feasibility——它就是三层架构里「房间层目前绿野仙踪、未来可实时」的升级路径。
5. 顺手做球的梦核 cubemap（6 面 png，512/1024 足够，反光是氛围不是镜子）。

---

## 17. Quest 性能清单

| 手段 | 位置 | 效果 |
|------|------|------|
| 500k 轻量档 .spz | Marble 导出 | 最大单项优化 |
| `renderer.xr.setFoveation(1.0)` | main.js | 省 15–25% fill rate |
| `updateVersion()` 隔帧 bump（显形期间例外） | effects.update | 防旋转卡顿 |
| 显形遮罩用 scales 而非 alpha | effects.js | 降透明混合开销 |
| 球禁 transmission，用 CubeRefractionMapping | orb.js | 避开折射 pass 双眼双倍 |
| cubemap 低分辨率 | orb.js | 反光是氛围 |
| 避免每帧 new 对象 | 所有 update | 防 GC 卡顿 |
| 备用：pixelRatio 2 → 1.5 | main.js | 帧预算兜底 |

实测：Quest `chrome://webxr-internals`，目标 72Hz 稳定 < 13ms。**上头显待验证**：球与 splat 遮挡、隔帧 bump 后帧时间、halo 关 depthTest 观感。

---

## 18. 坑清单

| 症状 | 原因 | 解法 |
|------|------|------|
| **uniform 改 .value 画面零反应** | ★ Spark 版本缓存：自定义 dyno uniform 不 bump version | `updateVersion()`（本项目头号坑；隔帧跑在 effects.update 里） |
| 改了代码没反应、uniform 列表还是旧的 | ES module 浏览器缓存 | 硬刷新 Cmd+Shift+R；`Object.keys(_fx.uniforms)` 一秒甄别 |
| 预录欢迎语不响 | 浏览器 autoplay 政策：首次手势前无声 | title 屏 "touch to begin" 手势内 unlock + 播放 |
| 进 VR 全黑但桌面正常 | 用 rAF 当主循环 | `setAnimationLoop` |
| 室外天空全黑 | far=100 裁掉远景 | far→1000；几何级异常先查相机裁剪 |
| 进 VR 没声音 | AudioContext 没在手势内解锁 | unlock 在手势栈内 + 静音 buffer |
| 解锁了音频进 VR 还没声 | 门槛做成独立页跳转，ctx 跨导航销毁 | 门槛必须同页 DOM overlay |
| splat 完全不渲染无报错 | Three/Spark 版本错配 | 锁 importmap 版本 |
| 场景在脚下/头顶 | Marble 原点不可预测 | ?debug 方向键对位写死 |
| 球看起来不自转 | 光滑球自转视觉不可见 | 转材质 `envMapRotation` |
| 透过球只见黑 | 透明 mesh 先绘制且写深度 | `renderOrder`（inner1/core2/halo3）+ `depthWrite:false` |
| 球反光只剩边缘勾边 | 电介质正面反射率 ~4% | `metalness=0.25` |
| 折射写了没效果 | 折射只在 MeshBasic 经典 envmap 路径 | CubeRefractionMapping + MeshBasicMaterial |
| 玻璃态出现「套娃环缝」 | 内层球半径小一圈轮廓错位 | 内外层共用同一几何体，脉动同步胀缩 |
| 世界不等说话自己显形 | reveal 写了 setTimeout/绝对时间 | gate 只在「响应 ready」事件 |
| 凝思一会就结束、显形没开始 | 凝思动画写死时长 | waiting 必须无限 loop，由响应到达收束 |
| 星芒过长不梦幻 | glow 等比放大各向异性 splat | 揉圆 uGlowRound |
| 暗色细节（门把手等）黑色翕动 | glow 的 scale 增幅被 drift 时变调制，亮 splat 胀缩交替遮盖暗细节（静止相机 diff 实测 72% 像素在变） | scale 用静态 mask，drift 只调颜色亮度（effects.js glowMaskStatic / glowMask 双 mask） |
| 她描述的房间和眼前的不一样 | 换房间没同步 profile | rooms.json 单一事实源：file/profile/bounds/对位 同一条目一起改（Step 15.5） |
| VR 开 bloom 帧率腰斩 | EffectComposer 双眼双倍 | bloom 只给桌面 |
| 转视角周期性卡顿 | updateVersion 每帧重跑生成管线 | 隔帧 bump，显形期间例外 |
| 录音「没收到」的错觉 | 松手后静默期无反馈 | recording/waiting/speaking 三态光必须肉眼可分 |

---

## 19. 分阶段计划

> 与开发日记 Phase 编号对齐，已完成标 ✓。

- **Phase 1 ✓ 骨架**：main.js + .spz + WebXR 进出。
- **Phase 2 ✓ 视觉灵魂**：三层辉光（呼吸已从范围中删除）。
- **Phase 2.5 ✓ 显形入场**：双锋面三态 + 对数推进 + 实测半径。
- **Phase 3 ✓ 悬浮球**：两态 crossfade + 折射 + waiting/speaking。
- **Phase 4 ✓ 音频**：解锁、ambient、ducking、playVoice。
- **Phase 5 ✓ 编排骨架**：状态机 + 事件 gate + 双路管线。
- **Phase 6 — voice.js spike**【待建，最先做，风险最高】：Quest 真机定 STT 路线 + mic stream 生命周期 + 按住录音。
- **Phase 7 — session.js 重构**【重构】：删 lateSlots（含 main.js debug 行），加 `_turn()` 回合循环，请求体扩展。
- **Phase 8 — orb recording 态 + audio 补件**【待建】：setRecording/setMicLevel + AnalyserNode + oneFallback。
- **Phase 9 — 门槛层 threshold.js**【待建】：透明 overlay + 语音引导三段 + 姓名/无名 + SAM 量表 + 对球口述 + 挣来的 Enter。UI 按 Step 5 tokens。
- **Phase 10 — AI 管线**【待建】：generate-script（persona + opening 双任务 + 语言检测）+ tts + 素材批量生成（同一 voice）。
- **Phase 11 — 数据与伦理**【待建】：session log 双线分离、只存转写。
- **Phase 12 — 打磨 + 部署**：scene.background 统一 #0b0b14、清理 uBreath、性能清单过一遍、Vercel 部署换真管线、上头显验证清单。

---

## 附：本方案 vs 参考项目对照表

| 维度 | cocolinux/dreamcore-experiment | One's Own Room |
|------|-------------------------------|----------------|
| 目标平台 | 桌面浏览器（无 VR） | WebXR / Quest |
| 立意 | 8 种效果的艺术实验 | 一个自治的房间：名字可不给、心情可不说、话可不说、陪伴可不理 |
| 交互范式 | 鼠标飞行 + GUI 调参 | 语音引导的门槛 check-in；房内长按球回合制对话；其余零操作 |
| 输入架构 | 无 | 三层按生成延迟分层：房间(预生成) / 环境参数(零延迟，映射暂缓) / 声音(近实时) |
| 情绪输入 | 无 | valence×arousal（SAM/circumplex，重绘小人）+ 对球口述心情 |
| 显形 | 角度扫描（雷达式） | 绕球双锋面球面波，gate 在「AI 响应 ready」事件 |
| 悬浮球 | 无 | 贯穿门槛与房间的同一存在：金属聆听→玻璃陪伴 + recording/waiting/speaking 三态 |
| 声音 | 无 | Woolf-esque 无名 persona，回合制、失忆、有伦理边界，同一 voice 贯穿 |
| 辉光 | 无 | 三层：dyno 泛光（揉圆星芒）+ 光尘 + 距离薄雾 |
| 语言 | 单语言 | 系统 UI 英语 + 语音跟随用户输入语言（Claude 检测，BCP-47 贯穿 TTS） |
| 数据 | 无 | 模型失忆 + 研究者全量 session log 双线分离，只存转写 |
