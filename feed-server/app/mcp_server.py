import os
import httpx
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

# 도구는 일부러 쓰기 API(/api/*)를 HTTP로 호출한다 — 상태 변경 단일 진입점에 종속.
WEB_BASE = os.environ.get("MIRROR_WEB_BASE", "http://127.0.0.1:8090")

# DNS 리바인딩 보호: 프록시가 Host: mirror-feed:8090 으로 넘기므로 허용 목록에 포함해야 함.
# "base:*" 는 해당 호스트의 모든 포트를 허용하는 와일드카드 패턴.
_ALLOWED_HOSTS = [h.strip() for h in os.environ.get(
    "MIRROR_MCP_ALLOWED_HOSTS", "mirror-feed:*,localhost:*,127.0.0.1:*").split(",") if h.strip()]
_ALLOWED_ORIGINS = [o.strip() for o in os.environ.get(
    "MIRROR_MCP_ALLOWED_ORIGINS", "http://mirror-feed:*,http://localhost:*,http://127.0.0.1:*").split(",") if o.strip()]

# stateless_http=True: 일반 웹서비스처럼 요청-응답형으로 동작. 경로는 마운트 지점 기준 "/".
mcp = FastMCP(
    "mirror-feed",
    stateless_http=True,
    json_response=True,
    streamable_http_path="/",
    transport_security=TransportSecuritySettings(
        allowed_hosts=_ALLOWED_HOSTS,
        allowed_origins=_ALLOWED_ORIGINS,
    ),
)


async def _call_api(path: str, payload: dict) -> str:
    async with httpx.AsyncClient(timeout=10.0, trust_env=False) as client:
        r = await client.post(WEB_BASE + path, json=payload)
        r.raise_for_status()
        return r.text


@mcp.tool()
async def set_mirror_html(html: str) -> str:
    """매직미러 우상단 패널의 테마/레이아웃 HTML을 교체한다.
    규칙: 배경은 반드시 검은색(#000)이어야 하고 MagicMirror 테마(Roboto Condensed,
    얇은 흰색/회색 텍스트, 우측 정렬)를 따른다. HTML에는 반드시 컨테이너 #mm-center 와
    #mm-bottom 이 포함되어야 한다 — 중앙/하단 메시지가 이 두 요소에 주입된다.
    레이아웃을 바꿀 때만 호출하고, 평소에는 호출하지 않는다."""
    return "html updated: " + await _call_api("/api/html", {"html": html})


@mcp.tool()
async def set_center_messages(messages: list[str]) -> str:
    """중앙 메시지 리스트를 교체한다.
    목적: 전날·전주 사용자가 느꼈던 어려움을 따뜻하게 보듬어 주거나, 어제 있었던
    희망차고 기쁜 일을 다시 상기시켜 주는 개인화 메시지. 사용자의 AFFiNE 주간 회고
    (Weekly 회고, my-space)를 근거로 작성한다. 짧은 한국어 문장 1~3개.
    비난·평가조 금지, 따뜻하고 담백하게."""
    return "center updated: " + await _call_api("/api/center", {"messages": messages})


@mcp.tool()
async def set_bottom_messages(messages: list[str]) -> str:
    """하단 메시지 리스트를 교체한다.
    목적: 사용자가 알아두면 좋은 뉴스·정보를 한 문장으로 요약해 설명한다.
    짧은 한국어 항목 1~3개. 출처가 분명하고 사실 위주로."""
    return "bottom updated: " + await _call_api("/api/bottom", {"messages": messages})


# Streamable HTTP ASGI 앱 (FastAPI 에서 /mcp 로 마운트). session_manager 가 여기서 생성됨.
mcp_app = mcp.streamable_http_app()
