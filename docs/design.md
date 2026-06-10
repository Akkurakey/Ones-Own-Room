# AI Dreamcore VR Spa — Spark + Three.js + WebXR 实现方案（学习版）

> 这一版替换之前的 A-Frame 方案。技术栈：Three.js（场景与 WebXR）+ Spark（高斯泼溅渲染与 dyno shader）+ Marble（环境生成）+ Claude / ElevenLabs（个性化语音）。
>
> 文档定位：既是实现方案，也是学习材料。每段代码后面都有「这段在做什么」的解释，所有借鉴别人思路的地方都用 📌 标注出处。

---

## 0. 借鉴标注总说明（先读这个）

本方案中所有代码都是为你的项目**重新写的**，没有复制 cocolinux0101/dreamcore-experiment 仓库的代码。但有三处**思路层面的借鉴**，在正文里会再次标注：

| 编号 | 借鉴内容 | 来源 | 借鉴的是什么 / 我们改了什么 |
|------|---------|------|---------------------------|
| 📌A | 用 Spark 的 `dyno` 系统给每个 splat 写 GPU 修改器 | cocolinux 的 `shaderEffects.js`（其本身改编自 Spark 官方示例） | 借鉴的是「用 objectModifier + dynoBlock 注入 GLSL」这个**架构模式**。这是 Spark 的公开 API 用法，具体效果代码全部重写 |
| 📌B | 「空间呼吸」效果 | cocolinux 的 `breathAnimation`（Deep Meditation 效果） | 借鉴的是「让点云随时间周期性胀缩、模拟呼吸」这个**概念**。他的实现是 ~4.2 秒固定周期 + 旋转耦合；我们的实现换成可配置的呼吸节律（默认 6 秒，可改 4-7-8），数学公式不同，且去掉了旋转（对疗愈场景太晃） |
| 📌C | 「场景从虚无中显形」入场 | cocolinux 的 `Magic` 效果 | 借鉴的是「入场时 splat 从 scale≈0 渐变显形」这个**概念**。他的实现是 atan 角度扫描（像雷达扫一圈）；我们的实现改成**从用户脚下向外的球面波显形**，更安静、更符合「空间为你苏醒」的叙事 |

另外两处属于公共领域的标准做法，不算借鉴某个人：Web Audio `AnalyserNode` 做音频分析（MDN 标准用法）、`renderer.xr` 的 WebXR 设置（Three.js 官方文档用法）。

原仓库是 MIT 协议，即使直接用他的代码也合法（保留版权声明即可），但既然你要原创 + 学习，我们走重写路线。

---

## 1. 为什么换到这套技术栈（决策回顾）

| 维度 | A-Frame + quadjr（旧方案） | Spark + Three.js（本方案） |
|------|---------------------------|---------------------------|
| WebXR 接入 | 几乎白送（一个组件） | 需要自己写 ~30 行（本文 Step 2 全给出） |
| 逐 splat shader 控制 | 几乎没有 | dyno 系统，完全控制 center / scales / rgba |
| 文件格式 | `.splat`（大） | `.spz`（压缩，Marble 原生导出） |
| 流式加载 | 无 | Spark 2.0 支持 LOD 流式加载 |
| 与 Marble 生态 | 无关联 | 同一家公司，官方推荐渲染器 |

核心判断：你的项目卖点是**视觉质感本身就是干预手段**（呼吸的空间、梦境般的显形）。这些只有 dyno 级别的控制做得出来，所以多写 30 行 WebXR 样板是值得的交换。

---

## 2. 项目结构

```
dreamcore-spa/
├── public/
│   ├── index.html              # 入口：importmap + 进入 VR 按钮
│   ├── onboarding.html         # 用户偏好收集（英语 UI，输入语言自由）
│   └── resources/
│       ├── worlds/
│       │   ├── env_1.spz       # Marble 导出，选 500k 轻量档
│       │   ├── env_2.spz
│       │   └── env_3.spz
│       └── audio/
│           └── ambient_1.mp3
├── js/
│   ├── main.js                 # 场景、WebXR、主循环
│   ├── effects.js              # dyno shader：呼吸 + 显形 + 辉光/薄雾（本文核心）
│   ├── glow.js                 # 加法混合光尘粒子层
│   ├── session.js              # 时间轴：voice slots、环境切换、淡入淡出
│   └── audio.js                # 音频管理：解锁、ambient、语音播放
├── api/
│   ├── generate-script.js      # Claude 生成脚本（本版重写：跟随用户输入语言）
│   └── tts.js                  # ElevenLabs TTS（多语言模型 + 语言码选声）
└── vercel.json
```

onboarding 页面结构沿用上一版（界面文案全部改为英语），`generate-script.js` 和 `tts.js` 因为加入语言跟随逻辑，本文 Step 8 给出新版完整代码。

---

## 3. Step 1 — index.html：importmap 与入口

```html
<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Dreamcore Spa</title>
  <style>
    body { margin: 0; overflow: hidden; background: #000; }
    #vr-button {
      position: fixed; bottom: 28px; left: 50%;
      transform: translateX(-50%);
      padding: 14px 36px;
      background: rgba(107, 72, 200, 0.85);
      color: #fff; border: none; border-radius: 28px;
      font-size: 1rem; letter-spacing: 0.06em;
      cursor: pointer; z-index: 10;
      backdrop-filter: blur(8px);
    }
    #vr-button:disabled { opacity: 0.4; cursor: default; }
  </style>
</head>
<body>
  <button id="vr-button" disabled>Loading…</button>

  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.178.0/build/three.module.js",
      "@sparkjsdev/spark": "https://sparkjs.dev/releases/spark/0.1.9/spark.module.js"
    }
  }
  </script>

  <script type="module" src="./js/main.js"></script>
</body>
</html>
```

**这段在做什么：**

- `importmap` 是浏览器原生功能，让你在没有打包工具（Webpack/Vite）的情况下用 `import * as THREE from "three"` 这种裸模块名。浏览器看到 `"three"` 就去 importmap 里查实际 URL。这就是为什么整个项目不需要 build step，`npx serve` 就能跑。
- Spark 的版本号锁死在 `0.1.9`。**Three.js 和 Spark 的版本要配套**——Spark 内部依赖 Three.js 的渲染管线，大版本错配会出现 splat 不渲染的玄学问题。升级时两个一起升，先看 Spark 的 release notes 写支持哪个 Three 版本。
- 自定义 VR 按钮而不用 Three.js 自带的 `VRButton.js`，是因为我们要在按钮点击时做一件额外的事：**解锁音频**（Step 6 详述）。浏览器规定 AudioContext 必须由用户手势启动，这次点击是我们唯一保证有的手势。
- **系统语言约定**：所有面向用户的界面文案（按钮、onboarding 表单、提示）统一用英语；用户在表单里输入的自由文本可以是任何语言，AI 生成的语音脚本会跟随用户的输入语言（Step 8 详述）。两层分离：系统说英语，体验内容说用户的语言。

---

## 4. Step 2 — main.js：场景与 WebXR 基础

这是整个项目的骨架。WebXR 部分是 Three.js 官方标准做法（非借鉴某个项目）。

