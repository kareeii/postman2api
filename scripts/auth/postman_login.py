#!/usr/bin/env python3
"""Postman login via Camoufox — extracts session cookie and workspace info.

Uses direct OAuth URL navigation (like ronin-proxy's kiro.py) instead of clicking buttons.
Step-by-step logs emitted to stderr, final JSON result to stdout.

Usage:
  python postman_login.py --email <email> --password <password> [--headless]
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import sys
import time
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.providers.browser_utils import build_camoufox_kwargs, OAUTH_FIREFOX_PREFS, is_browser_crash


POSTMAN_SIGNUP_URL = "https://identity.getpostman.com/signup"
POSTMAN_GOOGLE_OAUTH_URL = "https://identity.getpostman.com/google/oauth2?signup=1"
HANDSHAKE_TOKEN_URL = "https://ra.gw.postman.co/v1/handshake/token?agent=cloud"


def log(step: str, msg: str, level: str = "info"):
    entry = {"step": step, "msg": msg, "level": level, "ts": time.time()}
    sys.stderr.write(json.dumps(entry) + "\n")
    sys.stderr.flush()


def decode_jwt_payload(token: str) -> dict:
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    payload_b64 = parts[1]
    padding = 4 - len(payload_b64) % 4
    if padding != 4:
        payload_b64 += "=" * padding
    try:
        decoded = base64.urlsafe_b64decode(payload_b64)
        return json.loads(decoded)
    except Exception:
        return {}


async def _is_password_step(page) -> bool:
    try:
        return bool(await page.evaluate(
            """() => {
                for (const el of document.querySelectorAll('input[type="password"], input[name="Passwd"]')) {
                    if (el.offsetParent !== null) return true;
                }
                return false;
            }"""
        ))
    except Exception:
        return False


async def _is_email_step(page) -> bool:
    try:
        return bool(await page.evaluate(
            """() => {
                for (const el of document.querySelectorAll('input[type="email"], input[name="identifier"], #identifierId')) {
                    if (el.offsetParent !== null) return true;
                }
                return false;
            }"""
        ))
    except Exception:
        return False


async def _click_google_next(page) -> bool:
    try:
        return bool(await page.evaluate(
            """() => {
                const bySubmit = document.querySelector('#identifierNext button, #passwordNext button');
                if (bySubmit && bySubmit.offsetParent !== null) { bySubmit.click(); return true; }
                for (const el of document.querySelectorAll('div.VfPpkd-RLmnJb, button, div[role="button"]')) {
                    const parentBtn = el.closest('button, div[role="button"]') || el;
                    if (parentBtn && parentBtn.offsetParent !== null) { parentBtn.click(); return true; }
                }
                return false;
            }"""
        ))
    except Exception:
        return False


async def _wait_for_google_email_transition(page, timeout_ms: int = 10000) -> bool:
    try:
        await page.wait_for_function(
            """() => {
                const host = window.location.host || '';
                const path = window.location.pathname || '';
                const visible = (selectors) => selectors.some((sel) =>
                    Array.from(document.querySelectorAll(sel)).some((el) => el.offsetParent !== null)
                );
                const hasEmail = visible(['#identifierId', 'input[name="identifier"]', 'input[type="email"]']);
                const hasPassword = visible(['input[name="Passwd"]', 'input[type="password"]']);
                if (!host.includes('accounts.google.com')) return true;
                if (hasPassword) return true;
                if (path.includes('/signin/challenge/pwd')) return true;
                return !hasEmail && !path.includes('/signin/identifier');
            }""",
            timeout=timeout_ms,
        )
        return True
    except Exception:
        return False


async def _wait_for_google_password_transition(page, timeout_ms: int = 12000) -> bool:
    try:
        await page.wait_for_function(
            """() => {
                const host = window.location.host || '';
                const path = window.location.pathname || '';
                const hasPassword = Array.from(
                    document.querySelectorAll('input[name="Passwd"], input[type="password"]')
                ).some((el) => el.offsetParent !== null);
                if (!host.includes('accounts.google.com')) return true;
                if (!path.includes('/challenge/pwd')) return true;
                return !hasPassword;
            }""",
            timeout=timeout_ms,
        )
        return True
    except Exception:
        return False


async def _fill_google_email_step(page, email: str) -> bool:
    for selector in ["#identifierId", 'input[name="identifier"]', 'input[type="email"]']:
        try:
            try:
                await page.wait_for_selector(selector, state="visible", timeout=3000)
            except Exception:
                pass

            locator = page.locator(selector).first
            try:
                count = await locator.count()
            except Exception:
                continue
            if count == 0:
                continue
            try:
                visible = await locator.is_visible()
                if not visible:
                    continue
            except Exception:
                pass

            await locator.scroll_into_view_if_needed()
            try:
                await locator.click(force=True)
            except Exception:
                pass
            await asyncio.sleep(0.2)

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(email, delay=60)
            except Exception as exc:
                log("google", f"press_sequentially failed: {exc}, trying fill()", "warn")
                try:
                    await locator.fill(email)
                except Exception as exc2:
                    log("google", f"fill() also failed: {exc2}, trying type()", "warn")
                    try:
                        await locator.type(email, delay=60)
                    except Exception as exc3:
                        log("google", f"type() also failed: {exc3}", "warn")
                        continue

            await asyncio.sleep(0.5)
            try:
                value = await locator.input_value()
            except Exception:
                value = ""
            log("google", f"Email typed: '{value[:30]}...' via {selector}")
            if email.lower() not in str(value).lower():
                log("google", f"Email mismatch with {selector}", "warn")
                continue

            clicked = await _click_google_next(page)
            if not clicked:
                log("google", "Next button JS click failed, pressing Enter")
                await locator.press("Enter")
            await _wait_for_google_email_transition(page)
            return True
        except Exception as exc:
            log("google", f"Email step error with {selector}: {exc}", "warn")
            continue
    return False


async def _fill_google_password_step(page, password: str) -> bool:
    for selector in ['input[name="Passwd"]', 'input[type="password"]']:
        try:
            try:
                await page.wait_for_selector(selector, state="visible", timeout=3000)
            except Exception:
                pass

            locator = page.locator(selector).first
            try:
                count = await locator.count()
            except Exception:
                continue
            if count == 0:
                continue
            try:
                visible = await locator.is_visible()
                if not visible:
                    continue
            except Exception:
                pass

            await locator.scroll_into_view_if_needed()
            try:
                await locator.click(force=True)
            except Exception:
                pass
            await asyncio.sleep(0.2)

            try:
                await locator.press("Control+a")
                await locator.press("Backspace")
            except Exception:
                pass

            try:
                await locator.press_sequentially(password, delay=70)
            except Exception as exc:
                log("google", f"press_sequentially failed: {exc}, trying fill()", "warn")
                try:
                    await locator.fill(password)
                except Exception as exc2:
                    log("google", f"fill() also failed: {exc2}", "warn")
                    continue

            await asyncio.sleep(0.5)
            try:
                value = await locator.input_value()
            except Exception:
                value = ""
            log("google", f"Password typed length={len(str(value))} via {selector}")
            if len(str(value)) < len(password):
                log("google", f"Password too short with {selector}", "warn")
                continue

            clicked = await _click_google_next(page)
            if not clicked:
                log("google", "Next button JS click failed, pressing Enter")
                await locator.press("Enter")
            await _wait_for_google_password_transition(page)
            return True
        except Exception as exc:
            log("google", f"Password step error with {selector}: {exc}", "warn")
            continue
    return False


async def _handle_google_consent_continue(page) -> bool:
    try:
        current_url = page.url
    except Exception:
        return False
    if "accounts.google.com" not in current_url:
        return False
    try:
        return bool(await page.evaluate(
            """() => {
                const el = document.querySelector('#submit_approve_access button, #submit_approve_access');
                if (el && el.offsetParent !== null) { el.click(); return true; }
                const keywords = ['continue','allow','lanjut','продолжить','разрешить','продовжити','дозволити',
                    'weiter','erlauben','continuer','autoriser','continuar','permitir','続行','허용','继续','允许'];
                for (const btn of document.querySelectorAll('button, div[role="button"]')) {
                    const txt = (btn.textContent || '').trim().toLowerCase();
                    if (!txt || btn.offsetParent === null) continue;
                    if (keywords.some(k => txt.includes(k))) { btn.click(); return true; }
                }
                return false;
            }"""
        ))
    except Exception:
        return False


async def _handle_google_gaplustos(page) -> bool:
    try:
        current_url = page.url
    except Exception:
        return False
    if "/speedbump/gaplustos" not in current_url:
        return False
    try:
        for selector in ["#gaplustosNext button", "#confirm", 'input[name="confirm"]', 'input[type="submit"]']:
            locator = page.locator(selector).first
            try:
                if await locator.count() == 0 or not await locator.is_visible():
                    continue
                await locator.click(force=True)
                return True
            except Exception:
                continue
        return bool(await page.evaluate(
            """() => {
                const el = document.querySelector('#gaplustosNext button');
                if (el && el.offsetParent !== null) { el.click(); return true; }
                for (const btn of document.querySelectorAll('button, input[type="submit"]')) {
                    if (!btn.offsetParent) continue;
                    btn.click(); return true;
                }
                return false;
            }"""
        ))
    except Exception:
        return False


async def _detect_google_blocking_challenge(page) -> str | None:
    try:
        current_url = page.url
    except Exception:
        return None
    if "accounts.google.com" not in current_url:
        return None
    try:
        marker = str(await page.evaluate(
            """() => {
                const text = (document.body?.innerText || '').toLowerCase();
                const markers = [
                    'captcha', 'try again later',
                    'this browser or app may not be secure',
                    'this browser may not be secure',
                    'unusual traffic',
                    "verify it's you", 'verify it's you',
                    "confirm it's you", 'confirm it's you',
                ];
                for (const candidate of markers) {
                    if (text.includes(candidate)) return candidate;
                }
                if ((window.location.pathname || '').includes('/challenge/')) return 'google challenge';
                return '';
            }"""
        )).strip()
        return marker or None
    except Exception:
        return None


async def _is_on_postman_workspace(page) -> bool:
    """Check if we've landed on a Postman workspace (not auth/identity)."""
    try:
        url = page.url
    except Exception:
        return False
    match = re.search(r'https://([a-z0-9-]+)\.postman\.co', url)
    if not match:
        return False
    subdomain = match.group(1)
    return subdomain not in ("go", "identity", "id", "www")


