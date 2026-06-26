import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import store
from .mcp_server import mcp, mcp_app

POLL_MS = int(os.environ.get("MIRROR_POLL_MS", "60000"))      # iframe 폴링 주기
ROTATE_MS = int(os.environ.get("MIRROR_ROTATE_MS", "12000"))  # 메시지 회전 주기

# 미러 iframe 이 로드하는 셸 페이지. 1분마다 읽기 API 3종을 폴링해 반영한다.
SHELL_PAGE = """<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mirror Feed</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
  #mm-root { width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="mm-root"></div>
<script>
  const POLL_MS = __POLL_MS__;
  const ROTATE_MS = __ROTATE_MS__;
  let htmlStamp = -1;
  let center = [], bottom = [];
  let ci = 0, bi = 0;
  async function getJson(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(url + " -> " + r.status);
    return r.json();
  }
  function render(id, list, idx) {
    const el = document.getElementById(id);
    if (!el) return;
    const text = (list && list.length) ? list[idx % list.length] : "";
    el.style.opacity = 0;
    setTimeout(() => { el.textContent = text; el.style.opacity = 1; }, 250);
  }
  async function poll() {
    try {
      const h = await getJson("/api/html");          // 1. html 획득
      if (h.updatedAt !== htmlStamp) {
        document.getElementById("mm-root").innerHTML = h.html;
        htmlStamp = h.updatedAt; ci = 0; bi = 0;
      }
      center = (await getJson("/api/center")).messages || [];  // 2. 중앙 텍스트 리스트
      bottom = (await getJson("/api/bottom")).messages || [];  // 3. 하단 텍스트 리스트
      render("mm-center", center, ci);
      render("mm-bottom", bottom, bi);
    } catch (e) { console.error("[mirror-feed] poll failed:", e); }
  }
  function rotate() {
    if (center.length > 1) { ci = (ci + 1) % center.length; render("mm-center", center, ci); }
    if (bottom.length > 1) { bi = (bi + 1) % bottom.length; render("mm-bottom", bottom, bi); }
  }
  poll();
  setInterval(poll, POLL_MS);
  setInterval(rotate, ROTATE_MS);
</script>
</body>
</html>""".replace("__POLL_MS__", str(POLL_MS)).replace("__ROTATE_MS__", str(ROTATE_MS))


# ---- 스키마 (FastAPI 가 OpenAPI/Swagger 자동 생성) ----
class HtmlOut(BaseModel):
    html: str
    updatedAt: int


class MessagesOut(BaseModel):
    messages: list[str]
    updatedAt: int


class HtmlIn(BaseModel):
    html: str = Field(min_length=1, description="검은 배경 MagicMirror 테마 HTML. #mm-center / #mm-bottom 포함 필수.")


class MessagesIn(BaseModel):
    messages: list[str] = Field(min_length=1, description="문자열 메시지 리스트")


class OkOut(BaseModel):
    ok: bool = True


# MCP 세션 매니저 lifespan 을 FastAPI 에 연결 (필수 — 없으면 task group 미초기화 오류).
@asynccontextmanager
async def lifespan(_app: FastAPI):
    async with mcp.session_manager.run():
        yield


app = FastAPI(
    title="mirror-feed API",
    version="1.0.0",
    description="MagicMirror 우상단 iframe 피드 서버. 읽기 API는 iframe이 1분마다 폴링하고, 쓰기 API는 MCP 커넥터 도구가 호출한다.",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# OAuth 프록시(mcp-oauth) → mirror-feed 업스트림 보호.
# MIRROR_MCP_TOKEN 이 설정된 경우에만 /mcp 에 Bearer 검사(미설정 시 로컬/LAN 개방).
MCP_TOKEN = os.environ.get("MIRROR_MCP_TOKEN", "")


@app.middleware("http")
async def _mcp_bearer_guard(request, call_next):
    if MCP_TOKEN and request.url.path.startswith("/mcp"):
        if request.headers.get("authorization", "") != f"Bearer {MCP_TOKEN}":
            return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)


@app.get("/healthz", tags=["meta"], summary="헬스 체크")
def healthz() -> dict:
    return {"ok": True}


@app.get("/", response_class=HTMLResponse, include_in_schema=False)
def index() -> str:
    return SHELL_PAGE


# ---- 읽기 API (미러가 폴링) ----
@app.get("/api/html", response_model=HtmlOut, tags=["read"], summary="테마 HTML 조회 (iframe 폴링)")
def get_html() -> dict:
    s = store.get_state()
    return {"html": s["html"], "updatedAt": s["updatedAt"]["html"]}


@app.get("/api/center", response_model=MessagesOut, tags=["read"], summary="중앙 메시지 리스트 조회")
def get_center() -> dict:
    s = store.get_state()
    return {"messages": s["center"], "updatedAt": s["updatedAt"]["center"]}


@app.get("/api/bottom", response_model=MessagesOut, tags=["read"], summary="하단 메시지 리스트 조회")
def get_bottom() -> dict:
    s = store.get_state()
    return {"messages": s["bottom"], "updatedAt": s["updatedAt"]["bottom"]}


# ---- 쓰기 API (MCP 커넥터 도구가 호출) ----
@app.post("/api/html", response_model=OkOut, tags=["write"], summary="테마 HTML 교체 (MCP set_mirror_html)")
def post_html(body: HtmlIn) -> dict:
    store.set_html(body.html)
    return {"ok": True}


@app.post("/api/center", response_model=OkOut, tags=["write"], summary="중앙 메시지 교체 (MCP set_center_messages)")
def post_center(body: MessagesIn) -> dict:
    store.set_center(body.messages)
    return {"ok": True}


@app.post("/api/bottom", response_model=OkOut, tags=["write"], summary="하단 메시지 교체 (MCP set_bottom_messages)")
def post_bottom(body: MessagesIn) -> dict:
    store.set_bottom(body.messages)
    return {"ok": True}


# ---- MCP 커넥터 (Streamable HTTP) → POST /mcp ----
app.mount("/mcp", mcp_app)