```javascript
// js/main.js
import * as THREE from "three";
import { SplatMesh } from "@sparkjsdev/spark";
import { setupEffects } from "./effects.js";
import { SessionTimeline } from "./session.js";
import { AudioManager } from "./audio.js";

// ---------- 1. 渲染器 ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;                 // ★ 开启 WebXR
renderer.xr.setFoveation(1.0);              // ★ Quest 性能：边缘降分辨率
document.body.appendChild(renderer.domElement);

// ---------- 2. 场景与相机 rig ----------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x050510);

const camera = new THREE.PerspectiveCamera(
  70, window.innerWidth / window.innerHeight, 0.05, 100
);

// rig：包住相机的空 Group。VR 里相机位置被头显接管，
// 你想"移动用户"时移动的是 rig，不是 camera。
const rig = new THREE.Group();
rig.position.set(0, 0, 0);
rig.add(camera);
scene.add(rig);

// ---------- 3. 加载 Marble 导出的 .spz ----------
const splat = new SplatMesh({ url: "./resources/worlds/env_1.spz" });
splat.position.set(0, 0, 0);
scene.add(splat);

// Marble 导出的世界坐标系通常和 Three.js 一致（Y-up），
// 但每个场景的"地面高度"不一定在 y=0。
// 桌面模式下先用下面的调试快捷键找对位置，再写死。
window.addEventListener("keydown", (e) => {
  const step = e.shiftKey ? 0.5 : 0.1;
  if (e.key === "ArrowUp")    splat.position.y -= step;
  if (e.key === "ArrowDown")  splat.position.y += step;
  if (e.key === "r")          splat.rotation.y += Math.PI / 12;
  console.log("splat pos:", splat.position, "rot:", splat.rotation);
});

// ---------- 4. 效果 / 时间轴 / 音频 ----------
const audio = new AudioManager();
const effects = setupEffects(splat);          // Step 4–5：dyno shader
const timeline = new SessionTimeline({        // Step 6：体验编排
  scene, camera, splat, audio, effects
});

// ---------- 5. 进入 VR 按钮 ----------
const btn = document.getElementById("vr-button");

navigator.xr?.isSessionSupported("immersive-vr").then((ok) => {
  btn.disabled = false;
  btn.textContent = ok ? "Enter the Space" : "Experience in Browser";
  btn.onclick = async () => {
    await audio.unlock();                     // ★ 用户手势内解锁音频
    if (ok) {
      const session = await navigator.xr.requestSession("immersive-vr", {
        optionalFeatures: ["local-floor", "bounded-floor"]
      });
      renderer.xr.setSession(session);
    }
    btn.style.display = "none";
    timeline.start();                         // 体验时间轴从此刻起算
  };
});

// ---------- 6. 主循环 ----------
const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  const elapsed = clock.getElapsedTime();

  effects.update(elapsed);     // 把时间喂给 shader
  timeline.update(dt);         // 检查 voice slot / 环境切换
  splat.updateGenerator();     // 让 Spark 应用本帧的 dyno 参数

  renderer.render(scene, camera);
});

// 窗口缩放（仅桌面模式有意义，VR 里由头显决定分辨率）
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
```

**这段在做什么（逐块讲解）：**

**渲染器块。** `renderer.xr.enabled = true` 是 Three.js 进 VR 的总开关，开了之后渲染器才会响应 XR session。`setFoveation(1.0)` 是注视点渲染——VR 画面边缘人眼本来就看不清，让 GPU 在边缘渲染更低分辨率，Quest 上能省下可观的性能，对高斯泼溅这种 fill-rate 密集的渲染尤其有效。`setPixelRatio` 限制到 2 是防止高 DPI 手机上渲染 3x 分辨率把 GPU 烧穿。

**相机 rig 块。** 这是 WebXR 最重要的心智模型：**进入 VR 后，`camera` 的 position/rotation 每帧被头显追踪数据覆盖**，你手动设置无效。所以"用户在场景里的位置"由 rig（父节点）控制——想让用户出生在场景某处，移动 rig；想做整体漂移效果，动 rig。camera 留给头显。

**Splat 加载块。** `SplatMesh` 是 Spark 的核心类，构造时给 URL 就开始异步加载，它本身是个 `THREE.Object3D`，可以正常 add 到场景、设置 position/rotation。`.spz` 是压缩泼溅格式，Marble 原生导出（导出时选 500k splats 的轻量档，Quest 上的流畅度和文件大小都最优）。调试快捷键那几行是给你自己用的：Marble 每个场景的原点位置不可预测，先在桌面模式用方向键把地面对到脚下，把 console 打出的数值写死进代码，再上头显。

**进入 VR 块。** `navigator.xr.isSessionSupported` 先探测设备能力——Quest 浏览器返回 true，桌面 Chrome 返回 false（此时降级为普通 3D 页面，体验流程照常跑，只是不进头显）。`local-floor` reference space 让 y=0 自动对齐用户的真实地板高度，省去手动猜用户身高。**`audio.unlock()` 必须在这个 click handler 里调用**——这是整个项目最容易踩的坑：进了 VR 之后再想播声音，浏览器会拒绝，因为 VR 内的"凝视点击"在某些浏览器版本里不算合格的用户手势。

**主循环块。** 注意必须用 `renderer.setAnimationLoop(fn)` 而**不是** `requestAnimationFrame`——XR session 有自己独立的帧回调（头显是 72/90Hz，和显示器不同步），`requestAnimationFrame` 在 VR session 内根本不会触发，这是 WebXR 新手第一大坑。`splat.updateGenerator()` 每帧调用，让 Spark 把本帧更新过的 dyno 参数（时间、呼吸幅度等）同步进 GPU。

> 📌A 标注：`updateGenerator()` 每帧调用这个模式来自参考项目的 main.js（也是 Spark 官方示例的用法）。它属于 Spark 公开 API 的标准使用方式。

---

## 5. Step 3 — dyno 系统是什么（概念课，不写代码先）

在写效果之前，理解 dyno 的工作原理，不然后面的代码像咒语。

**问题背景**：高斯泼溅场景是几十万到几百万个"泼溅点"（splat），每个点有四个属性——`center`（位置）、`scales`(三轴大小)、`rgba`（颜色和透明度）、旋转。想让场景"动起来"，就要每帧修改这些属性。在 CPU 上逐点改几十万个点，帧率直接归零，所以必须在 GPU 上改——也就是写 shader。

**dyno 的角色**：直接手写 GLSL shader 又要处理 Spark 内部的渲染管线细节，很痛苦。dyno 是 Spark 提供的**节点式 shader 构建系统**：你用 JavaScript 描述"对每个 splat 做什么变换"，dyno 把它编译成 GLSL 注入到 Spark 的渲染管线里。三个关键概念：

1. **`splatMesh.objectModifier`** —— 挂载点。赋一个 `dynoBlock` 上去，Spark 渲染每个 splat 前都会先跑你的变换。
2. **`dyno.Dyno({ inTypes, outTypes, globals, statements })`** —— 一个 shader 节点。`globals` 里写 GLSL 辅助函数（会被原样注入 shader 顶部），`statements` 里写主逻辑（每个 splat 执行一次）。
3. **`dyno.dynoFloat(x)`** —— GPU uniform 的 JS 句柄。在 JS 里改 `myFloat.value = 0.5`，下一帧 GPU 里的值就变了。**这是 JS 世界和 GPU 世界之间唯一的桥**——时间、呼吸幅度、显形进度都靠它传进去。

