/* MMM-MirrorFeed node_helper — mode별로 mirror-feed 서버에서 주기적으로 가져옴.
 *  - mode "html"  : GET /api/html → 모듈 내 cache/feed.html 파일로 저장 → MM이 iframe 으로 로드
 *  - mode "center": GET /api/center → 메시지 리스트 전송 (MM middle_center)
 *  - mode "bottom": GET /api/bottom → 메시지 리스트 전송 (MM bottom_bar)
 * host/주기는 .env(MIRROR_FEED_HOST / _UPDATE_MS / _ROTATE_MS) 우선. */
const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");

module.exports = NodeHelper.create({
  start() {
    this.instances = {};
    this.cacheDir = path.join(__dirname, "cache");
    try { fs.mkdirSync(this.cacheDir, { recursive: true }); } catch (e) { /* noop */ }
  },

  socketNotificationReceived(notification, payload) {
    if (notification !== "MIRRORFEED_INIT") return;
    const mode = payload.mode || "html";
    const host = (process.env.MIRROR_FEED_HOST || payload.host || "http://localhost:8090").replace(/\/+$/, "");
    const updateMs = parseInt(process.env.MIRROR_FEED_UPDATE_MS || payload.updateMs || 60000, 10);
    const rotateMs = parseInt(process.env.MIRROR_FEED_ROTATE_MS || payload.rotateMs || 12000, 10);
    if (this.instances[mode]) clearInterval(this.instances[mode].timer);
    const inst = { host, updateMs, rotateMs };
    inst.timer = setInterval(() => this.fetchMode(mode, inst), updateMs);
    this.instances[mode] = inst;
    console.log(`[MMM-MirrorFeed] mode=${mode} host=${host} updateMs=${updateMs} rotateMs=${rotateMs}`);
    this.fetchMode(mode, inst);
  },

  async fetchMode(mode, inst) {
    try {
      if (mode === "html") {
        const j = await fetch(`${inst.host}/api/html`).then((r) => r.json());
        fs.writeFileSync(path.join(this.cacheDir, "feed.html"), j.html || "", "utf8");
        this.sendSocketNotification("MIRRORFEED_DATA", {
          mode, url: "/modules/MMM-MirrorFeed/cache/feed.html", ts: Date.now(),
        });
      } else {
        const ep = mode === "center" ? "/api/center" : "/api/bottom";
        const j = await fetch(`${inst.host}${ep}`).then((r) => r.json());
        this.sendSocketNotification("MIRRORFEED_DATA", {
          mode, messages: j.messages || [], rotateMs: inst.rotateMs,
        });
      }
    } catch (e) {
      console.error(`[MMM-MirrorFeed:${mode}] fetch 실패:`, e.message);
    }
  },
});
