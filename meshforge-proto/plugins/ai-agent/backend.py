"""AI Agent proxy. The provider key arrives per request and is not stored or logged.

Original MIT code. Stdlib HTTP only.
"""
from __future__ import annotations
import json
import urllib.error
import urllib.request
from urllib.parse import urlparse

from fastapi import APIRouter, Body, Request

router = APIRouter()

_DEFAULTS = {
    "anthropic": "https://api.anthropic.com",
    "openai": "https://api.openai.com/v1",
    "xai": "https://api.x.ai/v1",
    "compatible": "http://127.0.0.1:11434/v1",
}
_SUGGESTED = {
    "anthropic": ["claude-3-5-haiku-latest", "claude-3-5-sonnet-latest"],
    "openai": ["gpt-4o-mini", "gpt-4o"],
    "xai": ["grok-2-latest", "grok-2-image"],
    "compatible": [],
}


def _scrub(text: str, key: str) -> str:
    out = str(text or "")
    if key:
        out = out.replace(key, "[REDACTED]")
    return out[:500]


def _loopback(url: str) -> bool:
    host = (urlparse(url).hostname or "").lower()
    return host in {"127.0.0.1", "localhost"}


def resolve_base(provider: str, requested: str | None) -> str:
    if provider not in _DEFAULTS:
        raise ValueError("Unknown provider")
    default = _DEFAULTS[provider]
    asked = (requested or "").strip().rstrip("/")
    if provider == "compatible":
        if not asked:
            raise ValueError("A base URL is required for a custom endpoint")
        return asked
    if asked and _loopback(asked):
        return asked
    return default


def resolve_google(requested: str | None) -> str:
    asked = (requested or "").strip().rstrip("/")
    if asked and _loopback(asked):
        return asked
    return "https://generativelanguage.googleapis.com/v1beta"


def _key(request: Request, name: str) -> str:
    return request.headers.get(f"x-plugin-secret-{name}") or request.headers.get(f"X-Plugin-Secret-{name}") or ""


def _http(method: str, url: str, headers: dict, body: dict | None = None, timeout: float = 25):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()
    except Exception as exc:
        raise ConnectionError("network") from exc


def _json_body(raw: bytes) -> dict:
    try:
        data = json.loads(raw.decode() or "{}")
        return data if isinstance(data, dict) else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}


