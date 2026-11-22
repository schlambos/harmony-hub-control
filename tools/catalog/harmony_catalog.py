#!/usr/bin/env python3
"""Download one device's command set from Logitech's catalog, on your computer.

This runs on your Mac/PC, never on the hub. It signs in to YOUR Logitech
account once, downloads the device you name, and writes a small JSON package
you then open in the web UI (Import codes -> Logitech catalog). The hub
never sees your sign-in.

    python3 tools/catalog/harmony_catalog.py Sony STR-DG720
    python3 tools/catalog/harmony_catalog.py Sony STR-DG720 --output ~/Downloads/

Sign-in is a browser OAuth flow, like the Harmony desktop app: the helper
opens Logitech's own login page in your browser (OAuth 2.0 + PKCE; no
password ever touches this program), Logitech redirects to the app's
callback address, and you paste that address into the helper's local bridge
page (or its terminal). Tokens go to ~/.melodious/harmony_token.json
(mode 0600); later runs refresh them silently. No APK and no client
secret: the client_id below is the public identifier of Logitech's own
Harmony desktop app, read out of Logitech's publicly served desktop web
bundle; override it with MELODIOUS_CLIENT_ID if Logitech ever rotates it.

Etiquette: the catalog is queried like the official app queries it, for one
device at a time, read-only. Nothing is created or changed in your account.
Run it only for devices you own. Last verified against the live service
2026-10-22.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.cookiejar
import http.server
import json
import os
import re
import secrets
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from dataclasses import dataclass
from pathlib import Path

DISCOVERY_URL = "https://cf-svcs.myharmony.com/Discovery/Discovery.svc/json/GetJsonOperations"
DISCOVERY_CLIENT_TYPE = "Redbull 1.0"
OAUTH_AUTHORIZE_URL = "https://accounts.logi.com/identity/oauth2/authorize"
OAUTH_TOKEN_URL = "https://accounts.logi.com/identity/oauth2/token"
OAUTH_REDIRECT_URI = "com.logitech.harmony://lidsoauth"
# Logitech's Harmony desktop app: the LIP client its publicly served web
# bundle (sl.dhg.myharmony.com/desktop/...en.desktop-app-main) selects when
# running on a myharmony host. Verified at accounts.logi.com authorize
# 2026-10-22: this id renders the login page and bogus codes reach
# "code invalid"; the bundle's other twin (the non-myharmony branch)
# answers "The specified client_id is not valid.", so this is the live one.
DEFAULT_CLIENT_ID = "9d88df5e-7edf-4288-8634-26721cbe7add"
HARMONY_SIGNIN_URL = "https://lb-svcs.myharmony.com/CompositeSecurityServices/Security.svc/json2/signin"
SEARCH_OPERATION = "DeviceManager/SearchGlobalDevices"
GLOBAL_DEVICES_OPERATION = "DeviceManager/GetGlobalDevices"
GLOBAL_LANGUAGE_COMMANDS_OPERATION = "DeviceManager/GetGlobalLanguageCommands"
COMMANDS_OPERATION = "DeviceManager/GetCommands"
PROTOCOL_LIST_OPERATION = "UserAccountDirector/ProtocolList"
TIMEOUT = 30.0
PACKAGE_SCHEMA = "0.2.0"
DEFAULT_TOKEN_FILE = Path.home() / ".melodious" / "harmony_token.json"
BRIDGE_PORT = 8765
BRIDGE_TIMEOUT = 300.0


class CatalogError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# JSON over HTTPS with a cookie jar (the session cookies must travel)
# --------------------------------------------------------------------------
class JsonClient:
    def __init__(self, timeout: float = TIMEOUT) -> None:
        self._jar = http.cookiejar.CookieJar()
        self._opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self._jar))
        self._timeout = timeout

    def __enter__(self) -> "JsonClient":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def cookies(self) -> dict[str, str]:
        return {c.name: c.value or "" for c in self._jar}

    def get(self, url: str, *, token: str | None = None,
            headers: dict[str, str] | None = None) -> tuple[int, object]:
        request = urllib.request.Request(url, method="GET")
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", os.environ.get("MELODIOUS_USER_AGENT", "melodious-catalog/1.0"))
        if token:
            request.add_header("Authorization", "Bearer " + token)
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                return response.status, _decode(response.read())
        except urllib.error.HTTPError as error:
            return error.code, _decode(error.read())
        except (urllib.error.URLError, OSError) as error:
            raise CatalogError(f"could not reach {urllib.parse.urlsplit(url).netloc}: {error}") from None

    def post(self, url: str, payload: object, *, token: str | None = None,
             headers: dict[str, str] | None = None) -> tuple[int, object]:
        request = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"), method="POST")
        request.add_header("Content-Type", "application/json")
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", os.environ.get("MELODIOUS_USER_AGENT", "melodious-catalog/1.0"))
        if token:
            request.add_header("Authorization", "Bearer " + token)
        for name, value in (headers or {}).items():
            request.add_header(name, value)
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                return response.status, _decode(response.read())
        except urllib.error.HTTPError as error:
            return error.code, _decode(error.read())
        except (urllib.error.URLError, OSError) as error:
            raise CatalogError(f"could not reach {urllib.parse.urlsplit(url).netloc}: {error}") from None


    def post_form(self, url: str, fields: dict[str, str]) -> tuple[int, object]:
        """One form-encoded POST (the OAuth token endpoint is not JSON)."""
        request = urllib.request.Request(
            url, data=urllib.parse.urlencode(fields).encode("utf-8"), method="POST")
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
        request.add_header("Accept", "application/json")
        request.add_header("User-Agent", os.environ.get("MELODIOUS_USER_AGENT", "melodious-catalog/1.0"))
        try:
            with self._opener.open(request, timeout=self._timeout) as response:
                return response.status, _decode(response.read())
        except urllib.error.HTTPError as error:
            return error.code, _decode(error.read())
        except (urllib.error.URLError, OSError) as error:
            raise CatalogError(f"could not reach {urllib.parse.urlsplit(url).netloc}: {error}") from None


def _decode(body: bytes) -> object:
    if not body:
        return None
    try:
        return json.loads(body.decode("utf-8", errors="replace"))
    except ValueError:
        return None


def client_id() -> str:
    """The OAuth client: MELODIOUS_CLIENT_ID, else the Harmony desktop
    app's public identifier. It is a public client (PKCE, no secret)."""
    return os.environ.get("MELODIOUS_CLIENT_ID", "").strip() or DEFAULT_CLIENT_ID


