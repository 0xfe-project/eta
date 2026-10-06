"""Container driver. Only the controller holds the Docker socket."""

import ipaddress
from dataclasses import dataclass, field

from django.conf import settings

RUNTIME_PORT = 8080
LABEL = "dev.axp.runtime"


@dataclass
class RuntimeSpec:
    agent_id: str
    instance_id: str
    generation: int
    name: str
    env: dict[str, str]
    workspace_volume: str | None
    state_volume: str
    s3_workspace: bool = False
    binds: dict[str, dict] = field(default_factory=dict)


@dataclass
class StartedRuntime:
    container_id: str
    endpoint: str
    image_digest: str


class DockerDriver:
    def __init__(self):
        import docker

        self.docker = docker
        self.client = docker.from_env()

    def ensure_network(self) -> None:
        name = settings.AXP_RUNTIME_NETWORK
        if self.client.networks.list(names=[name]):
            return
        subnet = ipaddress.ip_network(settings.AXP_RUNTIME_SUBNET)
        pool = self.docker.types.IPAMPool(
            subnet=str(subnet), gateway=str(next(subnet.hosts()))
        )
        self.client.networks.create(
            name,
            driver="bridge",
            ipam=self.docker.types.IPAMConfig(pool_configs=[pool]),
            labels={LABEL: "network"},
        )

    def volume_exists(self, name: str) -> bool:
        try:
            self.client.volumes.get(name)
            return True
        except self.docker.errors.NotFound:
            return False

    def ensure_volume(self, name: str) -> None:
        if not self.volume_exists(name):
            self.client.volumes.create(name, labels={LABEL: "volume"})

    def start(self, spec: RuntimeSpec) -> StartedRuntime:
        self.ensure_network()
        volumes = {spec.state_volume: {"bind": "/state", "mode": "rw"}, **spec.binds}
        kwargs = {}
        if spec.s3_workspace:
            # rclone mounts the S3 workspace through FUSE inside the container.
            kwargs.update(
                devices=["/dev/fuse"],
                cap_add=["SYS_ADMIN"],
                security_opt=["apparmor:unconfined"],
            )
        else:
            volumes[spec.workspace_volume] = {"bind": "/workspace", "mode": "rw"}
        container = self.client.containers.run(
            settings.AXP_RUNTIME_IMAGE,
            name=spec.name,
            detach=True,
            environment=spec.env,
            volumes=volumes,
            network=settings.AXP_RUNTIME_NETWORK,
            labels={
                LABEL: "runtime",
                f"{LABEL}.agent": spec.agent_id,
                f"{LABEL}.instance": spec.instance_id,
                f"{LABEL}.generation": str(spec.generation),
            },
            mem_limit=settings.AXP_RUNTIME_MEMORY,
            nano_cpus=int(settings.AXP_RUNTIME_CPUS * 1e9),
            restart_policy={"Name": "no"},
            **kwargs,
        )
        container.reload()
        network = container.attrs["NetworkSettings"]["Networks"][
            settings.AXP_RUNTIME_NETWORK
        ]
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