def _auth_headers(provider: str, key: str) -> dict:
    if provider == "anthropic":
        return {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
    return {"Authorization": "Bearer " + key, "content-type": "application/json"}


def verify(provider: str, key: str, base: str) -> list[str]:
    url = base.rstrip("/") + ("/v1/models" if provider == "anthropic" and not base.rstrip("/").endswith("/v1") else "/models")
    if provider == "anthropic" and base.rstrip("/").endswith("/v1"):
        url = base.rstrip("/") + "/models"
    status, raw = _http("GET", url, _auth_headers(provider, key), timeout=12)
    if status in (401, 403):
        raise PermissionError("invalid")
    if status >= 400:
        raise ConnectionError("network")
    data = _json_body(raw)
    found = []
    for item in data.get("data") or data.get("models") or []:
        if isinstance(item, dict):
            mid = item.get("id") or item.get("name")
            if isinstance(mid, str):
                found.append(mid.split("/")[-1])
        elif isinstance(item, str):
            found.append(item)
    return found or list(_SUGGESTED.get(provider) or [])


def _openai_messages(messages: list) -> list:
    out = []
    for msg in messages:
        role = msg.get("role")
        if role == "tool":
            out.append({"role": "tool", "tool_call_id": msg.get("tool_call_id") or "", "content": str(msg.get("content") or "")[:8000]})
        elif role == "assistant" and msg.get("tool_calls"):
            calls = []
            for call in msg["tool_calls"]:
                args = call.get("arguments") if isinstance(call.get("arguments"), str) else json.dumps(call.get("arguments") or {})
                calls.append({"id": call.get("id") or "call", "type": "function", "function": {"name": call.get("name"), "arguments": args}})
            out.append({"role": "assistant", "content": msg.get("content") or "", "tool_calls": calls})
        else:
            out.append({"role": role if role in ("user", "assistant", "system") else "user", "content": str(msg.get("content") or "")[:8000]})
    return out


def _anthropic_messages(messages: list) -> list:
    out = []
    for msg in messages:
        role = msg.get("role")
        if role == "tool":
            out.append({"role": "user", "content": [{"type": "tool_result", "tool_use_id": msg.get("tool_call_id") or "", "content": str(msg.get("content") or "")[:8000]}]})
        elif role == "assistant" and msg.get("tool_calls"):
            blocks = []
            if msg.get("content"):
                blocks.append({"type": "text", "text": str(msg["content"])[:8000]})
            for call in msg["tool_calls"]:
                blocks.append({"type": "tool_use", "id": call.get("id") or "call", "name": call.get("name"), "input": call.get("arguments") or {}})
            out.append({"role": "assistant", "content": blocks})
        elif role == "assistant":
            out.append({"role": "assistant", "content": str(msg.get("content") or "")[:8000]})
        else:
            out.append({"role": "user", "content": str(msg.get("content") or "")[:8000]})
    return out


def _parse_openai(data: dict) -> dict:
    message = ((data.get("choices") or [{}])[0].get("message") or {})
    calls = []
    for call in message.get("tool_calls") or []:
        fn = call.get("function") or {}
        raw = fn.get("arguments") or "{}"
        try:
            args = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            args = {}
        calls.append({"id": call.get("id") or "call", "name": fn.get("name") or "", "arguments": args if isinstance(args, dict) else {}})
    return {"text": message.get("content") or "", "tool_calls": calls}


def _parse_anthropic(data: dict) -> dict:
    text = []
    calls = []
    for block in data.get("content") or []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            text.append(block.get("text") or "")
        elif block.get("type") == "tool_use":
            calls.append({"id": block.get("id") or "call", "name": block.get("name") or "", "arguments": block.get("input") or {}})
    return {"text": "\n".join(text), "tool_calls": calls}


def extract_json(text: str) -> dict | None:
    raw = (text or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(raw[start:end + 1])
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _scrub_obj(value, key: str):
    if isinstance(value, str):
        return value.replace(key, "") if key else value
    if isinstance(value, list):
        return [_scrub_obj(item, key) for item in value]
    if isinstance(value, dict):
        return {str(k): _scrub_obj(v, key) for k, v in value.items()}
    return value


_BANNED = (
    (r"void\s+main\s*\(", "Do not declare main."),
    (r"#\s*version\b", "Do not set a GLSL version."),
    (r"#\s*include\b", "Includes are not allowed."),
    (r"#\s*extension\b", "Extensions are not allowed."),
    (r"\b(eval|Function|document|window)\b", "JavaScript is not allowed."),
    (r"=>", "JavaScript is not allowed."),
)


def check_material(spec: dict) -> list[str]:
    import re
    errors = []
    if not isinstance(spec, dict):
        return ["The material spec has to be an object."]
    glsl = spec.get("glsl")
    if not isinstance(glsl, str) or not glsl.strip():
        errors.append("The GLSL snippet is empty.")
    else:
        for pattern, message in _BANNED:
            if re.search(pattern, glsl):
                errors.append(message)
    params = spec.get("params") if isinstance(spec.get("params"), list) else None
    if params is None:
        errors.append("params has to be a list.")
    else:
        allowed = {"float", "int", "bool", "color", "vec2", "vec3", "texture"}
        for param in params:
            if not isinstance(param, dict) or param.get("type") not in allowed:
                errors.append("A parameter has an unknown type.")
                break
    return errors


def _data_url(value: str) -> tuple[str, str] | None:
    if not isinstance(value, str) or not value.startswith("data:image/") or ";base64," not in value:
        return None
    header, data = value.split(";base64,", 1)
    mime = header[5:]
    if mime not in {"image/png", "image/jpeg", "image/webp"} or len(data) > 1_800_000:
        return None
    return mime, data


def material_user(provider: str, brief: str, images: list, previous) -> str | list:
    text = (
        "PROGRAMMABLE_MATERIAL\n"
        "Return one JSON object and nothing else. No markdown. No JavaScript.\n"
        "Keys: name, pbr {color, roughness, metalness, emissive, emissiveIntensity, opacity}, "
        "chibili {bands, shade, rim, soft}, params [{name, type, min, max, default, label}], "
        "states {name: {param: value}}, glsl.\n"
        "glsl is the body inside main. Assign mfAlbedo, mfRough, mfMetal, mfEmissive, and mfAlpha. "
        "Read uTime, mfUV, vN, vW, cameraPosition, and uP_<paramName>. Helpers: mfNoise(vec2), mfHash(vec2). "
        "Do not declare main, uniforms, or includes.\n"
        "Brief:\n" + brief[:4000]
    )
    if previous:
        text += "\nIterate from this current spec:\n" + json.dumps(previous)[:4000]
    packed = []
    for image in images[:4] if isinstance(images, list) else []:
        raw = image.get("data") if isinstance(image, dict) else image
        parsed = _data_url(raw)
        if parsed:
            packed.append(parsed)
    if not packed:
        return text
    if provider == "anthropic":
        blocks = [{"type": "text", "text": text}]
        for mime, data in packed:
            blocks.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}})
        return blocks
    parts = [{"type": "text", "text": text}]
    for mime, data in packed:
        parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}})
    return parts