> 📌A 标注：以上架构模式（objectModifier + dynoBlock + dynoFloat 桥接）的用法参考了 cocolinux0101/dreamcore-experiment 的 `shaderEffects.js`，该文件本身注明改编自 Spark 官方仓库示例。这是该 API 的标准用法，下面所有效果的 GLSL 代码均为本方案原创。

---

## 6. Step 4 — effects.js：空间呼吸效果

> 📌B 标注：「让整个空间呼吸」的概念来自参考项目的 `breathAnimation`（Deep Meditation 效果）。他的版本是固定 ~4.2 秒周期、含旋转耦合、以场景某点为锚。**我们的版本重新设计**：(1) 呼吸周期可配置，默认 6 秒（接近放松呼吸引导的 5 breaths/min 节律）；(2) 用 raised-cosine 曲线代替纯正弦，吸气和呼气之间有自然的停顿感；(3) 去掉旋转（旋转在 VR 里诱发晕动症，疗愈场景绝对禁止）；(4) 呼吸的"源点"设在用户位置而非场景原点。

```javascript
// js/effects.js
import { dyno } from "@sparkjsdev/spark";

export function setupEffects(splatMesh) {

  // ---- JS ↔ GPU 桥接 uniforms ----
  const uTime    = dyno.dynoFloat(0);  // 全局时间（秒）
  const uBreath  = dyno.dynoFloat(0);  // 呼吸相位 0..1（JS 算好喂进来）
  const uBreathAmp = dyno.dynoFloat(0.012); // 呼吸幅度（米）
  const uReveal  = dyno.dynoFloat(0);  // 显形进度 0..1（Step 5 用）

  splatMesh.objectModifier = dyno.dynoBlock(
    { gsplat: dyno.Gsplat },
    { gsplat: dyno.Gsplat },
    ({ gsplat }) => {

      const node = new dyno.Dyno({
        inTypes: {
          gsplat: dyno.Gsplat,
          t: "float", breath: "float", breathAmp: "float", reveal: "float"
        },
        outTypes: { gsplat: dyno.Gsplat },

        // ---- GLSL 辅助函数（注入 shader 顶部）----
        globals: () => [dyno.unindent(`

          // 呼吸位移：把点沿"离用户的径向方向"轻推
          // breath: 0..1 的呼吸相位（0=完全呼出, 1=吸满）
          // 距离衰减：近处的点动得多，远处的点几乎不动，
          // 这样呼吸感觉发生在"身边的空气里"而不是整个宇宙在抖
          vec3 breathe(vec3 p, float breath, float amp) {
            float d = length(p);
            float falloff = exp(-0.35 * d);      // 距离衰减系数
            vec3 dir = d > 0.001 ? p / d : vec3(0.0, 1.0, 0.0);
            return p + dir * breath * amp * falloff * d;
          }

        `)],

        // ---- 每个 splat 执行的主逻辑 ----
        statements: ({ inputs, outputs }) => dyno.unindentLines(`
          ${outputs.gsplat} = ${inputs.gsplat};

          vec3 pos = ${inputs.gsplat}.center;

          // 1) 呼吸位移
          pos = breathe(pos, ${inputs.breath}, ${inputs.breathAmp});
          ${outputs.gsplat}.center = pos;

          // 2) 呼吸的"光"：吸气时整个空间极轻微地变亮
          //    0.04 = 最多亮 4%，刚好在察觉阈值附近，
          //    用户说不出哪里变了，但能感到空间"活着"
          ${outputs.gsplat}.rgba.rgb *= 1.0 + 0.04 * ${inputs.breath};

          // 3) 显形遮罩（Step 5 详解，这里先占位）
          float d = length(${inputs.gsplat}.center);
          float edge = ${inputs.reveal} * 25.0;       // 显形波前半径
          float visible = smoothstep(edge, edge - 1.5, d);
          ${outputs.gsplat}.scales = mix(
            ${inputs.gsplat}.scales, vec3(0.0005), visible
          );
        `),
      });

      gsplat = node.apply({
        gsplat,
        t: uTime, breath: uBreath, breathAmp: uBreathAmp, reveal: uReveal
      }).gsplat;

      return { gsplat };
    }
  );

  splatMesh.updateGenerator();

  // ---- JS 侧：每帧计算呼吸相位 ----
  const BREATH_PERIOD = 6.0;   // 一次完整呼吸 6 秒 ≈ 10 次/分钟

  function update(elapsed) {
    uTime.value = elapsed;

    // raised-cosine：比纯 sin 在顶端和底端各多停留一点，
    // 像真实呼吸在吸满/呼尽时的自然停顿
    const phase = (elapsed % BREATH_PERIOD) / BREATH_PERIOD;  // 0..1
    const raw = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);    // 0..1..0
    uBreath.value = raw * raw * (3 - 2 * raw);                // smoothstep 再柔化
  }

  return {
    update,
    uniforms: { uReveal, uBreathAmp }   // 交给 session.js 控制
  };
}
```

**这段在做什么（逐块讲解）：**

**uniforms 块。** 四个 `dynoFloat` 是这套系统的"遥控器"。注意一个设计决策：**呼吸相位在 JS 里算，GPU 只拿结果**。也可以把 `sin(t)` 写进 GLSL 让 GPU 自己算，但放在 JS 有两个好处——(1) 以后想把呼吸节律做成用户可调（4-7-8 模式、或跟随实测呼吸传感器）时，只改 JS 不用动 shader；(2) 其他系统（比如音频音量）想和呼吸同步时，JS 里有现成的相位值可读。

**`breathe()` 函数。** 三行核心数学：`length(p)` 算每个点离原点（≈用户位置）的距离；`exp(-0.35*d)` 是指数衰减——1 米外的点保留 70% 的呼吸幅度，5 米外只剩 17%，远景几乎静止；最后把点沿径向（`p/d` 是单位方向向量）推出去 `breath * amp * falloff * d` 米。乘以 `d` 是让位移正比于距离（近似均匀缩放的感觉），乘以 `falloff` 又把远处压回去——两者相乘的净效果是位移在 ~3 米处达到峰值后衰减，**呼吸发生在用户身边的一圈空间里**。

**rgba 那一行。** 这是个心理学小技巧：吸气时空间亮 4%。4% 在察觉阈值（just-noticeable difference）边缘，用户意识不到具体变化，但会感到空间是活的。这种 subliminal 的多通道耦合（位移 + 光）正是你研究里讲 functional aesthetic 可以引用的设计细节。

**JS 的 raised-cosine。** `0.5 - 0.5*cos()` 把锯齿状的 phase 变成平滑的 0→1→0 山形；再过一次 smoothstep（`raw*raw*(3-2*raw)`）让山顶和谷底更平——效果是吸满和呼尽时各有一小段"屏息"，比纯正弦的机械感自然得多。这是和参考项目实现差异最大的一处。

**幅度默认 0.012 米。** 12 毫米听起来很小，但 VR 里整个环境同步移动 12mm 是清晰可感的。**不要超过 0.03**——环境大幅运动而身体没动，前庭冲突会引发晕动症，疗愈应用里这是一票否决项。

