/* MMM-MirrorFeed — mode별 렌더.
 *  html  : node_helper 가 저장한 cache/feed.html 을 iframe(src)로 표시 (MM 서버가 정적 제공)
 *  center: 메시지를 큰 글씨로 회전 (middle_center)
 *  bottom: 메시지를 한 줄로 회전 (bottom_bar) */
Module.register("MMM-MirrorFeed", {
  defaults: {
    mode: "html",        // "html" | "center" | "bottom"
    host: "", updateMs: 0, rotateMs: 0,
    width: "300px", height: "400px",   // html iframe 크기
    fontSize: "",        // center/bottom 글씨 크기 (예: "33px")
    offsetTop: "",       // center 를 아래로 이동 (예: "6vh")
  },

  start() {
    this.feedUrl = "";
    this.msgs = [];
    this.idx = 0;
    this.rotTimer = null;
    this.sendSocketNotification("MIRRORFEED_INIT", {
      mode: this.config.mode,
      host: this.config.host,
      updateMs: this.config.updateMs || undefined,
      rotateMs: this.config.rotateMs || undefined,
    });
  },

  socketNotificationReceived(n, p) {
    if (n !== "MIRRORFEED_DATA" || p.mode !== this.config.mode) return;
    if (this.config.mode === "html") {
      this.feedUrl = `${p.url}?ts=${p.ts}`;       // cache-bust 로 새 내용 반영
      this.updateDom();
    } else {
      this.msgs = p.messages || [];
      this.idx = 0;
      if (this.rotTimer) clearInterval(this.rotTimer);
      if (this.msgs.length > 1) {
        this.rotTimer = setInterval(() => {
          this.idx = (this.idx + 1) % this.msgs.length;
          this.renderText();
        }, p.rotateMs || 12000);
      }
      this.updateDom();
    }
  },

  renderText() {
    const el = document.getElementById("mmf-" + this.identifier);
    if (!el) return;
    el.style.opacity = 0;
    setTimeout(() => {
      el.textContent = this.msgs.length ? this.msgs[this.idx % this.msgs.length] : "";
      el.style.opacity = 1;
    }, 250);
  },

  getDom() {
    const wrap = document.createElement("div");
    if (this.config.mode === "html") {
      wrap.style.width = this.config.width;
      wrap.style.height = this.config.height;
      if (!this.feedUrl) {
        wrap.innerHTML = "<div style='color:#888;font-size:13px'>mirror-feed 연결 중…</div>";
        return wrap;
      }
      const iframe = document.createElement("iframe");
      iframe.setAttribute("frameborder", "0");
      iframe.setAttribute("scrolling", "no");
      iframe.style.cssText = "width:100%;height:100%;border:0;display:block;background:#000";
      iframe.src = this.feedUrl;
      wrap.appendChild(iframe);
      return wrap;
    }
    const el = document.createElement("div");
    el.id = "mmf-" + this.identifier;
    el.style.transition = "opacity .4s";
    if (this.config.mode === "center") {
      el.className = "bright";
      const fs = this.config.fontSize || "26px";
      const mt = this.config.offsetTop || "0px";
      el.style.cssText += ";font-size:" + fs + ";font-weight:300;line-height:1.4;text-align:center;max-width:70vw;margin:" + mt + " auto 0";
    } else {
      el.style.cssText += ";font-size:18px;color:#999;text-align:center";
    }
    el.textContent = this.msgs.length ? this.msgs[this.idx % this.msgs.length] : "";
    wrap.appendChild(el);
    return wrap;
  },
});