def complete_text(provider: str, key: str, base: str, model: str, content) -> dict:
    headers = _auth_headers(provider, key)
    if provider == "anthropic":
        url = base.rstrip("/") + ("/messages" if base.rstrip("/").endswith("/v1") else "/v1/messages")
        body = {"model": model, "max_tokens": 1800, "messages": [{"role": "user", "content": content}]}
        status, raw = _http("POST", url, headers, body, timeout=40)
        parsed = _parse_anthropic(_json_body(raw))
    else:
        url = base.rstrip("/") + "/chat/completions"
        body = {"model": model, "messages": [{"role": "user", "content": content}]}
        status, raw = _http("POST", url, headers, body, timeout=40)
        parsed = _parse_openai(_json_body(raw))
    if status in (401, 403):
        raise PermissionError("invalid")
    if status >= 400:
        raise ConnectionError("network")
    parsed["text"] = _scrub(parsed.get("text") or "", key)
    return parsed


def complete(provider: str, key: str, base: str, model: str, messages: list, tools: list) -> dict:
    headers = _auth_headers(provider, key)
    if provider == "anthropic":
        url = base.rstrip("/") + ("/messages" if base.rstrip("/").endswith("/v1") else "/v1/messages")
        body = {
            "model": model,
            "max_tokens": 800,
            "messages": _anthropic_messages(messages),
            "tools": [{"name": t["name"], "description": t.get("description") or "", "input_schema": t.get("parameters") or {"type": "object", "properties": {}}} for t in tools],
        }
        status, raw = _http("POST", url, headers, body)
        parsed = _parse_anthropic(_json_body(raw))
    else:
        url = base.rstrip("/") + "/chat/completions"
        body = {"model": model, "messages": _openai_messages(messages), "tools": [{"type": "function", "function": {"name": t["name"], "description": t.get("description") or "", "parameters": t.get("parameters") or {"type": "object", "properties": {}}}} for t in tools]}
        status, raw = _http("POST", url, headers, body)
        parsed = _parse_openai(_json_body(raw))
    if status in (401, 403):
        raise PermissionError("invalid")
    if status >= 400:
        raise ConnectionError("network")
    parsed["text"] = _scrub(parsed.get("text") or "", key)
    return parsed


def _image_from(data: dict, key: str) -> str:
    item = ((data.get("data") or data.get("images") or [None])[0]) or {}
    if isinstance(item, str):
        return item if item.startswith("data:") else ""
    b64 = item.get("b64_json") or item.get("base64")
    if b64:
        return "data:image/png;base64," + _scrub(b64, key)
    return ""