---

## 7. Step 5 — 入场显形：空间为你苏醒

> 📌C 标注：「入场时场景从虚无中显形」的概念来自参考项目的 `Magic` 效果。他的实现是 `atan(x,z)` 角度扫描——像雷达光束扫一圈，扫到哪里哪里出现，并带高亮边缘。**我们的版本重新设计**为从用户位置向外扩散的**球面显形波**：体验开始时世界不存在，然后以用户为中心、一圈"存在的边界"缓慢向外推，世界在波前后方凝结成形。理由：角度扫描有方向性和速度感，偏"炫技"；球面波是各向同性的、安静的，且叙事上正确——**这个世界是从你出发生长出来的**，呼应 AI 个性化生成的概念，也呼应你 kagami→kami 那套去自我中心的哲学（空间不是被展示给你，而是因你而显现）。

显形的 GLSL 部分已经在 Step 4 的 statements 里（那三行"显形遮罩"），这里解释它的数学，然后给 JS 侧的驱动代码。

**GLSL 部分回顾与解释：**

```glsl
float d = length(center);                    // 点到用户的距离
float edge = reveal * 25.0;                  // 波前半径：reveal 0→1 时从 0 推到 25 米
float visible = smoothstep(edge, edge - 1.5, d);
scales = mix(originalScales, vec3(0.0005), visible);
```

- `smoothstep(edge, edge - 1.5, d)`：注意两个参数是**反着写的**（大值在前），所以输出也反转——`d` 比波前远时输出 1（点被压缩成 0.0005 米的尘埃，肉眼不可见），比波前近 1.5 米以上时输出 0（点恢复原始大小），中间 1.5 米是平滑过渡带。
- 用 `scales → 0.0005` 而不是 `rgba.a → 0` 来隐藏点，是泼溅渲染的实用技巧：把 scale 压到亚毫米级，点在屏幕上小于一个像素，等效不可见，而且**比改透明度便宜**——几十万个半透明大点的 alpha 混合是泼溅渲染最贵的操作之一，缩小尺寸直接降低了 fill rate。
- 过渡带里的点处于"半凝结"状态（尺寸介于尘埃和实体之间），视觉上像雾气固化成物质，这就是梦核感的来源，不需要任何额外特效。

**JS 侧驱动（写在 session.js 里，下一节整合）：**

```javascript
// 显形动画：用 ease-out 曲线把 uReveal 从 0 推到 1
// duration 建议 12–18 秒——足够慢，慢到用户会主动环顾四周
function playReveal(uReveal, duration = 15) {
  const start = performance.now();
  return new Promise((resolve) => {
    function step() {
      const t = Math.min((performance.now() - start) / (duration * 1000), 1);
      uReveal.value = 1 - Math.pow(1 - t, 3);   // cubic ease-out
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    }
    step();
  });
}
```

**这段在做什么：** cubic ease-out（`1-(1-t)³`）让波前一开始推进快（用户立刻看到身边的世界成形，不会以为黑屏卡死了），越往远处越慢（远景慢慢洇开）。包成 Promise 是为了让 session.js 能写 `await playReveal(...)` ——显形结束后再起算 voice slot 时间轴，体验编排代码会非常干净。

> 注意这里用 `requestAnimationFrame` 而主循环用 `setAnimationLoop`——rAF 在 VR session 里不触发是指**渲染回调**，但这种纯数值动画在部分浏览器里也会被暂停。更稳的做法是把 reveal 进度放进 `timeline.update(dt)` 里用 dt 累积（Step 6 的实现就是这样做的，上面这个独立函数版本仅用于理解逻辑）。

---

## 7.5 Step 5+ — 梦幻辉光（Dreamy Glow）

### 先讲一个反直觉的事实：高斯泼溅"打不了光"

在传统 Three.js 场景里，加辉光是放几个 `PointLight` 再挂一个 bloom 后处理。但这条路在泼溅场景里**根本走不通**，原因要从渲染原理理解：

1. **Splat 不响应 Three.js 灯光。** 普通 mesh 的材质有法线，shader 根据灯光方向算明暗；而每个 splat 的颜色是**拍摄/生成时烘焙死的**，Spark 的渲染管线里没有光照计算这一步。你往场景里加一万个 PointLight，splat 一个像素都不会变。
2. **Bloom 后处理在 Quest 上是性能灾难。** Three.js 的 `UnrealBloomPass` 要把整帧画面渲染到纹理、多次降采样模糊、再叠加回来——VR 是双眼双倍渲染，Quest 的移动 GPU 跑这套帧率直接腰斩。而且 `EffectComposer` 和 WebXR 的兼容本身就需要额外折腾。

所以"梦幻辉光"要换一种思路：**不做真实的光照模拟，做光的"感觉"**。三层叠出来，每层都是 Quest 能轻松负担的：

### 第一层：dyno 内的亮部泛光（核心层）

原理：人眼判断"这里在发光"的最强线索，是亮部颜色**向外溢出、且偏向某个色温**。我们在 shader 里识别每个 splat 的亮度，给亮的 splat 同时做三件事——轻微放大（光晕感）、提升亮度（过曝感）、向梦核色调偏移（薰衣草紫/桃粉的色温）。

在 `effects.js` 的 uniforms 区新增两个遥控器：

```javascript
const uGlow     = dyno.dynoFloat(0.5);   // 辉光强度 0..1
const uGlowTint = dyno.dynoFloat(0.0);   // 色调偏移量（保留给情绪联动）
```

在 `globals` 里新增 GLSL 辅助函数：

```glsl
// 感知亮度：人眼对绿色最敏感，所以三通道权重不同
// 这组系数是 Rec.709 标准亮度公式，图形学的公共知识
float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// 梦核辉光色：亮部溢出时偏向的颜色
// 薰衣草紫——dreamcore 色板的核心色相
const vec3 GLOW_TINT = vec3(0.78, 0.62, 0.95);
```

在 `statements` 里、呼吸位移之后新增：

```glsl
// ---- 梦幻辉光 ----
float lum = luminance(${outputs.gsplat}.rgba.rgb);

// glowMask: 只有亮度超过 0.55 的 splat 参与辉光，
// smoothstep 让参与程度随亮度平滑爬升（避免硬边界）
float glowMask = smoothstep(0.55, 0.9, lum) * ${inputs.glow};

// (1) 光晕：亮 splat 放大至最多 1.6 倍——
//     splat 本身是高斯衰减的软椭球，放大后边缘自然羽化，
//     这就是"免费的 bloom"：单个 splat 的形状天生就是光斑
${outputs.gsplat}.scales *= 1.0 + 0.6 * glowMask;

// (2) 过曝：亮部颜色推向 1.0 以上再被显示截断，产生"白芯"
${outputs.gsplat}.rgba.rgb *= 1.0 + 0.5 * glowMask;

// (3) 色温：溢出的光偏向梦核紫，混合比例随 glowMask 走
${outputs.gsplat}.rgba.rgb = mix(
  ${outputs.gsplat}.rgba.rgb, GLOW_TINT * (1.0 + lum), 0.35 * glowMask
);
```

（记得把 `glow: "float"` 加进 `inTypes`，`glow: uGlow` 加进 `node.apply()` 的参数。）

