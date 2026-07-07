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

export function initConsoleClient({ room, effects, camera, timeline }) {
  const qp = new URLSearchParams(location.search);
  if (qp.get("ctl") !== "1") return;

  // Live tunables the console may drive. All are existing dynoFloat uniforms
  // (zero shader changes); warmth etc. stay deferred per design.md Step 5.5.
  const PARAMS = {
    exposure: effects.uniforms.uExposure,
    glow: effects.uniforms.uGlow,
    hazeDensity: effects.uniforms.uHazeDensity,
    hazeStrength: effects.uniforms.uHazeStrength,
    glowRound: effects.uniforms.uGlowRound,
  };

  const send = (msg) =>
    fetch("/ctl/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  fetch("/ctl/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "console", type: "hello-from-headset" }),
  })
    .then((r) => {
      if (!r.ok) throw new Error(`ctl ${r.status}`);
      start();
    })
    .catch(() => console.log("[ctl] no relay reachable — console client dormant"));

  function start() {
    const es = new EventSource("/ctl/events?role=headset");
    es.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

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
    };
    es.onopen = sendStatus;

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
