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
        --ae HAZE_BASE_URL=<openai-compatible-base-url> \
        --ae HAZE_API_KEY=<key> \
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
    Step,
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

        Required env (host, passed via --ae or the shell):
          HAZE_API_KEY   API key for the OpenAI-compatible provider
          HAZE_BASE_URL  Base URL of the OpenAI-compatible provider
        """
        api_key = (self._get_env("HAZE_API_KEY") or "").strip()
        base_url = (self._get_env("HAZE_BASE_URL") or "").strip()
        if not api_key:
            raise RuntimeError(
                "HAZE_API_KEY is not set. Pass it with `--ae HAZE_API_KEY=...`."
            )
        if not base_url:
            raise RuntimeError(
                "HAZE_BASE_URL is not set. Pass it with `--ae HAZE_BASE_URL=...`."
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

        config_command = self._build_config_install_command()
        await self.exec_as_agent(environment, command=config_command)

        command = (
            ". ~/.nvm/nvm.sh; "
            "cd /app && "
            f"haze -p {shlex.quote(instruction)} "
            f"--model {shlex.quote(f'{_PROVIDER_NAME}:{model}')} "
            "--output stream-json "
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

    def _convert_events_to_trajectory(
        self, events: list[dict[str, Any]]
    ) -> Trajectory | None:
        model_name = self.model_name or self.DEFAULT_MODEL
        now = time.strftime("%Y-%m-%dT%H:%M:%S%z")

        steps: list[Step] = []
        step_id = 1
        total_input = 0
        total_output = 0
        envelope_usage: dict[str, Any] = {}

        for event in events:
            etype = event.get("type")
            if etype == "message_end":
                text = event.get("text") or ""
                if not text or event.get("hidden"):
                    continue
                steps.append(
                    Step(
                        step_id=step_id,
                        timestamp=now,
                        source="agent",
                        message=text,
                        llm_call_count=1,
                        model_name=model_name,
                    )
                )
                step_id += 1
            elif etype == "step_end":
                usage = event.get("usage") or {}
                total_input += usage.get("inputTokens", 0) or 0
                total_input += usage.get("cacheReadTokens", 0) or 0
                total_output += usage.get("outputTokens", 0) or 0
            elif etype == "result":
                envelope_usage = event.get("usage") or {}

        if not steps and not envelope_usage:
            return None

        # Prefer the final envelope's usage (authoritative) when present.
        if envelope_usage:
            total_input = (
                envelope_usage.get("inputTokens", 0)
                + envelope_usage.get("cacheReadTokens", 0)
            )
            total_output = envelope_usage.get("outputTokens", 0)
            if steps and (total_input or total_output):
                steps[-1].metrics = Metrics(
                    prompt_tokens=total_input or None,
                    completion_tokens=total_output or None,
                )

        if not steps:
            return None

        return Trajectory(
            schema_version="ATIF-v1.6",
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
        envelope = next((e for e in reversed(events) if e.get("type") == "result"), None)
        usage = (envelope or {}).get("usage") or {}
        context.n_input_tokens = (
            usage.get("inputTokens", 0) + usage.get("cacheReadTokens", 0)
        )
        context.n_output_tokens = usage.get("outputTokens", 0)

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