**这段在做什么（关键洞察）：** 第 (1) 步是整层的灵魂。传统渲染里 bloom 之所以贵，是因为要在屏幕空间做模糊；但**高斯 splat 本身就是一个边缘软衰减的光斑**——把亮的 splat 放大 1.6 倍，它的高斯边缘自然晕开，视觉效果就是光在溢出。等于借用了泼溅这种表示法的数学性质，把后处理的活在几何阶段免费做掉了。这是泼溅渲染独有的 trick，传统 mesh 做不到。

`0.55` 这个亮度阈值是给 Marble 生成的室内场景调的经验起点：窗户、灯具、天光这些天然亮区会被选中发光，墙面家具不受影响。如果你的场景整体偏亮（比如白色泳池场景），把阈值提到 0.7，否则满屏都在发光就不梦幻了，是雾里看花变成雾里看雾。

### 第二层：addtive 光尘粒子（氛围层）

dreamcore 的标志性元素之一：空气里悬浮的发光尘埃。用 `THREE.Sprite` + 加法混合实现，这是标准 Three.js 技巧（公共知识，非借鉴），成本极低且在 WebXR 里完全正常工作：

```javascript
// js/glow.js
import * as THREE from "three";

// 程序化生成一张"光点"贴图：中心白、边缘透明的径向渐变
// 不用美术资源，一个 canvas 搞定
function makeGlowTexture() {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const grad = ctx.createRadialGradient(
    size / 2, size / 2, 0, size / 2, size / 2, size / 2
  );
  grad.addColorStop(0.0, "rgba(255,255,255,1)");
  grad.addColorStop(0.3, "rgba(230,210,255,0.6)");
  grad.addColorStop(1.0, "rgba(200,180,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

export function createGlowDust(scene, count = 80) {
  const texture = makeGlowTexture();
  const sprites = [];

  for (let i = 0; i < count; i++) {
    const mat = new THREE.SpriteMaterial({
      map: texture,
      blending: THREE.AdditiveBlending,  // ★ 加法混合 = 光的物理直觉
      depthWrite: false,                 // 不写深度，互相不遮挡
      transparent: true,
      opacity: 0.15 + Math.random() * 0.25,
    });
    const s = new THREE.Sprite(mat);

    // 随机分布在用户周围 1–5 米的环带里
    const angle = Math.random() * Math.PI * 2;
    const r = 1 + Math.random() * 4;
    s.position.set(
      Math.cos(angle) * r,
      0.3 + Math.random() * 2.4,
      Math.sin(angle) * r
    );
    const scale = 0.02 + Math.random() * 0.06;   // 2–8 厘米的光点
    s.scale.set(scale, scale, 1);

    // 给每个粒子存一份漂浮参数（不每帧 new 对象）
    s.userData = {
      baseY: s.position.y,
      speed: 0.2 + Math.random() * 0.4,
      phase: Math.random() * Math.PI * 2,
    };
    sprites.push(s);
    scene.add(s);
  }

  // 每帧调用：缓慢的上下漂浮 + 呼吸联动的明暗
  function update(elapsed, breath) {
    for (const s of sprites) {
      const { baseY, speed, phase } = s.userData;
      s.position.y = baseY + Math.sin(elapsed * speed + phase) * 0.15;
      s.material.opacity =
        (0.15 + 0.1 * Math.sin(elapsed * speed * 0.7 + phase))
        * (0.8 + 0.4 * breath);          // ★ 吸气时光尘整体变亮
    }
  }

  return { update };
}
```

**这段在做什么：** `AdditiveBlending` 是"发光感"的物理来源——加法混合下颜色只会叠加变亮（光的行为），不会像普通透明那样变浊（颜料的行为），两个光点重叠的地方更亮，和真实光斑一致。`depthWrite: false` 防止半透明粒子互相产生方形遮挡 artifact。最后一行把粒子亮度乘上呼吸相位——**吸气时连空气里的光尘都跟着亮起来**，三个通道（位移、环境光、光尘）在同一个节律上，这就是 Step 4 里说的"空间活着"的感觉来源。粒子的 update 接进 main.js 主循环：`glowDust.update(elapsed, uBreathPhase)`（在 effects.js 里把呼吸相位也 return 出来即可）。

### 第三层：dyno 内的距离薄雾（纵深层）

辉光要"梦幻"还差最后一味：纵深感。真实的雾气会让远处的东西褪向雾色，光在雾里有体积感。Three.js 自带的 `scene.fog` 对 Spark 的 splat 材质**不生效**（和打光不生效是同一个原因），所以雾也在 dyno 里做——在 statements 里辉光代码之后加三行：

```glsl
// ---- 距离薄雾：远处的 splat 颜色褪向雾色 ----
const vec3 HAZE = vec3(0.72, 0.66, 0.86);          // 雾色：偏紫的灰
float fogAmount = 1.0 - exp(-0.06 * length(pos));  // 指数雾，6% 密度
${outputs.gsplat}.rgba.rgb = mix(
  ${outputs.gsplat}.rgba.rgb, HAZE, fogAmount * 0.45
);
```

**这段在做什么：** `1 - exp(-density * d)` 是图形学标准的指数雾公式（公共知识）：2 米外褪色 11%，10 米外褪色 45%，无穷远趋近上限。最后乘 0.45 是把雾的最大浓度封顶——你要的是 haze（薄霭）不是 fog（浓雾），远景仍然可辨认，只是像隔了一层柔光纱。雾色选偏紫的灰而不是纯灰，让雾本身也属于梦核色板，和第一层的 GLOW_TINT 同一色系。

### 桌面演示版的可选加强：真 Bloom

如果你要给 GOSIM/会议做**桌面（非 VR）演示版**，可以叠一个真正的 `UnrealBloomPass`（Three.js 官方后处理，公共知识）。这层只在非 VR 路径启用：

```javascript
// 仅当 navigator.xr 不可用或用户没进 VR 时启用
// strength 0.4 / radius 0.8 / threshold 0.85 是适合泼溅场景的保守起点
```

VR 路径**永远不要**启用 EffectComposer——上面三层在 Quest 里已经给足辉光感，且帧率无忧。一套代码两条渲染路径，演示版好看，头显版流畅。

### 三层的关系总结

| 层 | 实现 | 负责的感受 | 性能成本 |
|----|------|-----------|---------|
| 亮部泛光 | dyno shader | "那里在发光" | ~0（几次乘加） |
| 光尘粒子 | additive sprites | "空气里有光" | 80 个 sprite，可忽略 |
| 距离薄雾 | dyno shader | "光有纵深" | ~0 |
| 真 Bloom | 后处理（仅桌面） | 锦上添花 | 高，VR 禁用 |

三层都接受呼吸相位调制的话（泛光强度、粒子亮度、雾浓度各乘一点 breath），整个光环境会和空间一起呼吸——这是参考项目没有的东西，也是"功能性美学"最可演示的形态。

---

## 8. Step 6 — session.js：体验时间轴

把显形、三个 voice slot、环境切换、淡入淡出编排在一起。结构上和 A-Frame 版的 session-controller 同源（那本来就是我写的），但 fade 的实现方式在 WebXR 下完全不同，单独讲。