@router.get("/providers")
def providers():
    return {"providers": [{"id": k, "models": v, "needsBase": k == "compatible"} for k, v in _SUGGESTED.items()]}


@router.post("/connect")
def connect(request: Request, body: dict = Body(...)):
    key = _key(request, "Provider")
    provider = str(body.get("provider") or "")
    if not key:
        return {"ok": False, "status": "invalid", "message": "Invalid key"}
    try:
        base = resolve_base(provider, body.get("base"))
        models = verify(provider, key, base)
    except PermissionError:
        return {"ok": False, "status": "invalid", "message": "Invalid key"}
    except ValueError as exc:
        return {"ok": False, "status": "invalid", "message": _scrub(str(exc), key)}
    except Exception:
        return {"ok": False, "status": "network", "message": "Network error"}
    return {"ok": True, "status": "connected", "message": "Connected", "models": models[:40]}


@router.post("/chat")
def chat(request: Request, body: dict = Body(...)):
    key = _key(request, "Provider")
    provider = str(body.get("provider") or "")
    if not key:
        return {"ok": False, "status": "invalid", "message": "Invalid key"}
    try:
        base = resolve_base(provider, body.get("base"))
        result = complete(provider, key, base, str(body.get("model") or ""), list(body.get("messages") or []), list(body.get("tools") or []))
    except PermissionError:
        return {"ok": False, "status": "invalid", "message": "Invalid key"}
    except Exception:
        return {"ok": False, "status": "network", "message": "Network error"}
    return {"ok": True, "status": "connected", **result}


@router.post("/image")
def image(request: Request, body: dict = Body(...)):
    """Paid image call. OpenAI and xAI only. The picture comes back as a data URL."""
    key = _key(request, "Provider")
    provider = str(body.get("provider") or "")
    if provider not in ("openai", "xai", "compatible"):
        return {"ok": False, "status": "unsupported", "message": "This provider has no image API in MeshForge. Use OpenAI, xAI, or an OpenAI-compatible image endpoint.", "spends": False}
    if not key:
        return {"ok": False, "status": "invalid", "message": "Invalid key", "spends": True}
    try:
        base = resolve_base(provider, body.get("base"))
        status, raw = _http("POST", base.rstrip("/") + "/images/generations", _auth_headers(provider, key), {"model": body.get("imageModel") or ("dall-e-3" if provider == "openai" else "grok-2-image"), "prompt": str(body.get("prompt") or "")[:2000], "n": 1, "size": "1024x1024"})
    except Exception:
        return {"ok": False, "status": "network", "message": "Network error", "spends": True}
    if status in (401, 403):
        return {"ok": False, "status": "invalid", "message": "Invalid key", "spends": True}
    if status >= 400:
        return {"ok": False, "status": "network", "message": "Network error", "spends": True}
    picture = _image_from(_json_body(raw), key)
    if not picture:
        return {"ok": False, "status": "network", "message": "The provider returned no image", "spends": True}
    return {"ok": True, "status": "connected", "image": picture, "spends": True, "message": "Image ready. This call spends API credit."}


@router.post("/views")
def views(request: Request, body: dict = Body(...)):
    """Optional paid step: four Gemini image calls, one per view. Uses the Google key only."""
    key = _key(request, "Google")
    if not key:
        return {"ok": False, "status": "invalid", "message": "Add a Google key for the multi-view step.", "spends": True}
    base = resolve_google(body.get("base"))
    prompt = str(body.get("prompt") or "object")[:1500]
    model = str(body.get("model") or "gemini-2.5-flash-image")
    images = []
    headers = {"x-goog-api-key": key, "content-type": "application/json"}
    for view in ("front", "back", "left", "right"):
        payload = {"contents": [{"parts": [{"text": f"Product photo, {view} view, plain background, of: {prompt}"}]}]}
        url = f"{base}/models/{model}:generateContent"
        try:
            status, raw = _http("POST", url, headers, payload, timeout=40)
        except Exception:
            return {"ok": False, "status": "network", "message": "Network error", "spends": True, "images": images}
        if status in (401, 403):
            return {"ok": False, "status": "invalid", "message": "Invalid key", "spends": True}
        if status >= 400:
            return {"ok": False, "status": "network", "message": "Network error", "spends": True, "images": images}
        data = _json_body(raw)
        picture = ""
        for cand in data.get("candidates") or []:
            for part in ((cand.get("content") or {}).get("parts") or []):
                inline = part.get("inlineData") or part.get("inline_data") or {}
                if inline.get("data"):
                    picture = "data:image/png;base64," + _scrub(inline["data"], key)
        if not picture and data.get("image"):
            picture = _image_from(data, key)
        if picture:
            images.append({"view": view, "image": picture})
    if len(images) < 4:
        return {"ok": False, "status": "network", "message": "The view step did not return four images", "spends": True, "images": images}
    return {"ok": True, "status": "connected", "images": images, "spends": True, "message": "Four views ready. This step made four paid Gemini image calls."}


