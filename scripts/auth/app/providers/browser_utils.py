"""Shared browser utilities for camoufox-based providers."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlparse


def build_camoufox_kwargs(
    *,
    proxy_url: str = "",
    headless_default: str = "true",
    default_timeout: int = 15000,
    disable_coop: bool = False,
    firefox_user_prefs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from browserforge.fingerprints import Screen

    headless = os.getenv("CAMOUFOX_HEADLESS", headless_default).lower() == "true"

    kwargs: dict[str, Any] = {
        "headless": headless,
        "os": "windows",
        "block_webrtc": True,
        "humanize": False,
        "screen": Screen(max_width=1920, max_height=1080),
    }

    if disable_coop:
        kwargs["disable_coop"] = True
        kwargs["i_know_what_im_doing"] = True

    if firefox_user_prefs:
        kwargs["firefox_user_prefs"] = firefox_user_prefs

    resolved_proxy = proxy_url or os.getenv("BATCHER_PROXY_URL", "")
    if resolved_proxy:
        parsed = urlparse(resolved_proxy)
        proxy_cfg: dict[str, Any] = {
            "server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
        }
        if parsed.username:
            proxy_cfg["username"] = parsed.username
        if parsed.password:
            proxy_cfg["password"] = parsed.password
        kwargs["proxy"] = proxy_cfg
        kwargs["geoip"] = True

    kwargs["_default_timeout"] = default_timeout
    return kwargs


OAUTH_FIREFOX_PREFS: dict[str, Any] = {
    "browser.tabs.remote.useCrossOriginOpenerPolicy": False,
    "browser.tabs.remote.useCrossOriginEmbedderPolicy": False,
    "fission.autostart": False,
    "fission.webContentIsolationStrategy": 0,
    "toolkit.crashreporter.enabled": False,
    "browser.sessionstore.resume_from_crash": False,
    "browser.tabs.crashReporting.sendReport": False,
    "javascript.options.mem.gc_allocation_threshold_mb": 512,
    "javascript.options.mem.high_water_mark": 128,
    "app.update.enabled": False,
    "browser.safebrowsing.enabled": False,
    "browser.safebrowsing.malware.enabled": False,
    "network.http.connection-timeout": 60,
    "network.http.response.timeout": 120,
    "dom.ipc.processHangMonitor": False,
}


def is_browser_crash(exc: BaseException) -> bool:
    exc_str = str(exc).lower()
    return (
        "connection closed" in exc_str
        or "target closed" in exc_str
        or "browser has been closed" in exc_str
        or "browser.close" in exc_str
        or "not connected" in exc_str
        or "execution context was destroyed" in exc_str
        or "context was destroyed" in exc_str
    )