```javascript
// js/session.js
import * as THREE from "three";

export class SessionTimeline {
  constructor({ scene, camera, splat, audio, effects }) {
    this.splat = splat;
    this.audio = audio;
    this.effects = effects;

    // ---- 配置 ----
    this.voiceSlots = [60, 240, 480];          // 秒
    this.envSwitches = [
      { at: 150, url: "./resources/worlds/env_2.spz" },
      { at: 360, url: "./resources/worlds/env_3.spz" },
    ];

    // ---- 状态 ----
    this.elapsed = -1;          // -1 = 未开始
    this.slotFired = new Set();
    this.envFired = new Set();
    this.revealT = 0;
    this.revealDuration = 15;
    this.fadeTarget = 0;        // 黑幕目标透明度
    this.fadeSpeed = 1.2;       // 每秒透明度变化量

    // ---- VR 安全的"黑幕"：挂在相机上的小球壳 ----
    // 为什么不能用 DOM/CSS 遮罩：进入 immersive-vr 后页面 DOM 不渲染。
    // 为什么不用相机前的平面：平面盖不住 VR 的全视场，转头会穿帮。
    // 解法：一个半径 0.5m、法线朝内的黑色球，永远跟着头。
    const fadeGeo = new THREE.SphereGeometry(0.5, 16, 16);
    const fadeMat = new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0,
      side: THREE.BackSide,     // 从球内部看
      depthTest: false,         // 永远画在最上层
    });
    this.fadeSphere = new THREE.Mesh(fadeGeo, fadeMat);
    this.fadeSphere.renderOrder = 999;
    camera.add(this.fadeSphere);   // 父节点是 camera → 跟头
  }

  start() {
    this.elapsed = 0;
  }

  update(dt) {
    if (this.elapsed < 0) return;
    this.elapsed += dt;

    // ---- 1) 入场显形（前 revealDuration 秒）----
    if (this.revealT < 1) {
      this.revealT = Math.min(this.revealT + dt / this.revealDuration, 1);
      const eased = 1 - Math.pow(1 - this.revealT, 3);  // cubic ease-out
      this.effects.uniforms.uReveal.value = eased;
    }

    // ---- 2) Voice slots ----
    this.voiceSlots.forEach((t, i) => {
      if (this.elapsed >= t && !this.slotFired.has(i)) {
        this.slotFired.add(i);
        this.audio.playVoice(i);
      }
    });

    // ---- 3) 环境切换 ----
    this.envSwitches.forEach((sw, i) => {
      if (this.elapsed >= sw.at && !this.envFired.has(i)) {
        this.envFired.add(i);
        this.switchEnvironment(sw.url);
      }
    });

    // ---- 4) 黑幕缓动 ----
    const mat = this.fadeSphere.material;
    const diff = this.fadeTarget - mat.opacity;
    if (Math.abs(diff) > 0.001) {
      mat.opacity += Math.sign(diff) * Math.min(Math.abs(diff), this.fadeSpeed * dt);
    }
  }

  async switchEnvironment(url) {
    this.fadeTarget = 1;                       // 渐黑
    await this._waitForFade(1);

    this.splat.url = url;                      // 若该版本 Spark 不支持热换 url，
                                               // 见下方"环境切换的两种实现"
    await new Promise(r => setTimeout(r, 1500)); // 给加载留缓冲

    this.fadeTarget = 0;                       // 渐亮
  }

  _waitForFade(target) {
    return new Promise((resolve) => {
      const check = () => {
        if (Math.abs(this.fadeSphere.material.opacity - target) < 0.01) resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }
}
```

**这段在做什么（重点讲三处）：**

**黑幕球。** 这是 WebXR 和普通网页开发差异最大的地方之一。网页里淡入淡出就是一个 CSS 遮罩；VR 里 DOM 不存在，相机前放平面又盖不住转头后的视野。标准解法是**法线朝内的小球壳挂在 camera 节点下**——camera 走到哪它罩到哪，`side: BackSide` 让材质从内侧可见，`depthTest: false + renderOrder: 999` 保证它压过场景里所有东西。半径 0.5 米是经验值：足够小不会碰到场景几何，足够大不会被近裁剪面切掉。

**dt 累积而不是绝对时间。** A-Frame 版用 `performance.now() - startTime` 算绝对时间；这版改用 `elapsed += dt` 累积。原因：用户中途摘下头显时 XR session 会暂停，dt 累积方案下时间轴自动跟着暂停，戴回来从暂停处继续——对一个 8 分钟的疗愈体验来说，这是正确行为（绝对时间方案会在用户摘头显期间把 voice slot 全部错过）。

**环境切换的两种实现。** 代码里写的 `splat.url = url` 是乐观写法，Spark 0.1.x 对运行时换 URL 的支持在不同小版本间有差异。**稳妥方案是预加载双缓冲**：体验开始时就把 env_2、env_3 的 SplatMesh 也创建出来（`visible = false`），切换时只翻 visible 开关——内存代价是同时驻留 2-3 个 500k 场景（Quest 3 可以承受），换来的是零等待切换。原型期建议直接用双缓冲，省去和加载时序搏斗。另一个隐藏好处：切换瞬间新场景的 `uReveal` 可以重置为 0 再播一次显形——**每个新环境都为你重新苏醒一次**,体验的仪式感是连贯的。

---

## 9. Step 7 — audio.js：音频管理

Web Audio 的标准用法（MDN 范式，非借鉴特定项目）。参考项目的 AudioAnalyzer 思路（FFT 驱动视觉）这版先不接——你不要水波纹之后，音频反应式视觉的必要性下降，留作 Phase 3 可选项。

```javascript
// js/audio.js
export class AudioManager {
  constructor() {
    this.ctx = null;
    this.voiceUrls = [];
    this.ambientGain = null;

    // 从 onboarding 页带过来的个性化语音
    try {
      this.voiceUrls = JSON.parse(sessionStorage.getItem("voices") || "[]");
    } catch { /* 没有就静默降级 */ }
  }

  // 必须在用户手势的调用栈里执行（进入 VR 按钮的 onclick）
  async unlock() {
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") await this.ctx.resume();

    // 播一段 0.05 秒的静音 buffer，把音频管线彻底"焐热"
    // 某些 Quest 浏览器版本里只 resume 不够，这一下是保险
    const buf = this.ctx.createBuffer(1, 2205, 44100);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.start();

    this._startAmbient("./resources/audio/ambient_1.mp3");
  }

  async _startAmbient(url) {
    const res = await fetch(url);
    const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    this.ambientGain = this.ctx.createGain();
    this.ambientGain.gain.value = 0;
    src.connect(this.ambientGain).connect(this.ctx.destination);
    src.start();

    // 5 秒淡入到 0.35——和视觉显形同步发生
    this.ambientGain.gain.linearRampToValueAtTime(
      0.35, this.ctx.currentTime + 5
    );
  }

  async playVoice(index) {
    const url = this.voiceUrls[index];
    if (!url || !this.ctx) return;

    // ambient ducking：语音进来时垫乐让位
    const now = this.ctx.currentTime;
    this.ambientGain.gain.linearRampToValueAtTime(0.15, now + 1.0);

    const res = await fetch(url);
    const buf = await this.ctx.decodeAudioData(await res.arrayBuffer());
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = 0.85;
    src.connect(g).connect(this.ctx.destination);
    src.start();

    // 语音结束后 ambient 恢复
    src.onended = () => {
      this.ambientGain.gain.linearRampToValueAtTime(
        0.35, this.ctx.currentTime + 2.0
      );
    };
  }
}
```

