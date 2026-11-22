#!/usr/bin/env python3
"""Gemini-protocol bridge for the Harbor benchmark.

Serves the Google ``generateContent`` surface that Gemini CLI speaks
(``GOOGLE_GEMINI_BASE_URL``) and translates every request to the
OpenAI-compatible chat-completions endpoint behind it (Z.ai Coding). No
dependencies beyond the standard library. Run ``--selftest`` for translator
unit checks; the runner preflights a live round trip before starting Harbor.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

UPSTREAM_BASE = os.environ.get("BRIDGE_UPSTREAM", "https://api.z.ai/api/coding/paas/v4")
UPSTREAM_MODEL = os.environ.get("BRIDGE_MODEL", "glm-5.3-flash")
DEFAULT_EFFORT = os.environ.get("BRIDGE_DEFAULT_EFFORT", "low")
READ_TIMEOUT = float(os.environ.get("BRIDGE_READ_TIMEOUT", "600"))
# Prefer BRIDGE_API_KEY; ZAI_API_KEY is the historical name from the Z.ai runs.
API_KEY = os.environ.get("BRIDGE_API_KEY") or os.environ.get("ZAI_API_KEY", "")

_FINISH_REASONS = {
    "stop": "STOP",
    "length": "MAX_TOKENS",
    "content_filter": "SAFETY",
    "tool_calls": "STOP",
}


def _api_key() -> str:
    if not API_KEY:
        raise SystemExit("BRIDGE_API_KEY or ZAI_API_KEY is required")
    return API_KEY


def _parts_text(blob) -> str:
    """Joined text of a contents/systemInstruction style {role, parts} blob."""
    if isinstance(blob, str):
        return blob
    if not isinstance(blob, dict):
        return ""
    parts = blob.get("parts") or []
    texts = [p.get("text", "") for p in parts if isinstance(p, dict) and "text" in p]
    return "".join(t for t in texts if isinstance(t, str))


def _normalize_schema(node):
    """Gemini/OpenAPI schema -> OpenAI JSON Schema (lowercase type names)."""
    if isinstance(node, list):
        return [_normalize_schema(item) for item in node]
    if not isinstance(node, dict):
        return node
    out = {}
    for key, value in node.items():
        if key == "type" and isinstance(value, str):
            out[key] = value.lower()
        elif key in ("propertyOrdering",):
            continue
        else:
            out[key] = _normalize_schema(value)
    return out


def gemini_request_to_chat(body: dict) -> dict:
    """Translate a generateContent body to a chat-completions payload."""
    messages = []
    system = _parts_text(body.get("systemInstruction"))
    if system:
        messages.append({"role": "system", "content": system})

    tool_call_seq = 0
    open_calls: list[str] = []  # synthesized ids awaiting function responses

    def next_call_id():
        nonlocal tool_call_seq
        call_id = f"call_{tool_call_seq}"
        tool_call_seq += 1
        open_calls.append(call_id)
        return call_id

    for content in body.get("contents") or []:
        if not isinstance(content, dict):
            continue
        role = "model" if content.get("role") == "model" else "user"
        texts: list = []
        calls = []
        responses = []
        for part in content.get("parts") or []:
            if not isinstance(part, dict) or part.get("thought"):
                continue
            if "text" in part:
                texts.append(part["text"])
            elif "functionCall" in part:
                call = part.get("functionCall") or {}
                calls.append(
                    {
                        "id": next_call_id(),
                        "type": "function",
                        "function": {
                            "name": call.get("name", ""),
                            "arguments": json.dumps(call.get("args") or {}),
                        },
                    }
                )
            elif "functionResponse" in part:
                response = part.get("functionResponse") or {}
                call_id = open_calls.pop(0) if open_calls else next_call_id()
                responses.append(
                    {
                        "role": "tool",
                        "tool_call_id": call_id,
                        "name": response.get("name", ""),
                        "content": json.dumps(response.get("response") or {}),
                    }
                )
            elif "inlineData" in part:
                data = part.get("inlineData") or {}
                texts.append(
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "data:%s;base64,%s"
                            % (data.get("mimeType", "image/png"), data.get("data", ""))
                        },
                    }
                )
        if role == "model":
            text_content = "".join(t for t in texts if isinstance(t, str)) or None
            message = {"role": "assistant", "content": text_content}
            if calls:
                message["tool_calls"] = calls
            if text_content or calls:
                messages.append(message)
        else:
            for response in responses:
                messages.append(response)
            user_parts = [
                {"type": "text", "text": t} if isinstance(t, str) else t
                for t in texts
                if not (isinstance(t, str) and not t)
            ]
            if user_parts:
                if len(user_parts) == 1 and user_parts[0].get("type") == "text":
                    messages.append({"role": "user", "content": user_parts[0]["text"]})
                else:
                    messages.append({"role": "user", "content": user_parts})

    payload: dict = {"model": UPSTREAM_MODEL, "messages": messages}

    tools = []
    for tool in body.get("tools") or []:
        if not isinstance(tool, dict):
            continue
        for declaration in tool.get("functionDeclarations") or []:
            if not isinstance(declaration, dict):
                continue
            entry = {"type": "function", "function": {"name": declaration.get("name", "")}}
            if declaration.get("description"):
                entry["function"]["description"] = declaration["description"]
            parameters = declaration.get("parameters")
            if parameters is None:
                # Newer Gemini CLI sends ready-made JSON Schema under this key.
                parameters = declaration.get("parametersJsonSchema")
            if parameters is not None:
                entry["function"]["parameters"] = _normalize_schema(parameters)
            tools.append(entry)
    if tools:
        payload["tools"] = tools

    config = body.get("generationConfig") or {}
    if not isinstance(config, dict):
        config = {}
    if "temperature" in config:
        payload["temperature"] = config["temperature"]
    if "topP" in config:
        payload["top_p"] = config["topP"]
    if "maxOutputTokens" in config:
        payload["max_tokens"] = config["maxOutputTokens"]
    if config.get("stopSequences"):
        payload["stop"] = config["stopSequences"]
    if config.get("responseMimeType") == "application/json":
        payload["response_format"] = {"type": "json_object"}

    effort = DEFAULT_EFFORT
    thinking = config.get("thinkingConfig") or {}
    level = thinking.get("thinkingLevel") if isinstance(thinking, dict) else None
    if isinstance(level, str) and level.lower() in ("minimal", "low", "medium", "high"):
        effort = "low" if level.lower() == "minimal" else level.lower()
    if effort:  # empty BRIDGE_DEFAULT_EFFORT omits the parameter entirely
        payload["reasoning_effort"] = effort
    return payload


def _usage_metadata(usage: dict | None) -> dict:
    usage = usage or {}
    prompt = usage.get("prompt_tokens", 0)
    completion = usage.get("completion_tokens", 0)
    details = usage.get("prompt_tokens_details") or {}
    completion_details = usage.get("completion_tokens_details") or {}
    return {
        "promptTokenCount": prompt,
        "cachedContentTokenCount": details.get("cached_tokens", 0),
        "candidatesTokenCount": completion,
        "thoughtsTokenCount": completion_details.get("reasoning_tokens", 0),
        "totalTokenCount": usage.get("total_tokens", prompt + completion),
    }


def _message_parts(message: dict) -> list[dict]:
    parts = []
    content = message.get("content")
    if isinstance(content, str) and content:
        parts.append({"text": content})
    elif isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text" and item.get("text"):
                parts.append({"text": item["text"]})
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        try:
            args = json.loads(function.get("arguments") or "{}")
        except (TypeError, ValueError):
            args = {}
        parts.append({"functionCall": {"name": function.get("name", ""), "args": args}})
    return parts or [{"text": ""}]


def chat_response_to_gemini(data: dict, model: str) -> dict:
    choices = data.get("choices") or [{}]
    message = choices[0].get("message") or {}
    return {
        "candidates": [
            {
                "content": {"role": "model", "parts": _message_parts(message)},
                "finishReason": _FINISH_REASONS.get(choices[0].get("finish_reason"), "STOP"),
                "index": 0,
            }
        ],
        "usageMetadata": _usage_metadata(data.get("usage")),
        "modelVersion": data.get("model", model),
    }


class _StreamState:
    """Accumulates chat SSE chunks into Gemini stream events."""

    def __init__(self, model: str):
        self.model = model
        self.tool_buffers: dict[int, dict] = {}

    def feed(self, chunk: dict) -> dict | None:
        choices = chunk.get("choices") or []
        choice = choices[0] if choices else {}
        delta = choice.get("delta") or {}
        parts = []
        text = delta.get("content")
        if isinstance(text, str) and text:
            parts.append({"text": text})
        elif isinstance(text, list):
            # Some OpenAI-compatible providers (e.g. Mistral with reasoning on)
            # stream typed content parts; keep text parts, skip thinking.
            for item in text:
                if isinstance(item, dict) and item.get("type") == "text" and item.get("text"):
                    parts.append({"text": item["text"]})
        for call in delta.get("tool_calls") or []:
            index = call.get("index", 0)
            buffer = self.tool_buffers.setdefault(index, {"name": "", "arguments": ""})
            function = call.get("function") or {}
            if function.get("name"):
                buffer["name"] += function["name"]
            if function.get("arguments"):
                buffer["arguments"] += function["arguments"]

        finish = choice.get("finish_reason")
        # Z.ai sends a final chunk with an empty delta carrying finish_reason
        # and usage; emit it even when no text arrived in this chunk.
        if finish or chunk.get("usage"):
            candidate = {"content": {"role": "model", "parts": parts}, "index": 0}
            if finish:
                candidate["finishReason"] = _FINISH_REASONS.get(finish, "STOP")
            if finish:
                for index in sorted(self.tool_buffers):
                    buffer = self.tool_buffers.pop(index)
                    try:
                        args = json.loads(buffer["arguments"] or "{}")
                    except (TypeError, ValueError):
                        args = {}
                    candidate["content"]["parts"].append(
                        {"functionCall": {"name": buffer["name"], "args": args}}
                    )
            if not candidate["content"]["parts"]:
                candidate["content"]["parts"] = [{"text": ""}]
            event = {"candidates": [candidate]}
            if chunk.get("usage"):
                event["usageMetadata"] = _usage_metadata(chunk["usage"])
                event["modelVersion"] = chunk.get("model", self.model)
            return event
        if parts:
            return {"candidates": [{"content": {"role": "model", "parts": parts}, "index": 0}]}
        return None

    def final_event(self) -> dict | None:
        if not self.tool_buffers:
            return None
        parts = []
        for index in sorted(self.tool_buffers):
            buffer = self.tool_buffers.pop(index)
            try:
                args = json.loads(buffer["arguments"] or "{}")
            except (TypeError, ValueError):
                args = {}
            parts.append({"functionCall": {"name": buffer["name"], "args": args}})
        return {
            "candidates": [
                {"content": {"role": "model", "parts": parts}, "index": 0, "finishReason": "STOP"}
            ]
        }


class BridgeHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "haze-gemini-bridge/1.0"

    def _debug(self, label: str, payload):
        path = os.environ.get("BRIDGE_DEBUG")
        if not path:
            return
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("=== %s\n%s\n" % (label, json.dumps(payload)[:2000000]))
            handle.flush()

    def log_message(self, fmt, *args):  # one compact line per request
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stderr.flush()

    def _authorized(self) -> bool:
        if not os.environ.get("BRIDGE_KEY"):
            return True
        key = self.headers.get("x-goog-api-key") or urllib.parse.parse_qs(
            urllib.parse.urlparse(self.path).query
        ).get("key", [""])[0]
        return key == os.environ["BRIDGE_KEY"]

    def _send_json(self, status: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str):
        self._send_json(status, {"error": {"code": status, "message": message, "status": "INTERNAL"}})

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("/health", "/healthz"):
            return self._send_json(200, {"status": "ok"})
        if not self._authorized():
            return self._error(401, "invalid api key")
        if parsed.path.rstrip("/").endswith("/models"):
            return self._send_json(200, self._models_payload())
        if ":countTokens" not in parsed.path and "/models/" in parsed.path:
            name = parsed.path.rstrip("/").rsplit("/", 1)[-1]
            for model in self._models_payload()["models"]:
                if model["name"] == "models/" + name:
                    return self._send_json(200, model)
            return self._error(404, "model not found: " + name)
        return self._error(404, "unsupported path " + parsed.path)

    @staticmethod
    def _models_payload() -> dict:
        return {
            "models": [
                {
                    "name": "models/" + UPSTREAM_MODEL,
                    "displayName": UPSTREAM_MODEL,
                    "inputTokenLimit": 131072,
                    "outputTokenLimit": 65536,
                    "supportedGenerationMethods": ["generateContent", "countTokens"],
                }
            ]
        }

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not self._authorized():
            return self._error(401, "invalid api key")
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            return self._error(400, "invalid JSON body: %s" % exc)
        if parsed.path.endswith(":countTokens"):
            return self._send_json(200, {"totalTokens": max(1, length // 4)})
        if parsed.path.endswith(":generateContent"):
            return self._relay(body, stream=False)
        if parsed.path.endswith(":streamGenerateContent"):
            return self._relay(body, stream=True)
        return self._error(404, "unsupported path " + parsed.path)

    def _relay(self, body: dict, stream: bool):
        self._debug("gemini-body", body)
        payload = gemini_request_to_chat(body)
        payload["stream"] = stream
        self._debug("request", payload)
        started = time.monotonic()
        request = urllib.request.Request(
            UPSTREAM_BASE.rstrip("/") + "/chat/completions",
            data=json.dumps(payload).encode(),
            headers={
                "Authorization": "Bearer " + _api_key(),
                "Content-Type": "application/json",
                "Accept": "text/event-stream" if stream else "application/json",
            },
            method="POST",
        )
        try:
            upstream = urllib.request.urlopen(request, timeout=READ_TIMEOUT)
        except urllib.error.HTTPError as exc:
            detail = exc.read(400).decode(errors="replace")
            self.log_message(
                "upstream %s %s in %.1fs; payload head: %.600s",
                exc.code, detail[:120], time.monotonic() - started,
                json.dumps(payload),
            )
            return self._error(502, "upstream error %s: %s" % (exc.code, detail))
        except (urllib.error.URLError, OSError) as exc:
            self.log_message("upstream connect failed in %.1fs: %s", time.monotonic() - started, exc)
            return self._error(502, "upstream unreachable: %s" % exc)
        try:
            if stream:
                self._relay_stream(upstream)
            else:
                data = json.loads(upstream.read() or b"{}")
                self._send_json(200, chat_response_to_gemini(data, UPSTREAM_MODEL))
        except (BrokenPipeError, ConnectionResetError):
            self.log_message("client disconnected after %.1fs", time.monotonic() - started)
        finally:
            upstream.close()
        self.log_message("relayed stream=%s in %.1fs", stream, time.monotonic() - started)

    def _relay_stream(self, upstream):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        state = _StreamState(UPSTREAM_MODEL)

        def emit(event: dict | None):
            if event is None:
                return
            data = b"data: " + json.dumps(event, separators=(",", ":")).encode() + b"\r\n\r\n"
            self.wfile.write(("%X\r\n" % len(data)).encode() + data + b"\r\n")
            self.wfile.flush()

        for raw in upstream:
            line = raw.strip()
            if not line.startswith(b"data:"):
                continue
            piece = line[5:].strip()
            if piece == b"[DONE]":
                break
            try:
                chunk = json.loads(piece)
            except (ValueError, json.JSONDecodeError):
                continue
            self._debug("chunk", chunk)
            emit(state.feed(chunk))
        emit(state.final_event())
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()


class BridgeServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def _selftest() -> int:
    request = {
        "systemInstruction": {"parts": [{"text": "be brief"}]},
        "contents": [
            {"role": "user", "parts": [{"text": "hi"}, {"text": "there"}]},
            {
                "role": "model",
                "parts": [{"functionCall": {"name": "shell", "args": {"cmd": "ls"}}}],
            },
            {
                "role": "user",
                "parts": [
                    {"functionResponse": {"name": "shell", "response": {"output": "a\nb"}}},
                    {"text": "continue"},
                ],
            },
        ],
        "tools": [
            {
                "functionDeclarations": [
                    {
                        "name": "shell",
                        "parameters": {"type": "OBJECT", "properties": {"cmd": {"type": "STRING"}}},
                    },
                    {
                        "name": "shell_json",
                        "parametersJsonSchema": {"type": "object", "properties": {"cmd": {"type": "string"}}},
                    },
                ]
            }
        ],
        "generationConfig": {"thinkingConfig": {"thinkingLevel": "LOW"}, "temperature": 0.2},
    }
    chat = gemini_request_to_chat(request)
    roles = [m["role"] for m in chat["messages"]]
    assert roles == ["system", "user", "assistant", "tool", "user"], roles
    assert chat["messages"][0]["content"] == "be brief"
    assert chat["messages"][1]["content"] == [
        {"type": "text", "text": "hi"},
        {"type": "text", "text": "there"},
    ], chat["messages"][1]["content"]
    assert chat["messages"][4]["content"] == "continue"
    assert chat["messages"][2]["tool_calls"][0]["id"] == chat["messages"][3]["tool_call_id"]
    assert chat["tools"][0]["function"]["parameters"]["type"] == "object"
    assert chat["tools"][0]["function"]["parameters"]["properties"]["cmd"]["type"] == "string"
    assert chat["tools"][1]["function"]["parameters"]["properties"]["cmd"]["type"] == "string"
    assert chat["reasoning_effort"] == "low" and chat["temperature"] == 0.2

    gemini = chat_response_to_gemini(
        {
            "choices": [
                {"message": {"content": "done", "tool_calls": [
                    {"function": {"name": "shell", "arguments": "{\"cmd\":\"pwd\"}"}}
                ]}, "finish_reason": "tool_calls"}
            ],
            "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
                      "prompt_tokens_details": {"cached_tokens": 4}},
        },
        "glm-5.3-flash",
    )
    parts = gemini["candidates"][0]["content"]["parts"]
    assert parts[0] == {"text": "done"} and parts[1]["functionCall"]["args"] == {"cmd": "pwd"}
    assert gemini["candidates"][0]["finishReason"] == "STOP"
    assert gemini["usageMetadata"]["cachedContentTokenCount"] == 4

    state = _StreamState("m")
    first = state.feed({"choices": [{"delta": {"tool_calls": [
        {"index": 0, "function": {"name": "sh", "arguments": "{\"c"}}]}}]})
    assert first is None  # tool deltas buffered until finish
    last = state.feed({"choices": [{"delta": {"content": "ok", "tool_calls": [
        {"index": 0, "function": {"arguments": "md\": \"pwd\"}"}}]}, "finish_reason": "tool_calls"}],
        "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}})
    parts = last["candidates"][0]["content"]["parts"]
    assert parts[0] == {"text": "ok"}
    assert parts[1]["functionCall"] == {"name": "sh", "args": {"cmd": "pwd"}}, parts[1]
    assert last["candidates"][0]["finishReason"] == "STOP"
    assert last["usageMetadata"]["totalTokenCount"] == 5
    assert not state.tool_buffers, state.tool_buffers

    # Empty-delta finish chunk still carries finishReason and usage.
    tail = state.feed({"choices": [{"delta": {"role": "assistant", "content": ""}, "finish_reason": "stop"}],
                       "usage": {"prompt_tokens": 9, "completion_tokens": 1, "total_tokens": 10}})
    assert tail["candidates"][0]["finishReason"] == "STOP"
    assert tail["usageMetadata"]["totalTokenCount"] == 10

    # Typed content-part deltas (Mistral-style): text parts kept, thinking skipped.
    typed = _StreamState("m")
    event = typed.feed({"choices": [{"delta": {"content": [
        {"type": "thinking", "thinking": [{"type": "text", "text": "hmm"}]},
        {"type": "text", "text": "hello"},
    ]}}]})
    assert event and event["candidates"][0]["content"]["parts"] == [{"text": "hello"}]
    print("selftest ok")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    if args.selftest:
        return _selftest()
    _api_key()  # fail fast when missing
    server = BridgeServer((args.host, args.port), BridgeHandler)
    print("listening on %s:%d upstream=%s model=%s" %
          (args.host, server.server_address[1], UPSTREAM_BASE, UPSTREAM_MODEL), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    raise SystemExit(main())
