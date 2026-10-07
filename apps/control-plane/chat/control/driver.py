"""Container driver. Only the controller holds the Docker socket."""

import ipaddress
from dataclasses import dataclass

from django.conf import settings

RUNTIME_PORT = 8080
LABEL = "dev.axp.runtime"
MEMORY = "2g"
CPUS = 1
# Fixed in development, where host processes listen on its gateway address
# (172.30.0.1); deploy/deploy.sh creates production's.
DEV_SUBNET = "172.30.0.0/24"


@dataclass
class RuntimeSpec:
    agent_id: str
    instance_id: str
    generation: int
    name: str
    env: dict[str, str]


@dataclass
class StartedRuntime:
    container_id: str
    endpoint: str
    image_digest: str


class DockerDriver:
    """Runs runtimes on this machine's Docker.

    Development and production share the daemon; their networks, images and
    names never overlap.
    """

    def __init__(self):
        import docker

        self.docker = docker
        self.client = docker.from_env()
        dev = settings.DEBUG
        self.network = "axp-runtime" if dev else "axp-prod-runtime"
        self.image = f"axp-agent-runtime:{'dev' if dev else 'production'}"

    @staticmethod
    def name(suffix: str) -> str:
        return f"axp-dev-{suffix}" if settings.DEBUG else f"axp-{suffix}"

    def ensure_network(self) -> None:
        if self.client.networks.list(names=[self.network]):
            return
        subnet = ipaddress.ip_network(DEV_SUBNET)
        pool = self.docker.types.IPAMPool(
            subnet=str(subnet), gateway=str(next(subnet.hosts()))
        )
        self.client.networks.create(
            self.network,
            driver="bridge",
            ipam=self.docker.types.IPAMConfig(pool_configs=[pool]),
            labels={LABEL: "network"},
        )

    def start(self, spec: RuntimeSpec) -> StartedRuntime:
        self.ensure_network()
        container = self.client.containers.run(
            self.image,
            name=spec.name,
            detach=True,
            environment=spec.env,
            network=self.network,
            labels={
                LABEL: "runtime",
                f"{LABEL}.agent": spec.agent_id,
                f"{LABEL}.instance": spec.instance_id,
                f"{LABEL}.generation": str(spec.generation),
            },
            mem_limit=MEMORY,
            nano_cpus=int(CPUS * 1e9),
            restart_policy={"Name": "no"},
        )
        container.reload()
        network = container.attrs["NetworkSettings"]["Networks"][self.network]
        return StartedRuntime(
            container_id=container.id,
            endpoint=f"http://{network['IPAddress']}:{RUNTIME_PORT}",
            image_digest=container.image.id,
        )

    def state(self, container_id: str | None) -> str:
        """Return "running", "exited" or "missing"."""
        if not container_id:
            return "missing"
        try:
            container = self.client.containers.get(container_id)
        except self.docker.errors.NotFound:
            return "missing"
        return "running" if container.status in ("running", "restarting") else "exited"

    def stop(self, container_id: str | None, timeout: int = 10) -> None:
        """Stop and remove; returns only once the container cannot write."""
        if not container_id:
            return
        try:
            container = self.client.containers.get(container_id)
        except self.docker.errors.NotFound:
            return
        container.stop(timeout=timeout)
        container.wait(timeout=timeout + 30)
        container.remove(force=True)