async def _is_onboarding_text(page) -> bool:
    """Detect onboarding by page body text or URL."""
    try:
        url = page.url
        if "onboarding" in url:
            return True
        return bool(await page.evaluate("""() => {
            const txt = (document.body?.innerText || '').toLowerCase();
            const markers = [
                'welcome to postman', 'set up your workspace',
                "what's your role", 'tell us about yourself',
                'name and role', 'personalize your experience',
                'i build', "i'd like to", 'full-stack developer',
                'get started with ai', 'monitor apis',
            ];
            for (const m of markers) {
                if (txt.includes(m)) return true;
            }
            return false;
        }"""))
    except Exception:
        return False


async def _click_text(page, *texts: str) -> str | None:
    """Click first visible element containing any of the given texts (using Playwright locators)."""
    for t in texts:
        try:
            loc = page.get_by_text(t, exact=False).first
            if await loc.count() > 0:
                await loc.click(timeout=3000, force=True)
                return t
        except Exception:
            continue
    return None


async def _complete_onboarding_ui(page) -> bool:
    """Complete onboarding step-by-step via text detection + button clicks."""
    log("onboarding", "Starting step-by-step onboarding...")

    # Name is pre-filled from Google account — skip

    # Step 1: Click "Select option" dropdown (left one), pick an option
    log("onboarding", "Step 1: Opening 'Select option' dropdown...")
    await asyncio.sleep(2)
    option_trigger = await _click_text(page, "select option")
    if option_trigger:
        log("onboarding", "Clicked 'Select option'")
        await asyncio.sleep(1.5)
        # Pick first visible option
        picked = await _click_text(page, "test apis", "build apis", "integrate apis",
            "lead a team", "manage api strategy", "evaluate postman")
        log("onboarding", f"Picked option: {picked}")
    else:
        log("onboarding", "'Select option' not found", "warn")

    # Step 2: Click "Select role" dropdown (right one), pick a role
    log("onboarding", "Step 2: Opening 'Select role' dropdown...")
    await asyncio.sleep(1.5)
    role_trigger = await _click_text(page, "select role")
    if role_trigger:
        log("onboarding", "Clicked 'Select role'")
        await asyncio.sleep(1.5)
        # Pick first visible role
        picked = await _click_text(page, "full-stack developer", "backend developer",
            "frontend developer", "qa / test engineer", "devops / platform engineer",
            "data engineer", "mobile developer", "student / educator", "other")
        log("onboarding", f"Picked role: {picked}")
    else:
        log("onboarding", "'Select role' not found", "warn")

    # Step 3: Click "1 member"
    log("onboarding", "Step 3: Clicking '1 member'...")
    await asyncio.sleep(1.5)
    member = await _click_text(page, "1 member", "just me", "only me")
    if member:
        log("onboarding", f"Member: {member}")
    else:
        # Fallback: click first visible card/button
        await page.evaluate("""() => {
            for (const el of document.querySelectorAll('button, [role="button"], input[type="radio"]')) {
                if (el.offsetParent) { el.click(); return; }
            }
        }""")
        log("onboarding", "Member: fallback click")

    # Step 4: Click Continue
    log("onboarding", "Step 4: Clicking Continue...")
    await asyncio.sleep(1)
    continued = await _click_text(page,
        "continue", "next", "get started", "let's go", "submit", "save")
    log("onboarding", f"Continue: {continued}")
    await asyncio.sleep(3)

    # AI prompt page
    if await _is_onboarding_text(page):
        log("onboarding", "AI prompt page...")
        await _click_text(page, "monitor api", "test api", "create api",
            "document api", "run collection", "data-driven")
        await asyncio.sleep(1.5)
        await _click_text(page, "get started with ai", "get started", "start using ai", "try ai")
        await asyncio.sleep(4)

    done = not await _is_onboarding_text(page)
    log("onboarding", f"Onboarding UI done: {done}")
    return done




