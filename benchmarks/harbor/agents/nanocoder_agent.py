"""Harbor agent adapter for the nanocoder CLI (https://nanocoder.ai).

Runs the locally distributed `@nanocollective/nanocoder` npm package inside the
task container in non-interactive mode:

    nanocoder --mode yolo run --plain --json --trust-directory "<instruction>"

Configuration (provider + API key) is injected as a generated
`agents.config.json` so the benchmark never depends on host state. The run's
structured JSON result (`--json`) is converted into an ATIF trajectory.

Usage with the harbor CLI:

    PYTHONPATH=benchmarks/harbor/agents harbor run \
        --agent nanocoder_agent:NanocoderAgent \
        --model <model-id> \
        --env-file <private-env-file-with-NANOCODER_BASE_URL-and-NANOCODER_API_KEY> \
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

_OUTPUT_LOG = "nanocoder-output.json"
_STDERR_LOG = "nanocoder-stderr.log"


class NanocoderAgent(BaseInstalledAgent):
    """nanocoder (non-interactive `run` mode, JSON output)."""

    SUPPORTS_ATIF: bool = True
    SUPPORTS_RESUME: bool = False

    DEFAULT_MODEL = "glm-5.2"
    DEFAULT_PROVIDER_NAME = "benchmark"

    @staticmethod
    @override
    def name() -> str:
        return "nanocoder"

    @override
    def get_version_command(self) -> str | None:
        return ". ~/.nvm/nvm.sh; nanocoder --version"

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
        version_spec = f"@{self._version}" if self._version else "@latest"
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                f"{nvm_node_install_snippet()} && "
                f"npm install -g @nanocollective/nanocoder{version_spec} && "
                "nanocoder --version"
            ),
        )

    def _build_config_install_command(self) -> str:
        """Write an agents.config.json built from NANOCODER_* environment values.

        Required env (host, preferably loaded with Harbor --env-file):
          NANOCODER_API_KEY   API key for the OpenAI-compatible provider
          NANOCODER_BASE_URL  Base URL of the OpenAI-compatible provider
        Optional env:
          NANOCODER_PROVIDER_NAME  Display name (default: "benchmark")
        """
        api_key = (self._get_env("NANOCODER_API_KEY") or "").strip()
        base_url = (self._get_env("NANOCODER_BASE_URL") or "").strip()
        if not api_key:
            raise RuntimeError(
                "NANOCODER_API_KEY is not set. Pass it with "
                "Harbor --env-file."
            )
        if not base_url:
            raise RuntimeError(
                "NANOCODER_BASE_URL is not set. Pass it with "
                "Harbor --env-file."
            )

        provider_name = (
            (self._get_env("NANOCODER_PROVIDER_NAME") or "").strip()
            or self.DEFAULT_PROVIDER_NAME
        )
        model = self.model_name or self.DEFAULT_MODEL
        config = {
            "nanocoder": {
                "providers": [
                    {
                        "name": provider_name,
                        "models": [model],
                        "baseUrl": base_url.rstrip("/"),
                        "apiKey": api_key,
                    }
                ],
            }
        }
        config_json = json.dumps(config)
        return (
            "mkdir -p \"$HOME/.config/nanocoder\" && "
            f"echo {shlex.quote(config_json)} > "
            "\"$HOME/.config/nanocoder/agents.config.json\""
        )

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        provider_name = (
            (self._get_env("NANOCODER_PROVIDER_NAME") or "").strip()
            or self.DEFAULT_PROVIDER_NAME
        )
        model = self.model_name or self.DEFAULT_MODEL

        config_command = self._build_config_install_command()
        await self.exec_as_agent(environment, command=config_command)

        command = (
            ". ~/.nvm/nvm.sh; "
            "cd /app && "
            f"nanocoder --provider {shlex.quote(provider_name)} "
            f"--model {shlex.quote(model)} "
            "--mode yolo run --plain --json --trust-directory "
            f"{shlex.quote(instruction)} "
            f"> /logs/agent/{_OUTPUT_LOG} "
            f"2> /logs/agent/{_STDERR_LOG}"
        )
        try:
            await self.exec_as_agent(environment, command=command)
        finally:
            # stdout JSON already lands in the shared /logs/agent volume; also
            # copy the nanocoder home config (sans secrets) for debugging.
            try:
                await self.exec_as_agent(
                    environment,
                    command=(
                        "grep -v apiKey "
                        "\"$HOME/.config/nanocoder/agents.config.json\" > "
                        "/logs/agent/nanocoder-config-redacted.json 2>/dev/null "
                        "|| true"
                    ),
                )
            except Exception:
                pass

    # ------------------------------------------------------------------
    # Trajectory conversion
    # ------------------------------------------------------------------

    def _load_result(self) -> dict[str, Any] | None:
        path = self.logs_dir / _OUTPUT_LOG
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            self.logger.debug(f"Failed to parse {_OUTPUT_LOG} as JSON")
            return None

    def _convert_result_to_trajectory(
        self, result: dict[str, Any]
    ) -> Trajectory | None:
        tool_calls = result.get("toolCalls") or []
        usage = result.get("usage") or {}
        model_name = self.model_name or self.DEFAULT_MODEL
        now = time.strftime("%Y-%m-%dT%H:%M:%S%z")

        steps: list[Step] = []
        step_id = 1

        for call in tool_calls:
            name = str(call.get("name") or "")
            arguments = call.get("arguments") or {}
            call_id = f"call-{step_id}"
            content: str
            if call.get("error") is not None:
                content = f"error: {call['error']}"
            else:
                content = str(call.get("result") if call.get("result") is not None else "")
            steps.append(
                Step(
                    step_id=step_id,
                    timestamp=now,
                    source="agent",
                    message="(tool use)",
                    llm_call_count=1,
                    model_name=model_name,
                    tool_calls=[
                        ToolCall(
                            tool_call_id=call_id,
                            function_name=name,
                            arguments=arguments,
                        )
                    ],
                    observation=Observation(
                        results=[
                            ObservationResult(
                                source_call_id=call_id,
                                content=content,
                            )
                        ]
                    ),
                )
            )
            step_id += 1

        final_text = result.get("finalText")
        if final_text:
            reasoning = result.get("reasoning")
            metrics: Metrics | None = None
            input_tokens = usage.get("inputTokens")
            output_tokens = usage.get("outputTokens")
            if input_tokens or output_tokens:
                metrics = Metrics(
                    prompt_tokens=input_tokens or None,
                    completion_tokens=output_tokens or None,
                )
            kwargs: dict[str, Any] = {
                "step_id": step_id,
                "timestamp": now,
                "source": "agent",
                "message": str(final_text),
                "llm_call_count": 1,
                "model_name": model_name,
            }
            if reasoning:
                kwargs["reasoning_content"] = str(reasoning)
            if metrics:
                kwargs["metrics"] = metrics
            steps.append(Step(**kwargs))
            step_id += 1

        if not steps:
            return None

        return Trajectory(
            schema_version="ATIF-v1.6",
            session_id=f"nanocoder-{int(time.time())}",
            agent=Agent(
                name="nanocoder",
                version=self._version,
                model_name=model_name,
            ),
            steps=steps,
            final_metrics=FinalMetrics(
                total_prompt_tokens=usage.get("inputTokens"),
                total_completion_tokens=usage.get("outputTokens"),
                total_cost_usd=None,
                total_steps=len(steps),
            ),
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        result = self._load_result()
        if not result:
            return

        trajectory = self._convert_result_to_trajectory(result)
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

        usage = result.get("usage") or {}
        context.n_input_tokens = usage.get("inputTokens") or 0
        context.n_output_tokens = usage.get("outputTokens") or 0
        context.n_cache_tokens = 0
