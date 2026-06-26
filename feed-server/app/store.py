import json
import os
import time
import threading
from .default_html import DEFAULT_HTML

DATA_FILE = os.environ.get("MIRROR_DATA_FILE", "./data/state.json")
_lock = threading.Lock()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _empty() -> dict:
    now = _now_ms()
    return {
        "html": DEFAULT_HTML,
        "center": ["오늘도 당신의 하루를 응원합니다."],
        "bottom": ["연결을 기다리는 중입니다…"],
        "updatedAt": {"html": now, "center": now, "bottom": now},
    }


def _load() -> dict:
    try:
        if os.path.exists(DATA_FILE):
            with open(DATA_FILE, encoding="utf-8") as f:
                data = json.load(f)
            base = _empty()
            for k in ("html", "center", "bottom"):
                if k in data:
                    base[k] = data[k]
            base["updatedAt"].update(data.get("updatedAt", {}))
            return base
    except Exception as e:  # noqa: BLE001
        print("[store] load failed, using defaults:", e)
    return _empty()


_state = _load()


def _persist() -> None:
    try:
        os.makedirs(os.path.dirname(DATA_FILE) or ".", exist_ok=True)
        with open(DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(_state, f, ensure_ascii=False, indent=2)
    except Exception as e:  # noqa: BLE001
        print("[store] persist failed:", e)


def get_state() -> dict:
    return _state


def set_html(html: str) -> None:
    with _lock:
        _state["html"] = html
        _state["updatedAt"]["html"] = _now_ms()
        _persist()


def set_center(messages: list[str]) -> None:
    with _lock:
        _state["center"] = messages
        _state["updatedAt"]["center"] = _now_ms()
        _persist()


def set_bottom(messages: list[str]) -> None:
    with _lock:
        _state["bottom"] = messages
        _state["updatedAt"]["bottom"] = _now_ms()
        _persist()