**这段在做什么（讲两处关键设计）：**

**unlock 里的静音 buffer。** 浏览器音频自动播放策略的实际表现比文档描述的更碎：理论上 `ctx.resume()` 在用户手势里调用就够了，但部分 Quest Browser 版本里 resume 成功后第一次真正播放仍会被吞掉。在手势调用栈里**实际播放过一次东西**（哪怕是 0.05 秒静音）能把管线彻底打开。这是 WebXR 音频的"民间偏方"，但有效到值得无条件加上。

**ducking（垫乐避让）。** 语音 slot 触发时 ambient 从 0.35 降到 0.15，语音结束后 2 秒缓慢恢复。所有声音都走 Web Audio 的 GainNode 而不是 `HTMLAudio.volume`，因为 GainNode 的 `linearRampToValueAtTime` 是采样级精度的平滑斜坡，HTMLAudio 改 volume 是阶跃的，在安静的疗愈场景里听得出"咔"的台阶感。这也是为什么 voice 不直接 `new Audio(url).play()`——统一走 AudioContext 还顺便绕开了上一版方案里提过的 blob URL 兼容性问题。

---

## 9.5 Step 8 — 语言跟随的 AI 脚本生成

需求：**系统界面统一英语，但语音脚本的语言跟随用户的输入语言**。用户在 onboarding 的 "What do you need today?" 框里用中文写「想被接住」，听到的引导就是中文；用英语写就是英语；混着写（你自己的习惯）就按主导语言走。

### 设计决策：不写语言检测代码

直觉做法是前端加一个语言检测库（franc、cld3 之类），检测完把语言码传给后端。**不要这样做**——多一个依赖、多一处可错（检测库对短文本和混合语言的准确率很差，「想被接住 plz」这种输入会翻车），而 Claude 本身就是目前最好的语言检测器。正确做法是把检测和生成合并成一步：**让 Claude 自己判断输入语言、用该语言写脚本、并在返回的 JSON 里报告它判断的语言码**。语言码不是装饰——下游 TTS 选 voice 和 Web Speech 降级都靠它。

`api/generate-script.js`（完整新版）：

```javascript
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { name, mood, need } = req.body;
  // mood 来自英语界面的下拉框，所以值是英语标签；
  // need 和 name 是用户自由输入——语言信号主要在这两个字段里

  const prompt = `You are a gentle, soft-spoken meditation guide for an immersive VR relaxation space.

User's name: ${name}
Current mood (selected from a menu): ${mood}
What they need today (their own words): ${need}

TASK:
1. Detect the language of the user's own words (the "name" and "what they need" fields). If they mix languages, pick the dominant one. If their input gives no language signal (e.g. empty or just an emoji), default to English.
2. Write 3 short voice-guidance scripts IN THAT LANGUAGE, for three moments of the experience:
   - slot1 (1 min in): welcome, help them set down the outside world. Max 40 words/characters.
   - slot2 (4 min in): deepen the immersion, respond to what they said they need. Max 50 words/characters.
   - slot3 (8 min in): gentle closing, something they can carry back with them. Max 45 words/characters.

STYLE:
- Extremely soft, like speaking quietly beside someone, not lecturing
- Address them directly ("you" / 「你」/ equivalent in the detected language)
- No clichés ("relax your shoulders", "take a deep breath")
- Mention their name once at most, only in slot1
- Write the way a native speaker would actually speak — natural rhythm, not translated-sounding

Return ONLY raw JSON, no markdown fences:
{"lang": "<BCP-47 code, e.g. zh-CN, en-GB, ja-JP>", "slot1": "...", "slot2": "...", "slot3": "..."}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 700,
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();
    const text = data.content[0].text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(text);

    res.status(200).json({
      lang: parsed.lang || "en-GB",
      scripts: [parsed.slot1, parsed.slot2, parsed.slot3]
    });

  } catch (err) {
    console.error(err);
    // 降级：英语默认脚本（系统语言）
    res.status(200).json({
      lang: "en-GB",
      scripts: [
        `${name}, you've arrived. There is nothing you need to do here.`,
        "Let this space hold you. Nothing needs your attention right now.",
        "You can carry this quietness back with you, slowly."
      ]
    });
  }
}
```

**这段在做什么（三处设计）：**

**语言信号的来源分层。** `mood` 来自英语下拉框，永远是英语，对语言判断是噪声；真正的信号在 `need` 和 `name` 两个自由输入字段。prompt 里明确告诉 Claude 只看用户自己写的字段判断语言——不写这句的话，Claude 有概率被 mood 的英语标签带偏。这是 prompt 设计里"信息来源标注"的小课：告诉模型每个字段是谁产生的，比把所有字段平铺更可靠。

**"native speaker would actually speak" 那一行。** 没有这句，Claude 给非英语语言写引导词时容易先用英语思路构句再翻译，产出"翻译腔"——中文里的表现是欧化长句和书面语。引导冥想的语音对自然度极其敏感，翻译腔会瞬间打破信任感。

**BCP-47 语言码作为返回契约。** `zh-CN`、`en-GB`、`ja-JP` 这种格式是 Web 平台的通用语言标识，拿到之后两个下游直接能用：Web Speech API 的 `utterance.lang` 字段吃的就是它；ElevenLabs 选 voice 也按它路由。

### TTS 侧的语言路由

`api/tts.js` 的修改很小——ElevenLabs 的 `eleven_multilingual_v2` 模型本身就是多语言的（同一个 voice 能说中英日），所以**模型不用换**，要处理的是不同语言适合不同 voice 的问题：

```javascript
// 在 tts.js 顶部加一个路由表：每种语言用试听后最自然的 voice
// （这些需要你在 ElevenLabs 后台实际试听后填，下面是占位结构）
const VOICE_BY_LANG = {
  "zh":     process.env.VOICE_ZH || "DEFAULT_VOICE_ID",  // 中文最柔的声音
  "en":     process.env.VOICE_EN || "DEFAULT_VOICE_ID",
  "ja":     process.env.VOICE_JA || "DEFAULT_VOICE_ID",
  "_other": process.env.VOICE_DEFAULT || "DEFAULT_VOICE_ID",
};

function pickVoice(lang) {
  const primary = (lang || "en").split("-")[0];  // "zh-CN" → "zh"
  return VOICE_BY_LANG[primary] || VOICE_BY_LANG["_other"];
}

