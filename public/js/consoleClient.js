// Headset-side client for the researcher console (wizard-of-oz instrument).
//
// Activated only by ?ctl=1 AND a reachable /ctl relay — the relay lives in
// dev-server.mjs, so on the deployed site this module probes once, finds
// nothing, and goes dormant. Zero cost to the experience either way.
//
// Inbound commands (console → headset):
//   setParam {key, value}  — live shader/atmosphere tunables, applied same-frame
//   setRoom  {id}          — pre-session room swap: reload with ?room=<id>
//   hello                  — console (re)connected; answer with a status report
// Outbound (headset → console):
//   status {room, params}  — on connect and whenever a command lands
//   pose {p, q}            — ~10 Hz head pose for the pose-twin monitor.
//     10 Hz is deliberate: a tiny fetch every 100 ms costs the Quest nothing
//     (design.md frame-budget rules), and the console lerps between samples.

const POSE_HZ = 10;

export function initConsoleClient({ room, effects, camera, timeline, lift }) {
  const qp = new URLSearchParams(location.search);
  const ctl = qp.get("ctl");
  if (!ctl) return;
  // ?ctl=1            → same-origin relay (page itself served by dev-server)
  // ?ctl=https://xxx  → remote relay: the page loads from the deployed site
  //                     (fixed Vercel domain) while control traffic goes to
  //                     the researcher's tunnelled laptop. CORS on /ctl/*
  //                     in dev-server.mjs makes the cross-origin calls legal.
  const base = ctl === "1" ? "" : ctl.replace(/\/+$/, "");

  // Live tunables the console may drive. Shader uniforms plus the rig-lift
  // adapter from main.js — anything with a {value} interface fits here.
  const PARAMS = {
    exposure: effects.uniforms.uExposure,
    glow: effects.uniforms.uGlow,
    hazeDensity: effects.uniforms.uHazeDensity,
    hazeStrength: effects.uniforms.uHazeStrength,
    glowRound: effects.uniforms.uGlowRound,
    lift,
  };

  // ngrok's free tier interposes a browser-warning page on tunnelled
  // requests unless this header is present; harmless on other tunnels.
  const HDRS = { "Content-Type": "application/json", "ngrok-skip-browser-warning": "1" };

  const send = (msg) =>
    fetch(`${base}/ctl/send`, {
      method: "POST",
      headers: HDRS,
      body: JSON.stringify(msg),
    }).catch(() => {});   // relay gone mid-session — never surface an error

  const sendStatus = () =>
    send({
      to: "console",
      type: "status",
      room: room.id,
      state: timeline.state,
      params: Object.fromEntries(
        Object.entries(PARAMS).map(([k, u]) => [k, u.value])
      ),
    });

  // Probe before wiring anything: on the deployed site /ctl/send 404s and we
  // go dormant instead of letting EventSource retry forever.
  fetch(`${base}/ctl/send`, {
    method: "POST",
    headers: HDRS,
    body: JSON.stringify({ to: "console", type: "hello-from-headset" }),
  })
    .then((r) => {
      if (!r.ok) throw new Error(`ctl ${r.status}`);
      start();
    })
    .catch(() => console.log("[ctl] no relay reachable — console client dormant"));

  function start() {
    // Commands arrive by POLLING, not SSE: the cloudflared tunnel the Quest
    // connects through buffers SSE downstream indefinitely (http2 transport,
    // verified 2026-07), while plain GETs round-trip fine. 1 Hz is plenty —
    // room switches are pre-session and a ≤1 s lag on a slider is invisible.
    function handle(msg) {
      if (msg.type === "setParam" && msg.key in PARAMS) {
        PARAMS[msg.key].value = Number(msg.value);
        sendStatus();
      } else if (msg.type === "setRoom") {
        // Pre-session swap by design (no hot reload of splat + effects +
        // reveal state): rewrite ?room and reload, keeping other params.
        const next = new URL(location.href);
        next.searchParams.set("room", String(msg.id));
        location.replace(next);
      } else if (msg.type === "hello") {
        sendStatus();
      }
    }
    setInterval(() => {
      fetch(`${base}/ctl/poll`, { headers: { "ngrok-skip-browser-warning": "1" } })
        .then((r) => r.json())
        .then((msgs) => msgs.forEach(handle))
        .catch(() => {});
    }, 1000);
    sendStatus();

    // Pose feed for the twin monitor. Reused vectors — no per-tick allocation.
    const _p = new (camera.position.constructor)();
    const _q = new (camera.quaternion.constructor)();
    setInterval(() => {
      camera.getWorldPosition(_p);
      camera.getWorldQuaternion(_q);
      send({
        to: "console",
        type: "pose",
        room: room.id,
        p: [_p.x, _p.y, _p.z],
        q: [_q.x, _q.y, _q.z, _q.w],
      });
    }, 1000 / POSE_HZ);

    console.log("[ctl] researcher console link active");
  }
}