# --------------------------------------------------------------------------
# browser OAuth sign-in (authorization code + PKCE, localhost bridge)
# --------------------------------------------------------------------------
def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def pkce_pair() -> tuple[str, str]:
    """(code_verifier, S256 code_challenge), the desktop app's shape."""
    verifier = _b64url(secrets.token_bytes(48))
    challenge = _b64url(hashlib.sha256(verifier.encode("ascii")).digest())
    return verifier, challenge


def authorize_url(cid: str, challenge: str, state: str) -> str:
    query = urllib.parse.urlencode({
        "client_id": cid,
        "response_type": "code",
        "code_challenge_method": "S256",
        "code_challenge": challenge,
        "state": state,
        "redirect_uri": OAUTH_REDIRECT_URI,
        "scope": "openid",
    })
    return f"{OAUTH_AUTHORIZE_URL}?{query}"


def parse_callback(text: str, *, expected_state: str) -> str:
    """The authorization code out of a callback address.

    Takes the full com.logitech.harmony://lidsoauth?code=...&state=...
    address (or just its query string). The state must match what this run
    sent: a callback from any other sign-in attempt is refused, not
    exchanged. A bare string is refused too: it can't be checked, and the
    nonce on Logitech's id.logi.com/launch.html page looks just like a code.
    """
    candidate = (text or "").strip()
    if not candidate:
        raise CatalogError("nothing was pasted; paste the callback address from your browser")
    try:
        parts = urllib.parse.urlsplit(candidate)
    except ValueError:
        raise CatalogError("that is not a valid callback address") from None
    host = (parts.hostname or parts.netloc or "").lower()
    if host.endswith("logi.com") or candidate.lower().startswith(("id.logi.com/", "accounts.logi.com/")):
        raise CatalogError(
            "that is Logitech's own page, not the callback. It hands your browser a "
            "com.logitech.harmony://lidsoauth?code=... address, which Chrome does not show "
            "in the address bar; copy the com.logitech.harmony:// callback, not the launch page")
    if "://" in candidate and (parts.scheme.lower() != "com.logitech.harmony" or
                              parts.netloc != "lidsoauth" or parts.path or parts.fragment):
        raise CatalogError("that is not the callback address: it should start with "
                           "com.logitech.harmony://lidsoauth and carry code= and state=")
    query = parts.query if ("://" in candidate or candidate.startswith("?")) else candidate
    params = urllib.parse.parse_qs(query, keep_blank_values=True)
    error = (params.get("error") or [""])[0]
    if "error" in params:
        description = (params.get("error_description") or [""])[0]
        raise CatalogError(f"Logitech refused the sign-in: {error}" + (f" ({description})" if description else ""))
    code = (params.get("code") or [""])[0]
    state = (params.get("state") or [""])[0]
    if not code:
        raise CatalogError("that is not the callback address: it should start with "
                           "com.logitech.harmony://lidsoauth and carry code= and state=")
    if (not state or not expected_state or state != expected_state or
            len(params.get("code", [])) != 1 or len(params.get("state", [])) != 1):
        raise CatalogError("that callback belongs to a different sign-in attempt; sign in again from the tab this run opened")
    return code


