"""Harbor 0.20 Pi adapter with Z.ai credentials forwarded to the container."""
import os

from harbor.agents.installed.pi import Pi


class PiZai(Pi):
    async def exec_as_agent(self, environment, command, env=None, **kwargs):
        env = dict(env or {})
        if self.model_name and self.model_name.startswith("zai/"):
            key = os.environ.get("ZAI_API_KEY")
            if key:
                env["ZAI_API_KEY"] = key
        return await super().exec_as_agent(environment, command, env=env, **kwargs)