// handler 里：const { text, lang } = req.body;
// const VOICE_ID = pickVoice(lang);
// 其余请求体不变（model 仍是 eleven_multilingual_v2）
```

前端 onboarding 的对应改动：把 `generate-script` 返回的 `lang` 一起传给 `/api/tts`，并和音频 URL 一起存进 sessionStorage（Web Speech 降级时 `utterance.lang = lang` 直接用）。

**为什么按主语言（`zh`）而不是完整语言码（`zh-CN`）路由 voice：** ElevenLabs 的 voice 没有细到区分地区变体的程度，按主语言路由配置表最小；但**保留完整码传给 Web Speech**，因为浏览器 TTS 是区分 `zh-CN` / `zh-TW` 的，选错了口音会很出戏。一份数据，两个粒度的消费方。

### 测试清单

| 输入（need 字段） | 期望 lang | 期望脚本语言 |
|------------------|----------|------------|
| "to feel held" | en-* | 英语 |
| 「想被接住，什么都不想」 | zh-CN | 中文 |
| 「想被接住 just for a while」 | zh-CN（中文主导） | 中文 |
| 静かになりたい | ja-JP | 日语 |
| 空着不填 | en-GB（默认） | 英语 |

最后一行是重点：**无信号时落回英语**，和系统语言一致，这样降级路径上整个产品的语言是连贯的。

---

## 10. Marble 工作流（替代 Luma Genie）

1. 在 [marble.worldlabs.ai](https://marble.worldlabs.ai) 用文字或图片 prompt 生成世界。Dreamcore prompt 方向：`liminal indoor pool, soft diffused light, pastel haze, empty, quiet, dream-like`（用图片 prompt 控制力更强——可以先用你的 Dream Core Generator 出图再喂给 Marble，这样整条 pipeline 都是你自己的美学）。
2. 导出选 **Gaussian Splat → 500k（轻量档）→ .spz 格式**。500k 档是为实时播放优化的，Quest 上这是流畅度的保证；全分辨率 200 万 splats 留给桌面演示版。
3. 下载自定义场景需要付费订阅（免费档之上分几档，最高 $95/月）。研究 demo 期订一个月，把 5 个环境一次性生成导出，然后停订。
4. 留意 World API（2026 年 1 月开放）：支持文字/图片/全景/视频四种输入的程序化生成。你那个三档 autonomy 研究设计（高/中/低自主度的 AI 场景生成）如果要做"用户输入 → 实时生成专属环境"，这个 API 是技术前提，Luma 没有对应能力。原型期不用接，但写研究计划时可以引用它论证 feasibility。

---

## 11. Quest 性能调优清单

| 手段 | 代码位置 | 效果 |
|------|---------|------|
| 用 500k 轻量档 .spz | Marble 导出设置 | 最大单项优化 |
| `renderer.xr.setFoveation(1.0)` | main.js | 边缘降采样，省 15–25% fill rate |
| `renderer.xr.setFramebufferScaleFactor(0.85)` | main.js（需要时加） | 整体降一点渲染分辨率，泼溅场景视觉损失很小 |
| 显形遮罩用 scales 而非 alpha | effects.js（已内置） | 降低透明混合开销 |
| 双缓冲环境预加载 | session.js | 用内存换零卡顿切换 |
| 避免每帧 new 对象 | 所有 update 函数 | 防 GC 卡顿（上面的代码已遵守） |

实测方法：Quest 浏览器地址栏进 `chrome://webxr-internals` 看帧时间，目标是 72Hz 下帧时间稳定 < 13ms。

---

## 12. 坑清单（WebXR + Spark 特有）

| 症状 | 原因 | 解法 |
|------|------|------|
| 进 VR 后画面全黑但桌面正常 | 用了 `requestAnimationFrame` 当主循环 | 必须 `renderer.setAnimationLoop` |
| 进 VR 后没有任何声音 | AudioContext 没在手势内解锁 | unlock 必须在按钮 onclick 调用栈里，含静音 buffer 偏方 |
| splat 完全不渲染、无报错 | Three.js 与 Spark 版本错配 | 锁 importmap 版本，升级时查 Spark release notes |
| 场景在脚下 / 头顶 / 侧躺 | Marble 场景原点不可预测 | 桌面模式用调试快捷键对位，写死数值 |
| 转头时黑幕露馅 | 用了相机前平面做 fade | 换成 BackSide 球壳挂 camera 下 |
| 用户摘头显后语音全错过 | 时间轴用绝对时间 | dt 累积方案（session.js 已采用） |
| 呼吸效果引发轻微眩晕 | 幅度过大 | uBreathAmp ≤ 0.03，且绝不加旋转分量 |
| 满屏都在发光，没有梦幻感 | 辉光亮度阈值对该场景太低 | 把 glowMask 的 smoothstep 下限从 0.55 往上调（亮场景试 0.7+） |
| 加了 PointLight / scene.fog 没效果 | splat 颜色是烘焙的，不走光照/雾管线 | 光和雾都在 dyno 里做（Step 5+ 的三层方案） |
| VR 里开 bloom 后帧率腰斩 | EffectComposer 双眼双倍后处理 | bloom 只给桌面演示版，VR 用 dyno 泛光 |
| 帧率周期性掉一下 | update 里每帧创建对象触发 GC | 复用向量/数组，热路径零分配 |

---

## 13. 分阶段计划

**Phase 1（2 天）— 骨架验证**
main.js + 一个 Marble .spz + WebXR 进出。验收标准：Quest 里能站在场景中环顾，72Hz 稳定。不写任何效果。

**Phase 2（2–3 天）— 视觉灵魂**
effects.js 呼吸 + 显形 + 三层辉光（亮部泛光、光尘粒子、距离薄雾）。这是最值得花时间打磨参数的阶段：呼吸周期、幅度、显形时长、辉光阈值都在真机里反复调。验收标准：朋友戴上后的第一反应是安静下来而不是"哇好炫"。

**Phase 3（1–2 天）— 体验编排**
session.js + audio.js + onboarding/AI pipeline（本文 Step 8 的语言跟随版）。语音先用 Web Speech API 占位（`utterance.lang` 用 Claude 返回的语言码），效果满意后换 ElevenLabs。

**Phase 4（1 天）— 收尾**
双缓冲多环境、ducking 调音、性能清单逐项过、部署 Vercel。

总计约 6–7 天。和 A-Frame 方案相比多出来的时间几乎全部花在 Phase 2——也就是花在这套技术栈存在的理由上。

---

## 附：本方案 vs 参考项目的差异总表（写论文/汇报时可直接引用的对照）

| 维度 | cocolinux/dreamcore-experiment | 本方案 |
|------|-------------------------------|--------|
| 目标平台 | 桌面浏览器（无 VR） | WebXR / Quest 头显 |
| 交互范式 | 鼠标飞行相机 + GUI 调参 | 无操作的引导式体验时间轴 |
| 视觉效果定位 | 8 种效果的艺术实验 | 2 种为情绪调节服务的克制效果 |
| 呼吸效果 | 固定周期、含旋转 | 节律可配置、raised-cosine、无旋转（防晕动） |
| 显形效果 | 角度扫描（雷达式） | 以用户为中心的球面波 |
| 辉光 | 无（效果聚焦形变与噪声） | 三层方案：dyno 亮部泛光 + 光尘粒子 + 距离薄雾，均与呼吸节律耦合 |
| 语言 | 单语言 | 系统英语 + 语音脚本跟随用户输入语言（Claude 检测，BCP-47 贯穿 TTS） |
| 音频 | FFT 驱动视觉强度 | 时间轴语音编排 + ducking |
| AI 介入点 | 生成环境（Marble）和音乐 | 生成环境 + 实时个性化语音脚本 |