@router.post("/script")
def script_edit(request: Request, body: dict = Body(...)):
    """Ask the connected provider for a replacement gameplay script. The key is not stored."""
    key = _key(request, "Provider")
    provider = str(body.get("provider") or "")
    if not key:
        return {"ok": False, "status": "invalid", "message": "No AI provider is connected. You can still edit the script by hand."}
    language = "GLSL" if str(body.get("language") or "") == "glsl" else "JavaScript"
    brief = str(body.get("brief") or "")
    source = str(body.get("source") or "")
    ask = (
        "Return JSON only, shaped {\"script\": \"...\"}. The script is "
        + language
        + ". Do not use eval, Function, fetch, the DOM, or the network. "
        + "Keep the lifecycle function names if they are already there. Brief: "
        + brief
        + "\nCurrent source:\n"
        + source[:8000]
    )
    try:
        base = resolve_base(provider, body.get("base"))
        model = str(body.get("model") or "") or ((_SUGGESTED.get(provider) or ["custom"])[0])
        result = complete_text(provider, key, base, model, ask)
    except PermissionError:
        return {"ok": False, "status": "invalid", "message": "Invalid key"}
    except ValueError as exc:
        return {"ok": False, "status": "invalid", "message": _scrub(str(exc), key)}
    except Exception:
        return {"ok": False, "status": "network", "message": "Network error"}
    spec = extract_json(result.get("text") or "")
    text = ""
    if isinstance(spec, dict):
        text = str(spec.get("script") or spec.get("source") or spec.get("glsl") or "")
    if not text:
        raw = result.get("text") or ""
        if "function " in raw or "mfAlbedo" in raw:
            text = raw
    text = _scrub(text, key)
    if not text.strip():
        return {"ok": False, "message": "The model did not return a script."}
    return {"ok": True, "script": text}


@router.post("/material")
def material(request: Request, body: dict = Body(...)):
    """Ask the connected provider for one programmable-material spec. The key is not stored."""
    key = _key(request, "Provider")
    provider = str(body.get("provider") or "")
    if not key:
        return {"ok": False, "status": "invalid", "message": "No AI provider is connected. Open the Agent tab and connect a provider. You can still edit the GLSL and the parameters by hand."}
    try:
        base = resolve_base(provider, body.get("base"))
        model = str(body.get("model") or "") or ((_SUGGESTED.get(provider) or ["custom"])[0])
        content = material_user(provider, str(body.get("brief") or ""), list(body.get("images") or []), body.get("previous"))
        result = complete_text(provider, key, base, model, content)
    except PermissionError:
        return {"ok": False, "status": "invalid", "message": "Invalid key"}
    except ValueError as exc:
        return {"ok": False, "status": "invalid", "message": _scrub(str(exc), key)}
    except Exception:
        return {"ok": False, "status": "network", "message": "Network error"}
    spec = extract_json(result.get("text") or "")
    if not spec:
        return {"ok": False, "message": "The model did not return a material spec."}
    spec = _scrub_obj(spec, key)
    errors = check_material(spec)
    if errors:
        return {"ok": False, "message": errors[0], "errors": errors}
    return {"ok": True, "spec": spec}
