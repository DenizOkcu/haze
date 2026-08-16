"""Harbor agent adapter for haze (https://www.npmjs.com/package/@denizokcu/haze).

Runs the `@denizokcu/haze` CLI inside the task container in print mode:

    haze -p "<instruction>" --model <provider>:<model> \
        --output stream-json --no-session

Configuration (provider + API key) is injected as a generated
`~/.haze/settings.json` so the benchmark never depends on host state. The
NDJSON stream (message_end steps + final result envelope) is converted into
an ATIF trajectory.

Usage with the harbor CLI:

    PYTHONPATH=benchmarks/harbor/agents harbor run \
        --agent haze_agent:HazeAgent \
        --model <model-id> \
        --env-file <private-env-file-with-HAZE_BASE_URL-and-HAZE_API_KEY> \
        ...
"""

from __future__ import annotations

import json
import re
import shlex
import time
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.base import (
    BaseInstalledAgent,
    with_prompt_template,
)
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from harbor.utils.trajectory_utils import format_trajectory_json

_OUTPUT_LOG = "haze-output.ndjson"
_STDERR_LOG = "haze-stderr.log"
_PROVIDER_NAME = "benchmark"


class HazeAgent(BaseInstalledAgent):
    """haze (print mode, stream-json output)."""

    SUPPORTS_ATIF: bool = True
    SUPPORTS_RESUME: bool = False

    DEFAULT_MODEL = "glm-5.2"

    @staticmethod
    @override
    def name() -> str:
        return "haze"

    @override
    def get_version_command(self) -> str | None:
        return ". ~/.nvm/nvm.sh; haze --version"

    @override
    def parse_version(self, stdout: str) -> str:
        match = re.search(r"(\d+\.\d+\.\d+)", stdout)
        return match.group(1) if match else stdout.strip()

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        await self.exec_as_root(
            environment,
            command="apt-get update && apt-get install -y curl bash procps",
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        # A local tarball (mounted into the container, e.g. via harbor --mounts)
        # takes precedence over the npm registry — used to benchmark uncommitted
        # local builds.
        local_tarball = (self._get_env("HAZE_LOCAL_TARBALL") or "").strip()
        if local_tarball:
            install_spec = local_tarball
        elif self._version:
            install_spec = f"@denizokcu/haze@{self._version}"
        else:
            install_spec = "@denizokcu/haze@latest"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"npm install -g {install_spec} && "
                "haze --version"
            ),
        )

    def _build_config_install_command(self) -> str:
        """Write a settings.json built from HAZE_* environment values.

        Required env (host, preferably loaded with Harbor --env-file):
          HAZE_API_KEY   API key for the OpenAI-compatible provider
          HAZE_BASE_URL  Base URL of the OpenAI-compatible provider
        """
        api_key = (self._get_env("HAZE_API_KEY") or "").strip()
        base_url = (self._get_env("HAZE_BASE_URL") or "").strip()
        if not api_key:
            raise RuntimeError(
                "HAZE_API_KEY is not set. Load it with Harbor --env-file."
            )
        if not base_url:
            raise RuntimeError(
                "HAZE_BASE_URL is not set. Load it with Harbor --env-file."
            )

        model = self.model_name or self.DEFAULT_MODEL
        config = {
            "providers": [
                {
                    "name": _PROVIDER_NAME,
                    "url": base_url.rstrip("/"),
                    "key": api_key,
                    "models": [model],
                }
            ]
        }
        config_json = json.dumps(config)
        return (
            "mkdir -p \"$HOME/.haze\" && "
            f"echo {shlex.quote(config_json)} > \"$HOME/.haze/settings.json\""
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        model = self.model_name or self.DEFAULT_MODEL

        # Bound the whole logical goal (goal supervisor spans continuation
        # turns; without a deadline it runs "while progress" and the harness
        # SIGKILLs the process). Default stays just under Harbor's typical
        # 15-minute agent timeout; override with --ae HAZE_TIMEOUT=...
        timeout = (self._get_env("HAZE_TIMEOUT") or "13m").strip()
        # stream-json is diagnostic by default; use HAZE_OUTPUT=json for the
        # lowest-overhead final performance run while retaining the result envelope.
        output_mode = (self._get_env("HAZE_OUTPUT") or "stream-json").strip()
        if output_mode not in {"json", "stream-json"}:
            raise RuntimeError("HAZE_OUTPUT must be 'json' or 'stream-json'.")

        config_command = self._build_config_install_command()
        await self.exec_as_agent(environment, command=config_command)

        command = (
            ". ~/.nvm/nvm.sh; "
            "cd /app && "
            f"haze -p {shlex.quote(instruction)} "
            f"--model {shlex.quote(f'{_PROVIDER_NAME}:{model}')} "
            f"--output {output_mode} "
            "--no-session "
            f"--timeout {shlex.quote(timeout)} "
            f"> /logs/agent/{_OUTPUT_LOG} "
            f"2> /logs/agent/{_STDERR_LOG}"
        )
        try:
            await self.exec_as_agent(environment, command=command)
        finally:
            # Redact the API key from the copied settings for debugging.
            try:
                await self.exec_as_agent(
                    environment,
                    command=(
                        "sed 's/\"key\": \".*\"/\"key\": \"<redacted>\"/' "
                        "\"$HOME/.haze/settings.json\" > "
                        "/logs/agent/haze-config-redacted.json 2>/dev/null || true"
                    ),
                )
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Trajectory conversion
    # ------------------------------------------------------------------

    def _load_events(self) -> list[dict[str, Any]]:
        path = self.logs_dir / _OUTPUT_LOG
        if not path.exists():
            return []
        events: list[dict[str, Any]] = []
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return events

    @staticmethod
    def _summed_usage(events: list[dict[str, Any]]) -> dict[str, int]:
        totals = {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
        }
        for event in events:
            if event.get("type") != "step_end":
                continue
            usage = event.get("usage") or {}
            for key in totals:
                totals[key] += usage.get(key, 0) or 0
        envelope = next(
            (event for event in reversed(events) if event.get("type") == "result"),
            None,
        )
        envelope_usage = (envelope or {}).get("usage") or {}
        if envelope_usage:
            for key in totals:
                if key in envelope_usage:
                    totals[key] = envelope_usage.get(key, 0) or 0
        return totals

    def _convert_events_to_trajectory(
        self, events: list[dict[str, Any]]
    ) -> Trajectory | None:
        model_name = self.model_name or self.DEFAULT_MODEL
        fallback_time = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        steps: list[Step] = []
        active: dict[str, Any] | None = None
        orphan_messages: list[dict[str, Any]] = []

        def append_active() -> None:
            nonlocal active
            if active is None:
                return
            end_event = active.get("end_event")
            messages = active["messages"]
            tools = list(active["tools"].values())
            tool_calls = [
                ToolCall(
                    tool_call_id=tool["id"],
                    function_name=tool["name"],
                    arguments={},
                )
                for tool in tools
            ]
            observations = [
                ObservationResult(
                    source_call_id=tool["id"],
                    content=json.dumps(
                        {
                            "success": tool.get("success"),
                            "durationMs": tool.get("durationMs"),
                            **(
                                {"errorCode": tool["errorCode"]}
                                if tool.get("errorCode")
                                else {}
                            ),
                            **(
                                {"error": tool["error"]}
                                if tool.get("error")
                                else {}
                            ),
                        }
                    ),
                )
                for tool in tools
            ]
            message = "\n\n".join(messages).strip() or "(tool use)"
            usage = (end_event or {}).get("usage") or {}
            # AI SDK inputTokens already includes cache-read tokens. Harbor
            # tracks the cached subset separately; adding it here double-counts.
            prompt_tokens = usage.get("inputTokens", 0) or 0
            output_tokens = usage.get("outputTokens", 0) or 0
            cached_tokens = usage.get("cacheReadTokens", 0) or 0
            metrics = None
            if end_event is not None and (
                prompt_tokens or output_tokens or cached_tokens
            ):
                metrics = Metrics(
                    prompt_tokens=prompt_tokens or None,
                    completion_tokens=output_tokens or None,
                    cached_tokens=cached_tokens or None,
                )
            steps.append(
                Step(
                    step_id=len(steps) + 1,
                    timestamp=active.get("timestamp") or fallback_time,
                    source="agent",
                    message=message,
                    llm_call_count=1 if end_event is not None else None,
                    model_name=(end_event or {}).get("responseModel") or model_name,
                    tool_calls=tool_calls or None,
                    observation=(
                        Observation(results=observations) if observations else None
                    ),
                    metrics=metrics,
                    extra={
                        "attempt": active.get("attempt"),
                        "step": active.get("step"),
                        **(
                            {"finishReason": end_event.get("finishReason")}
                            if end_event is not None
                            else {"incomplete": True}
                        ),
                    },
                )
            )
            active = None

        for event in events:
            etype = event.get("type")
            if etype == "step_start":
                append_active()
                active = {
                    "attempt": event.get("attempt"),
                    "step": event.get("step"),
                    "timestamp": event.get("at"),
                    "messages": [],
                    "tools": {},
                }
            elif etype == "message_end":
                text = event.get("text") or ""
                if not text or event.get("hidden"):
                    continue
                if active is None:
                    orphan_messages.append(event)
                else:
                    active["messages"].append(text)
            elif etype == "tool_start":
                if active is None:
                    active = {
                        "attempt": None,
                        "step": None,
                        "timestamp": event.get("at"),
                        "messages": [],
                        "tools": {},
                    }
                active["tools"][event.get("id") or f"tool-{len(active['tools']) + 1}"] = {
                    "id": event.get("id") or f"tool-{len(active['tools']) + 1}",
                    "name": event.get("name") or "unknown",
                }
            elif etype == "tool_end" and active is not None:
                tool_id = event.get("id") or f"tool-{len(active['tools']) + 1}"
                tool = active["tools"].setdefault(
                    tool_id,
                    {"id": tool_id, "name": event.get("name") or "unknown"},
                )
                tool.update(
                    {
                        "success": event.get("success"),
                        "durationMs": event.get("durationMs"),
                        "errorCode": event.get("errorCode"),
                        "error": event.get("error"),
                    }
                )
            elif etype == "step_end":
                if active is None:
                    active = {
                        "attempt": event.get("attempt"),
                        "step": event.get("step"),
                        "timestamp": event.get("at"),
                        "messages": [],
                        "tools": {},
                    }
                active["end_event"] = event

        append_active()
        for event in orphan_messages:
            steps.append(
                Step(
                    step_id=len(steps) + 1,
                    timestamp=event.get("at") or fallback_time,
                    source="agent",
                    message=event.get("text") or "",
                    llm_call_count=None,
                    model_name=model_name,
                )
            )

        if not steps:
            return None

        usage = self._summed_usage(events)
        total_input = usage["inputTokens"]
        total_output = usage["outputTokens"]
        return Trajectory(
            schema_version="ATIF-v1.7",
            session_id=f"haze-{int(time.time())}",
            agent=Agent(
                name="haze",
                version=self._version,
                model_name=model_name,
            ),
            steps=steps,
            final_metrics=FinalMetrics(
                total_prompt_tokens=total_input or None,
                total_completion_tokens=total_output or None,
                total_cost_usd=None,
                total_steps=len(steps),
            ),
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        events = self._load_events()
        usage = self._summed_usage(events)
        context.n_input_tokens = usage["inputTokens"]
        context.n_output_tokens = usage["outputTokens"]
        context.n_cache_tokens = usage["cacheReadTokens"]

        trajectory = self._convert_events_to_trajectory(events)
        if not trajectory:
            return

        trajectory_path = self.logs_dir / "trajectory.json"
        try:
            trajectory_path.write_text(
                format_trajectory_json(trajectory.to_json_dict())
            )
        except OSError as exc:
            self.logger.debug(
                f"Failed to write trajectory file {trajectory_path}: {exc}"
            )