async def login_postman(email: str, password: str, headless: bool) -> dict:
    from camoufox.async_api import AsyncCamoufox

    log("init", f"Starting Camoufox (headless={headless})...")
    log("init", f"Email: {email}")

    kwargs = build_camoufox_kwargs(
        headless_default="true" if headless else "false",
        default_timeout=30000,
        disable_coop=True,
        firefox_user_prefs=OAUTH_FIREFOX_PREFS,
    )
    timeout = kwargs.pop("_default_timeout")

    manager = AsyncCamoufox(**kwargs)
    browser = None
    try:
        log("browser", "Launching browser...")
        browser = await manager.__aenter__()
        page = await browser.new_page()
        page.set_default_timeout(timeout * 4)

        log("navigate", f"Opening {POSTMAN_SIGNUP_URL} to seed cookies...")
        await page.goto(POSTMAN_SIGNUP_URL, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(2)
        log("navigate", "Signup page loaded, cookies seeded")

        log("google", f"Navigating directly to {POSTMAN_GOOGLE_OAUTH_URL}")
        await page.goto(POSTMAN_GOOGLE_OAUTH_URL, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(3)
        log("google", f"Current URL: {page.url}")

        from urllib.parse import urlparse

        email_transition_deadline = 0.0
        password_transition_deadline = 0.0
        email_step_started_at: float | None = None
        login_done = False

        for iteration in range(90):
            try:
                current_url = page.url
            except Exception:
                return {"error": "Browser page lost during login"}

            parsed_url = urlparse(current_url) if current_url else None
            current_host = parsed_url.netloc if parsed_url else ""
            current_path = parsed_url.path if parsed_url else ""
            now = time.monotonic()

            if await _is_on_postman_workspace(page):
                login_done = True
                break

            if "postman.co" in current_host and ("onboarding" in current_path or "home" in current_path):
                login_done = True
                break

            if "SetSID" in current_url or "/accounts/set" in current_url.lower():
                await asyncio.sleep(0.5)
                continue

            on_google = "accounts.google.com" in current_host

            if on_google:
                if await _handle_google_gaplustos(page):
                    log("google", "Handled gaplustos speedbump")
                    await asyncio.sleep(0.8)
                    continue

                if await _handle_google_consent_continue(page):
                    log("google", "Granted consent")
                    await asyncio.sleep(0.8)
                    continue

                at_password = await _is_password_step(page)
                at_email = await _is_email_step(page)

                if at_email and not at_password:
                    if email_step_started_at is None:
                        email_step_started_at = now
                        log("google", "Email step detected")
                    elif now - email_step_started_at > 60.0:
                        challenge = await _detect_google_blocking_challenge(page)
                        log("google", f"Email stuck >60s. Challenge: {challenge or 'none'}", "error")
                        return {"error": f"Google login stuck at email: {challenge or 'timeout'}"}

                    if now < email_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    if await _fill_google_email_step(page, email):
                        log("google", "Email filled and submitted")
                        email_transition_deadline = time.monotonic() + 6.0
                        await asyncio.sleep(1.0)
                        continue

                if at_password:
                    email_step_started_at = None
                    if now < password_transition_deadline:
                        await asyncio.sleep(0.4)
                        continue
                    log("google", "Password step detected")
                    if await _fill_google_password_step(page, password):
                        log("google", "Password filled and submitted")
                        password_transition_deadline = time.monotonic() + 8.0
                        await asyncio.sleep(1.0)
                        continue

                if at_email or at_password:
                    await asyncio.sleep(0.6)
                    continue

                challenge = await _detect_google_blocking_challenge(page)
                if challenge:
                    log("google", f"Blocking challenge: {challenge}", "error")
                    return {"error": f"Google login blocked: {challenge}"}

                await asyncio.sleep(0.8)
                continue
            else:
                challenge = await _detect_google_blocking_challenge(page)
                if challenge:
                    log("google", f"Blocking challenge on non-Google page: {challenge}", "error")
                await asyncio.sleep(1.0)
                continue

        if not login_done:
            log("error", f"Timeout. Last URL: {page.url}", "error")
            return {"error": "Login did not complete within 90s timeout"}

        log("redirect", f"Postman landing: {page.url}")

        # Wait 10 seconds for redirect chain + JS to settle
        await asyncio.sleep(10)

        current_url = page.url
        subdomain_match = re.match(r'https://([^.]+)\.postman\.co', current_url)
        workspace_subdomain = subdomain_match.group(1) if subdomain_match else "go"
        log("redirect", f"After 10s: {current_url}")

        is_onboarding = await _is_onboarding_text(page)

        if is_onboarding:
            log("onboarding", "Onboarding text detected — completing form...")
            await _complete_onboarding_ui(page)
            await asyncio.sleep(5)
            log("onboarding", "Onboarding form done — now on workspace")
        else:
            log("onboarding", "No onboarding — existing account")

        # Now on workspace: check for Upgrade button
        log("upgrade", "Looking for Upgrade on workspace...")
        await asyncio.sleep(3)
        upgrade = await _click_text(page,
            "upgrade", "start trial", "start free trial",
            "try premium", "go pro", "unlock", "see plans", "upgrade now")

        if upgrade:
            log("upgrade", f"Clicked: {upgrade}")
            # Pricing popup → Start Trial
            await asyncio.sleep(4)
            trial = await _click_text(page, "start trial", "start free trial",
                "begin trial", "try for free", "start free trial now")
            if trial:
                log("upgrade", f"Start Trial: {trial}")
            else:
                log("upgrade", "Start Trial button not found", "warn")

            # Trial journey popup — poll for cards
            log("upgrade", "Looking for trial journey cards...")
            journey = None
            for _ in range(8):
                await asyncio.sleep(2)
                journey = await _click_text(page,
                    "run data-driven", "data-driven tests", "data-driven tests at scale",
                    "invite", "invite to workspace", "invite your team",
                    "environment", "create environment", "variable vault",
                    "collection runner", "run collection", "run a collection",
                    "create api", "monitor", "test", "workspace collaboration",
                    "recommended practice")
                if journey:
                    log("upgrade", f"Trial journey clicked: {journey}")
                    break
                log("upgrade", f"Trial journey poll {_+1}: nothing found, retrying...")
            if not journey:
                log("upgrade", "Trial journey: no card found", "warn")

            # Continue after trial journey
            await asyncio.sleep(2)
            c = await _click_text(page, "continue", "next", "get started", "begin", "let's go")
            log("upgrade", f"Continue: {c}")

            # Collaboration unlocked — poll
            solo = None
            for _ in range(6):
                await asyncio.sleep(2)
                solo = await _click_text(page,
                    "work solo", "i'm going to work solo", "going to work solo",
                    "skip", "maybe later", "not now", "continue solo",
                    "continue with free", "no thanks")
                if solo:
                    log("upgrade", f"Solo: {solo}")
                    break
                log("upgrade", f"Solo poll {_+1}: nothing found, retrying...")
            if not solo:
                log("upgrade", "Solo: no button found", "warn")
        else:
            log("upgrade", "No Upgrade button — skipping")

        log("redirect", f"Final URL: {page.url}")

        log("redirect", f"Subdomain: {workspace_subdomain}")

        log("cookie", "Extracting postman.sid...")
        cookies = await page.context.cookies()
        postman_sid = None
        for cookie in cookies:
            if cookie.get("name") == "postman.sid":
                domain = cookie.get("domain", "")
                if ".postman.co" in domain or domain == "postman.co":
                    postman_sid = cookie.get("value")
                    break
        if not postman_sid:
            for cookie in cookies:
                if cookie.get("name") == "postman.sid" and cookie.get("value"):
                    postman_sid = cookie.get("value")
                    break
        if not postman_sid:
            log("cookie", "FAILED: postman.sid not found", "error")
            return {"error": "postman.sid cookie not found"}

        log("cookie", f"postman.sid: {postman_sid[:40]}...")

        log("token", "Fetching handshake token...")
        user_id = ""
        workspace_id = ""
        try:
            handshake = await page.evaluate(
                f"""async () => {{
                    const resp = await fetch('{HANDSHAKE_TOKEN_URL}', {{credentials: 'include'}});
                    return await resp.json();
                }}"""
            )
            if handshake and handshake.get("token"):
                jwt_payload = decode_jwt_payload(handshake["token"])
                user_id = str(jwt_payload.get("userId", ""))
                workspace_id = str(jwt_payload.get("teamId", ""))
                log("token", f"userId={user_id}, teamId={workspace_id}")
        except Exception as e:
            log("token", f"Handshake failed: {e}", "warn")

        if not user_id or not workspace_id:
            log("token", "Fallback to god.postman.co...")
            try:
                user_info = await page.evaluate(
                    """async () => {
                        const resp = await fetch('https://god.postman.co/api/users/me', {credentials: 'include'});
                        return await resp.json();
                    }"""
                )
                if user_info:
                    user_id = str(user_info.get("id", user_id))
                    orgs = user_info.get("user_organizations", {}).get("organizations", [])
                    if orgs:
                        workspace_id = str(orgs[0].get("id", workspace_id))
                    log("token", f"Fallback: userId={user_id}, workspace_id={workspace_id}")
            except Exception as e:
                log("token", f"Fallback failed: {e}", "warn")

        if not user_id:
            user_id = "unknown"
        if not workspace_id:
            workspace_id = "unknown"

        log("done", f"user_id={user_id} workspace_id={workspace_id} subdomain={workspace_subdomain}")

        return {
            "postman_sid": postman_sid,
            "user_id": user_id,
            "workspace_id": workspace_id,
            "workspace_subdomain": workspace_subdomain,
        }

    except Exception as exc:
        if is_browser_crash(exc):
            log("error", f"Browser crashed: {exc}", "error")
            return {"error": f"Browser crashed: {exc}"}
        log("error", f"Unexpected: {exc}", "error")
        return {"error": f"Login failed: {exc}"}
    finally:
        if browser:
            try:
                await browser.close()
            except Exception:
                pass
        try:
            await manager.__aexit__(None, None, None)
        except Exception:
            pass
        log("cleanup", "Browser closed")


def main():
    parser = argparse.ArgumentParser(description="Postman login via Camoufox")
    parser.add_argument("--email", required=True, help="Google account email")
    parser.add_argument("--password", required=True, help="Google account password")
    parser.add_argument("--headless", action="store_true", default=False, help="Run browser in headless mode")
    args = parser.parse_args()

    result = asyncio.run(login_postman(args.email, args.password, args.headless))
    print(json.dumps(result))
    if "error" in result:
        sys.exit(1)


if __name__ == "__main__":
    main()