def oauth_exchange(client: JsonClient, cid: str, *, code: str, verifier: str) -> LipTokens:
    status, payload = client.post_form(OAUTH_TOKEN_URL, {
        "grant_type": "authorization_code",
        "client_id": cid,
        "code_verifier": verifier,
        "redirect_uri": OAUTH_REDIRECT_URI,
        "code": code,
    })
    if status != 200:
        detail = ""
        if isinstance(payload, dict):
            detail = str(payload.get("error_description") or payload.get("error") or "")
        raise CatalogError(f"Logitech rejected the code exchange: HTTP {status}" + (f" ({detail})" if detail else "")
                           + "; codes work once and expire within minutes, so run the helper again to sign in afresh")
    return LipTokens.from_mapping(payload)


def oauth_refresh(client: JsonClient, tokens: LipTokens, cid: str) -> LipTokens:
    if not tokens.refresh_token:
        raise CatalogError("there is no refresh_token; a browser sign-in is needed")
    status, payload = client.post_form(OAUTH_TOKEN_URL, {
        "grant_type": "refresh_token",
        "client_id": cid,
        "refresh_token": tokens.refresh_token,
    })
    if status != 200:
        raise CatalogError(_rejected("Logitech rejected the renewal", status))
    return LipTokens.from_mapping(payload)


