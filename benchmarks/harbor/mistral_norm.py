#!/usr/bin/env python3
"""Chat-completions normalizer for the Mistral Vibe endpoint.

mistral-large-4 returns message content as typed part arrays with inline
thinking blocks, which LiteLLM and several OpenAI-format clients cannot
parse. This stdlib-only relay forwards /v1/chat/completions (and /v1/models)
to the Mistral API and rewrites responses: text parts become a plain string
``content`` and thinking parts become ``reasoning_content``. The incoming
Authorization header is relayed unchanged, so no key handling is needed.
"""
from __future__ import annotations

import argparse
import json
import os
import socketserver
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

UPSTREAM_BASE = os.environ.get("NORM_UPSTREAM", "https://api.mistral.ai/v1")
READ_TIMEOUT = float(os.environ.get("NORM_READ_TIMEOUT", "600"))

# Mistral's chat endpoint rejects unknown body fields (extra=forbidden), and
# translating frontends (e.g. LiteLLM) inject extras like web_search_options.
_ALLOWED_FIELDS = frozenset({
    "model", "messages", "temperature", "top_p", "max_tokens",
    "max_completion_tokens", "stream", "stream_options", "stop",
    "presence_penalty", "frequency_penalty", "tools", "tool_choice",
    "response_format", "seed", "user", "parallel_tool_calls", "logprobs",
    "top_logprobs", "n", "reasoning_effort", "safe_prompt", "metadata",
})


def _sanitize_messages(messages) -> list:
    """Drop null content and null fields inside messages (strict upstream)."""
    cleaned = []
    for message in messages:
        if not isinstance(message, dict):
            cleaned.append(message)
            continue
        item = {k: v for k, v in message.items() if v is not None}
        cleaned.append(item)
    return cleaned


def sanitize_request(body: dict) -> dict:
    dropped = [key for key in body if key not in _ALLOWED_FIELDS or body[key] is None]
    if dropped:
        sys.stderr.write("dropped request fields: %s\n" % ", ".join(sorted(dropped)))
        sys.stderr.flush()
    cleaned = {key: value for key, value in body.items() if key in _ALLOWED_FIELDS and body[key] is not None}
    if isinstance(cleaned.get("messages"), list):
        cleaned["messages"] = _sanitize_messages(cleaned["messages"])
    return cleaned


def _flatten(parts) -> tuple[str, str]:
    """Split a typed content-part list into (text, thinking) strings."""
    text_bits, think_bits = [], []
    for part in parts:
        if not isinstance(part, dict):
            continue
        if part.get("type") == "text" and isinstance(part.get("text"), str):
            text_bits.append(part["text"])
        elif part.get("type") == "thinking":
            for chunk in part.get("thinking") or []:
                if isinstance(chunk, dict) and isinstance(chunk.get("text"), str):
                    think_bits.append(chunk["text"])
        elif isinstance(part.get("text"), str):
            text_bits.append(part["text"])
    return "".join(text_bits), "".join(think_bits)


def normalize_message(message: dict) -> dict:
    content = message.get("content")
    if isinstance(content, list):
        text, thinking = _flatten(content)
        message["content"] = text
        if thinking:
            message["reasoning_content"] = thinking
    return message


def normalize_stream_chunk(chunk: dict) -> list[dict]:
    """Rewrite one SSE chunk; may yield zero, one or two chunks."""
    out = []
    choices = chunk.get("choices") or []
    if choices:
        delta = choices[0].get("delta") or {}
        content = delta.get("content")
        if isinstance(content, list):
            text, thinking = _flatten(content)
            delta.pop("content", None)
            if thinking:
                revised = json.loads(json.dumps(chunk))
                (revised["choices"][0]["delta"])["reasoning_content"] = thinking
                out.append(revised)
            if text:
                revised = json.loads(json.dumps(chunk))
                (revised["choices"][0]["delta"])["content"] = text
                out.append(revised)
            if not out and (choices[0].get("finish_reason") or chunk.get("usage")):
                revised = json.loads(json.dumps(chunk))
                (revised["choices"][0]["delta"]).pop("content", None)
                out.append(revised)
            return out
        if content is None and "content" in delta and not (
            choices[0].get("finish_reason") or chunk.get("usage")
        ):
            # Empty-array deltas carry no signal; drop them entirely.
            return out
    return [chunk]


class NormHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "haze-mistral-norm/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))
        sys.stderr.flush()

    def _send_json(self, status: int, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _relay_headers(self):
        headers = {"Content-Type": "application/json"}
        # NORM_API_KEY pins upstream auth regardless of what the client sent
        # (agents differ in how they pass keys to custom endpoints).
        pinned = os.environ.get("NORM_API_KEY")
        if pinned:
            headers["Authorization"] = "Bearer " + pinned
        else:
            auth = self.headers.get("Authorization")
            if auth:
                headers["Authorization"] = auth
        accept = self.headers.get("Accept")
        if accept:
            headers["Accept"] = accept
        return headers

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            request = urllib.request.Request(
                UPSTREAM_BASE.rstrip("/") + "/models", headers=self._relay_headers()
            )
            try:
                with urllib.request.urlopen(request, timeout=READ_TIMEOUT) as upstream:
                    self._send_json(200, json.loads(upstream.read() or b"{}"))
            except urllib.error.HTTPError as exc:
                self._send_json(exc.code, {"error": exc.read(300).decode(errors="replace")})
            return
        self._send_json(404, {"error": "unsupported path " + self.path})

    def _persist_error(self, code: int, detail: str, body: dict):
        """Keep the last upstream error and offending request for debugging
        beyond the runner's temp-file cleanup."""
        try:
            with open("/tmp/mistral-norm-last-error.log", "a", encoding="utf-8") as handle:
                handle.write("=== upstream %d\n%s\n=== request\n%s\n\n" % (
                    code, detail, json.dumps(body)[:4000]))
        except OSError:
            pass

    def do_POST(self):
        if not self.path.rstrip("/").endswith("/chat/completions"):
            return self._send_json(404, {"error": "unsupported path " + self.path})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError) as exc:
            return self._send_json(400, {"error": "invalid JSON: %s" % exc})
        body = sanitize_request(body)
        stream = bool(body.get("stream"))
        debug_path = os.environ.get("NORM_DEBUG")
        if debug_path:
            with open(debug_path, "a", encoding="utf-8") as handle:
                handle.write("=== request\n%s\n=== stream=%s\n" % (json.dumps(body)[:100000], stream))
        started = time.monotonic()
        request = urllib.request.Request(
            UPSTREAM_BASE.rstrip("/") + "/chat/completions",
            data=json.dumps(body).encode(),
            headers=self._relay_headers(),
            method="POST",
        )
        try:
            upstream = urllib.request.urlopen(request, timeout=READ_TIMEOUT)
        except urllib.error.HTTPError as exc:
            detail = exc.read(2000).decode(errors="replace")
            self.log_message("upstream %s %s", exc.code, detail[:120])
            self._persist_error(exc.code, detail, body)
            return self._send_json(exc.code, {"error": detail})
        except (urllib.error.URLError, OSError) as exc:
            return self._send_json(502, {"error": "upstream unreachable: %s" % exc})
        try:
            if not stream:
                data = json.loads(upstream.read() or b"{}")
                for choice in data.get("choices") or []:
                    if isinstance(choice.get("message"), dict):
                        choice["message"] = normalize_message(choice["message"])
                self._send_json(200, data)
            else:
                self._relay_stream(upstream)
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

        def emit(payload: dict):
            data = b"data: " + json.dumps(payload, separators=(",", ":")).encode() + b"\r\n\r\n"
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
            debug_path = os.environ.get("NORM_DEBUG")
            if debug_path:
                with open(debug_path, "a", encoding="utf-8") as handle:
                    handle.write("=== upstream chunk\n%s\n" % json.dumps(chunk)[:4000])
            for revised in normalize_stream_chunk(chunk):
                emit(revised)
        # [DONE] must ride inside a chunk; a bare event breaks chunked framing.
        done = b"data: [DONE]\r\n\r\n"
        self.wfile.write(("%X\r\n" % len(done)).encode() + done + b"\r\n")
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()


class NormServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    allow_reuse_address = False


def _selftest() -> int:
    message = normalize_message({
        "role": "assistant",
        "content": [
            {"type": "thinking", "thinking": [{"type": "text", "text": "think "}, {"type": "text", "text": "hard"}]},
            {"type": "text", "text": "OK"},
        ],
    })
    assert message["content"] == "OK" and message["reasoning_content"] == "think hard", message

    plain = normalize_message({"role": "assistant", "content": "fine"})
    assert plain["content"] == "fine" and "reasoning_content" not in plain

    chunks = normalize_stream_chunk({"choices": [{"delta": {"content": [
        {"type": "thinking", "thinking": [{"type": "text", "text": "hmm"}]},
        {"type": "text", "text": "hi"},
    ]}}]})
    assert len(chunks) == 2, chunks
    assert chunks[0]["choices"][0]["delta"]["reasoning_content"] == "hmm"
    assert chunks[1]["choices"][0]["delta"]["content"] == "hi"

    finish = normalize_stream_chunk({"choices": [{"delta": {"content": []}, "finish_reason": "stop"}],
                                     "usage": {"total_tokens": 5}})
    assert len(finish) == 1 and finish[0]["choices"][0]["finish_reason"] == "stop"
    untouched = normalize_stream_chunk({"choices": [{"delta": {"content": "plain"}, "finish_reason": None}]})
    assert untouched[0]["choices"][0]["delta"]["content"] == "plain"

    cleaned = sanitize_request({"model": "m", "messages": [], "web_search_options": {},
                                "prompt_cache_key": "x", "stream": True})
    assert set(cleaned) == {"model", "messages", "stream"}, cleaned
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
    server = NormServer((args.host, args.port), NormHandler)
    print("listening on %s:%d upstream=%s" %
          (args.host, server.server_address[1], UPSTREAM_BASE), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    raise SystemExit(main())
