# 에이전트가 set_mirror_html 로 교체하기 전까지 쓰는 기본 테마 HTML.
# 규칙: 검은 배경(#000) + MagicMirror 테마, #mm-center / #mm-bottom 컨테이너 필수.
DEFAULT_HTML = """
<style>
  :root { --mm-color: #ffffff; --mm-dim: #999999; --mm-bright: #ffffff; }
  .mm-feed {
    box-sizing: border-box; width: 100%; height: 100%;
    background: #000000; color: var(--mm-color);
    font-family: "Roboto Condensed", "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-weight: 300; display: flex; flex-direction: column;
    justify-content: space-between; padding: 18px 20px; line-height: 1.4;
    -webkit-font-smoothing: antialiased;
  }
  .mm-feed .mm-top { font-size: 13px; letter-spacing: 1px; text-transform: uppercase; color: var(--mm-dim); }
  #mm-center {
    flex: 1; display: flex; align-items: center; justify-content: flex-end;
    text-align: right; font-size: 22px; font-weight: 300; color: var(--mm-bright);
    transition: opacity 0.6s ease;
  }
  #mm-bottom {
    font-size: 15px; text-align: right; color: var(--mm-dim);
    border-top: 1px solid #222; padding-top: 10px; transition: opacity 0.6s ease;
  }
</style>
<div class="mm-feed">
  <div class="mm-top">Daily Reflection</div>
  <div id="mm-center"></div>
  <div id="mm-bottom"></div>
</div>
"""