_BRIDGE_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Melodious catalog sign-in</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem}
input,button{font:inherit;padding:.6rem;border-radius:.5rem}input{width:100%;box-sizing:border-box}
button{margin-top:.6rem;cursor:pointer}.hint{color:#666;font-size:.9rem}</style></head>
<body><h1>One more step</h1>
<p>After you sign in, your browser tries to open the Harmony app and lands
on an address starting with <code>com.logitech.harmony://lidsoauth</code>.
Copy that whole address from the address bar and paste it here:</p>
<form method="post" action="/callback">
<input name="callback" autocomplete="off" spellcheck="false"
 placeholder="com.logitech.harmony://lidsoauth?code=...&amp;state=...">
<button type="submit">Finish sign-in</button>
</form>
<p class="hint">This page is served by the helper on your own computer
(127.0.0.1 only). Your password is typed only on Logitech's page, never here.</p>
</body></html>
"""


def browser_signin(client: JsonClient, cid: str, *, opener=None, input_fn=None) -> LipTokens:
    """Sign in through the browser and return fresh tokens.

    Opens the authorize page, then waits for the callback address: pasted
    into the localhost bridge page, or into the terminal as a fallback.
    The pasted address is the only thing that travels back — the password
    is typed on Logitech's page and never reaches this program.
    """
    verifier, challenge = pkce_pair()
    state = secrets.token_urlsafe(24)
    url = authorize_url(cid, challenge, state)
    open_page = opener if opener is not None else webbrowser.open
    received: dict[str, str] = {}
    done = threading.Event()

    class BridgeHandler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):  # keep the terminal readable
            pass

        def _send(self, status: int, body: str) -> None:
            data = body.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):  # noqa: N802 - http.server's name
            self._send(200, _BRIDGE_PAGE)

        def do_POST(self):  # noqa: N802 - http.server's name
            length = int(self.headers.get("Content-Length") or 0)
            fields = urllib.parse.parse_qs(self.rfile.read(length).decode("utf-8", "replace"))
            received["callback"] = (fields.get("callback") or [""])[0]
            self._send(200, "<!doctype html><title>Signed in</title>"
                            "<p>Sign-in received. You can close this tab and return to the terminal.</p>")
            done.set()

    server = None
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", BRIDGE_PORT), BridgeHandler)
    except OSError:
        server = None  # port busy or sandboxed: the terminal paste still works
    if server is not None:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        print("Opening Logitech's sign-in page in your browser...")
        print(f"If it does not open, visit:\n  {url}")
        try:
            open_page(url)
        except Exception:
            pass
        if server is not None:
            print(f"After signing in, paste the callback address at http://127.0.0.1:{BRIDGE_PORT}/ "
                  "(it starts with com.logitech.harmony://lidsoauth).")
        print("Or paste that address here and press Enter (Ctrl-C to cancel):")
        callback = ""
        if server is not None:
            # Race the bridge paste against a terminal paste.
            pasted: dict[str, str] = {}

            def read_terminal() -> None:
                try:
                    pasted["text"] = (input_fn or input)()
                except (EOFError, KeyboardInterrupt):
                    pasted["text"] = ""
                done.set()

            threading.Thread(target=read_terminal, daemon=True).start()
            if not done.wait(BRIDGE_TIMEOUT):
                raise CatalogError("timed out waiting for the sign-in callback; run it again when ready")
            callback = received.get("callback") or pasted.get("text", "")
        else:
            try:
                callback = (input_fn or input)()
            except (EOFError, KeyboardInterrupt):
                callback = ""
        if not callback.strip():
            raise CatalogError("sign-in was cancelled before a callback arrived")
        code = parse_callback(callback, expected_state=state)
        return oauth_exchange(client, cid, code=code, verifier=verifier)
    finally:
        if server is not None:
            server.shutdown()
            server.server_close()


# --------------------------------------------------------------------------
# tokens on disk (0600, atomic)
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class LipTokens:
    access_token: str
    id_token: str
    refresh_token: str | None = None

    @classmethod
    def from_mapping(cls, value: object) -> "LipTokens":
        if not isinstance(value, dict):
            raise CatalogError("the sign-in answer was not a JSON object")
        access, identity, refresh = value.get("access_token"), value.get("id_token"), value.get("refresh_token")
        if not isinstance(access, str) or not isinstance(identity, str):
            raise CatalogError("access_token or id_token is missing from the sign-in answer")
        return cls(access, identity, refresh if isinstance(refresh, str) else None)

    def to_dict(self) -> dict[str, str]:
        result = {"access_token": self.access_token, "id_token": self.id_token}
        if self.refresh_token:
            result["refresh_token"] = self.refresh_token
        return result


def save_tokens(tokens: LipTokens, token_file: Path) -> None:
    token_file.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(dir=token_file.parent, prefix="." + token_file.name + ".", suffix=".tmp")
    tmp = Path(tmp_name)
    try:
        if os.name == "posix":
            os.fchmod(handle, 0o600)
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(tokens.to_dict(), stream, ensure_ascii=False, indent=2, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, token_file)
        if os.name == "posix":
            token_file.chmod(0o600)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def load_tokens(token_file: Path) -> LipTokens | None:
    try:
        return LipTokens.from_mapping(json.loads(token_file.read_text(encoding="utf-8")))
    except (OSError, ValueError, CatalogError):
        return None


# --------------------------------------------------------------------------
# session: saved tokens, silent refresh, browser sign-in as last resort
# --------------------------------------------------------------------------
def _rejected(what: str, status: int) -> str:
    hint = " -- the saved sign-in may have expired; the browser sign-in will run next" if status in (401, 403) else ""
    return f"{what}: HTTP {status}{hint}"


@dataclass(frozen=True)
class HarmonySession:
    account_id: str
    tokens: LipTokens


def harmony_signin(client: JsonClient, tokens: LipTokens) -> HarmonySession:
    status, payload = client.post(
        HARMONY_SIGNIN_URL,
        {"access_token": tokens.access_token, "id_token": tokens.id_token},
        token=tokens.access_token)
    if status != 200:
        raise CatalogError(_rejected("Harmony rejected the bootstrap", status))
    if not isinstance(payload, dict):
        raise CatalogError("Harmony's signin did not return an object")
    account_id = payload.get("AccountId")
    if not isinstance(account_id, str):
        raise CatalogError("Harmony's signin did not return an AccountId")
    if payload.get("IsLockedOut") is True:
        raise CatalogError("the Harmony account is locked")
    return HarmonySession(account_id=account_id, tokens=tokens)


def ensure_session(client: JsonClient, token_file: Path, cid: str, *, signin=None) -> HarmonySession:
    """A signed-in Harmony session: saved tokens first, then a silent
    refresh, and only then the browser sign-in (injectable for tests, so
    it never prompts on its own)."""
    tokens = load_tokens(token_file)
    if tokens is not None:
        try:
            return harmony_signin(client, tokens)
        except CatalogError:
            pass
        try:
            tokens = oauth_refresh(client, tokens, cid)
            save_tokens(tokens, token_file)
            return harmony_signin(client, tokens)
        except CatalogError:
            pass
    fresh = (signin or (lambda: browser_signin(client, cid)))()
    save_tokens(fresh, token_file)
    return harmony_signin(client, fresh)


# --------------------------------------------------------------------------
# catalog reads (read-only, one device)
# --------------------------------------------------------------------------
def _swap_host(address: str, hosts: set[str], new_host: str) -> str:
    parts = urllib.parse.urlsplit(address)
    if parts.hostname not in hosts:
        return address
    netloc = new_host + (f":{parts.port}" if parts.port else "")
    return urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))


def load_balancer_address(address: str) -> str:
    return _swap_host(address, {"svcs.myharmony.com", "cf-svcs.myharmony.com"}, "lb-svcs.myharmony.com")


@dataclass(frozen=True)
class Operation:
    identifier: str
    address: str
    name: str

    def endpoint(self, *, json2: bool = False) -> str:
        address = _swap_host(self.address, {"svcs.myharmony.com"}, "cf-svcs.myharmony.com")
        if json2:
            address = address.replace("/json/", "/json2/")
        return address + self.name


def parse_operations(payload: object) -> dict[str, Operation]:
    if not isinstance(payload, dict) or not isinstance(payload.get("GetJsonOperationsResult"), list):
        raise CatalogError("discovery did not return an operation table")
    operations: dict[str, Operation] = {}
    for item in payload["GetJsonOperationsResult"]:
        if not isinstance(item, dict):
            continue
        identifier, address, name = item.get("Identifier"), item.get("Address"), item.get("Name")
        if isinstance(identifier, str) and identifier and isinstance(address, str) and address and isinstance(name, str) and name:
            operations[identifier] = Operation(identifier, address, name)
    if not operations:
        raise CatalogError("discovery carried no usable operation")
    return operations


class GlobalCatalogClient:
    def __init__(self, client: JsonClient, session: HarmonySession) -> None:
        self._client = client
        self._session = session
        self._operations: dict[str, Operation] | None = None

    @property
    def _bearer(self) -> str:
        return self._session.tokens.access_token

    def signin(self) -> HarmonySession:
        self._session = harmony_signin(self._client, self._session.tokens)
        return self._session

    def operations(self) -> dict[str, Operation]:
        if self._operations is None:
            status, payload = self._client.post(
                DISCOVERY_URL, {"clientTypeId": DISCOVERY_CLIENT_TYPE}, token=self._bearer,
                headers={"Content-Type": "application/json; charset=utf-8", "x-logitech-api-version": "1"})
            if status != 200:
                raise CatalogError(f"discovery failed with HTTP {status}")
            self._operations = parse_operations(payload)
        return dict(self._operations)

    def _post(self, identifier: str, data: object, *, json2: bool = False,
              fallback_name: str | None = None) -> object:
        table = self.operations()
        operation = table.get(identifier)
        if operation is None and fallback_name:
            sibling = table.get(COMMANDS_OPERATION)
            if sibling is not None:
                operation = Operation(identifier, sibling.address, fallback_name)
        if operation is None:
            raise CatalogError(f"unknown catalog operation: {identifier}")
        endpoint = load_balancer_address(operation.endpoint(json2=json2))
        status, payload = self._client.post(endpoint, data, token=self._bearer)
        message = payload.get("Message") if isinstance(payload, dict) else None
        if status == 400 and isinstance(message, str) and "Access is denied" in message:
            raise CatalogError("Logitech refused the catalog session; sign in again")
        if status != 200:
            raise CatalogError(f"{identifier} failed with HTTP {status}" + (f": {message}" if message else ""))
        if payload is None:
            raise CatalogError(f"{identifier} returned HTTP 200 without JSON")
        if isinstance(payload, dict):
            result_key = operation.name + "Result"
            if result_key in payload:
                return payload[result_key]
            if "Data" in payload:
                return payload["Data"]
        return payload

    def search(self, manufacturer: str, model: str, *, max_results: int = 50) -> object:
        if not manufacturer.strip() or not model.strip():
            raise CatalogError("the catalog searches by manufacturer AND model; both are needed (part of the model is enough)")
        return self._post(SEARCH_OPERATION, {
            "manufacturer": manufacturer, "modelNumber": model,
            "deviceType": 0, "searchType": 2, "maxResults": max_results,
        }, json2=True)

    def global_devices(self, device_ids: list) -> object:
        return self._post(GLOBAL_DEVICES_OPERATION, [i for i in device_ids if i is not None], json2=True)

    def global_language_commands(self, version_id) -> object:
        if version_id is None:
            raise CatalogError("the global language version id is missing")
        return self._post(GLOBAL_LANGUAGE_COMMANDS_OPERATION,
                          {"globalLanguageVersionId": {"Value": version_id}},
                          fallback_name="GetGlobalLanguageCommands")

    def protocol_list(self) -> list[dict]:
        """Fetch the account's ProtocolList from Logitech's sync service
        (UserAccountDirector/ProtocolList, matching stock sync.lua:431-461).
        Returns [] when the operation is absent from discovery."""
        table = self.operations()
        operation = table.get(PROTOCOL_LIST_OPERATION)
        if operation is None:
            return []
        account_id = (self._session.account_id or "").strip()
        if not account_id or not re.fullmatch(r"[A-Za-z0-9._-]+", account_id):
            raise CatalogError("the Harmony session carries an invalid AccountId")
        endpoint = load_balancer_address(
            re.sub(r"\{accountId\}|%7BaccountId%7D", urllib.parse.quote(account_id, safe=""),
                   operation.endpoint(json2=True), flags=re.IGNORECASE)
        )
        status, payload = self._client.get(
            endpoint,
            token=self._bearer,
            headers={"x-logitech-api-version": "1"},
        )
        message = payload.get("Message") if isinstance(payload, dict) else None
        if status == 400 and isinstance(message, str) and "Access is denied" in message:
            raise CatalogError("Logitech refused the catalog session; sign in again")
        if status != 200:
            raise CatalogError(f"{PROTOCOL_LIST_OPERATION} failed with HTTP {status}" + (f": {message}" if message else ""))
        return extract_protocol_list(payload)


def extract_protocol_list(payload: object) -> list[dict]:
    """Extract the Protocols[] list from a UserAccountDirector/ProtocolList response."""
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if not isinstance(payload, dict):
        return []
    for container_key in ("ProtocolListResult", "Data"):
        inner = payload.get(container_key)
        if isinstance(inner, dict) and isinstance(inner.get("Protocols"), list):
            return [item for item in inner["Protocols"] if isinstance(item, dict)]
        if isinstance(inner, list):
            return [item for item in inner if isinstance(item, dict)]
    protocols = payload.get("Protocols")
    if isinstance(protocols, list):
        return [item for item in protocols if isinstance(item, dict)]
    return []


def is_valid_protocol_record(record: object) -> bool:
    """True when `record` looks like a usable Harmony IrProtocol definition."""
    if not isinstance(record, dict):
        return False
    if record.get("__type") != "IrProtocol":
        return False
    pid = record.get("Id-")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0 or pid > 999999:
        return False
    name = record.get("Name")
    if not isinstance(name, str) or not name or len(name) > 127:
        return False
    if any(ch in name for ch in (":", "\"", "\\")) or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in name):
        return False
    freq = record.get("CarrierFrequency")
    if not isinstance(freq, (int, float)) or isinstance(freq, bool) or not (10000 <= freq <= 500000):
        return False
    if not isinstance(record.get("KeyCode"), dict):
        return False
    ir_segments = record.get("IRSegments")
    code_segments = record.get("CodeSegments")
    if not isinstance(ir_segments, list):
        return False
    if code_segments is not None and not isinstance(code_segments, list):
        return False
    has_ir = any(isinstance(s, dict) for s in ir_segments)
    has_code = isinstance(code_segments, list) and any(isinstance(s, dict) for s in code_segments)
    return has_ir or has_code


def needed_protocol_refs(commands: object) -> tuple[set[int], set[str]]:
    """Protocol IDs and G:<name>: protocol names referenced by a command list."""
    ids: set[int] = set()
    names: set[str] = set()
    if not isinstance(commands, list):
        return ids, names
    for cmd in commands:
        if not isinstance(cmd, dict):
            continue
        keycode = cmd.get("KeyCode")
        if isinstance(keycode, str) and keycode.startswith("G:"):
            parts = keycode[2:].split(":", 1)
            if parts and parts[0]:
                names.add(parts[0])
            pid = cmd.get("ProtocolId")
            if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
                ids.add(pid)
    return ids, names


def select_needed_protocols(protocol_list: object, commands: object) -> list[dict]:
    """Filter a ProtocolList down to valid IrProtocol records needed by `commands`."""
    need_ids, need_names = needed_protocol_refs(commands)
    if not need_ids and not need_names:
        return []
    entries = extract_protocol_list(protocol_list) if not isinstance(protocol_list, list) else [
        item for item in protocol_list if isinstance(item, dict)
    ]
    selected: list[dict] = []
    seen_ids: set[int] = set()
    seen_names: set[str] = set()
    for proto in entries:
        if not is_valid_protocol_record(proto):
            continue
        pid = proto["Id-"]
        name = proto["Name"]
        if pid not in need_ids and name not in need_names:
            continue
        if pid in seen_ids or name in seen_names:
            continue
        seen_ids.add(pid)
        seen_names.add(name)
        selected.append(proto)
    return selected


# --------------------------------------------------------------------------
# the offline package (what the web UI opens)
# --------------------------------------------------------------------------
_SECRET_KEY = re.compile(
    r"(authorization|cookie|password|passwd|secret|access.?token|refresh.?token|id.?token|auth.?token|account.?id)",
    re.IGNORECASE)


def redact(value: object) -> object:
    if isinstance(value, dict):
        return {str(k): "[REDACTED]" if _SECRET_KEY.search(str(k)) else redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def build_package(*, manufacturer: str, model: str, search_result: object,
                  selected_match: object, global_device: object, language_commands: object,
                  protocols: object | None = None) -> dict:
    from datetime import datetime, timezone
    resources = {
        "search_result": redact(search_result),
        "selected_match": redact(selected_match),
        "global_device": redact(global_device),
        "global_language_commands": redact(language_commands),
    }
    if protocols is not None:
        resources["protocols"] = redact(protocols)
    return {
        "schema_version": PACKAGE_SCHEMA,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "logitech-catalog-via-melodious-helper",
        "query": {"manufacturer": manufacturer, "model": model},
        "resources": resources,
    }


def search_matches(search_result: object) -> list[dict]:
    if not isinstance(search_result, dict):
        raise CatalogError("SearchGlobalDevices did not return an object")
    matches = search_result.get("Matches")
    if matches is None:
        raise CatalogError("Logitech's catalog did not search: it needs the manufacturer AND the model")
    if not isinstance(matches, list):
        raise CatalogError("SearchGlobalDevices did not return Matches")
    return [m for m in matches if isinstance(m, dict)]


def fetch_package(client: JsonClient, session: HarmonySession, manufacturer: str, model: str,
                  *, pick=None) -> dict:
    with GlobalCatalogClient(client, session) as catalog:
        catalog.signin()
        raw = catalog.search(manufacturer, model)
        matches = search_matches(raw)
        if not matches:
            raise CatalogError(f"no catalog device matches {manufacturer} {model}")
        selected = pick(matches) if pick else matches[0]
        global_id = selected.get("Id-")
        if not isinstance(global_id, (int, str)) or isinstance(global_id, bool):
            raise CatalogError("the selected result carries no device id")
        result = catalog.global_devices([global_id])
        if not isinstance(result, list) or not result or not isinstance(result[0], dict):
            raise CatalogError("GetGlobalDevices did not return the device")
        global_device = result[0]
        version_id = global_device.get("DefaultGlobalLanguageVersionId")
        if not isinstance(version_id, (int, str)) or isinstance(version_id, bool):
            raise CatalogError("the device carries no language version id")
        commands = catalog.global_language_commands(version_id)
        protocols: list[dict] = []
        need_ids, need_names = needed_protocol_refs(commands)
        if need_ids or need_names:
            try:
                protocols = select_needed_protocols(catalog.protocol_list(), commands)
            except CatalogError as error:
                if "refused the catalog session" in str(error):
                    raise
                protocols = []
    return build_package(manufacturer=manufacturer, model=model, search_result=raw,
                         selected_match=selected, global_device=global_device,
                         language_commands=commands, protocols=protocols)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "x"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("manufacturer")
    parser.add_argument("model")
    parser.add_argument("--output", default=".", help="directory for the package (default: current)")
    parser.add_argument("--list", action="store_true", help="list matches and exit without downloading")
    args = parser.parse_args(argv)

    try:
        cid = client_id()
        with JsonClient() as client:
            session = ensure_session(client, DEFAULT_TOKEN_FILE, cid)
            if args.list:
                with GlobalCatalogClient(client, session) as catalog:
                    catalog.signin()
                    matches = search_matches(catalog.search(args.manufacturer, args.model))
                for i, match in enumerate(matches):
                    print(f"{i}: {match.get('Manufacturer', '')} {match.get('DeviceModel', '')} "
                          f"[{match.get('DisplayText') or match.get('SelectedText') or ''}] id={match.get('Id-')}")
                if not matches:
                    print(f"No catalog matches for {args.manufacturer} {args.model}.")
                return 0
            package = fetch_package(client, session, args.manufacturer, args.model)
    except CatalogError as error:
        print(f"harmony_catalog: {error}", file=sys.stderr)
        return 1
    output = Path(args.output).expanduser() / f"harmony-catalog-{_slug(args.manufacturer)}-{_slug(args.model)}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(package, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    commands = package["resources"]["global_language_commands"]
    count = len(commands) if isinstance(commands, list) else 0
    bundled = package["resources"].get("protocols")
    proto_note = f", {len(bundled)} protocol{'s' if len(bundled) != 1 else ''}" if isinstance(bundled, list) and bundled else ""
    match = package["resources"]["selected_match"]
    print(f"Wrote {output} ({count} commands{proto_note} for {match.get('Manufacturer', '')} {match.get('DeviceModel', '')}).")
    print("Now open it in the web UI: device page -> Import codes -> Logitech catalog.")
    return 0


# `with` support without a socket to close: kept for call-site symmetry.
GlobalCatalogClient.__enter__ = lambda self: self
GlobalCatalogClient.__exit__ = lambda self, *_: None


if __name__ == "__main__":
    raise SystemExit(main())
