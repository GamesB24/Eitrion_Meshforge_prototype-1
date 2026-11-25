"""Cloud GPU adapters. Credentials come only from environment variables; nothing is stored.

  MESHFORGE_CLOUD unset   Refuses the job. Does not invent a mesh.
  MESHFORGE_CLOUD=mock    Explicit test flag. Returns a demo multi-part mesh. Not a production default.
  MESHFORGE_CLOUD=modal   Modal serverless GPU (see cloud/modal_app.py). UNTESTED - needs `pip install modal`,
                          `modal token new` (or MODAL_TOKEN_ID / MODAL_TOKEN_SECRET) and `modal deploy cloud/modal_app.py`.
  MESHFORGE_CLOUD=remote  Another MeshForge server on a GPU box you own/rent, usually through an SSH tunnel:
                          ssh -L 9000:127.0.0.1:8000 user@gpu-host ; MESHFORGE_REMOTE_URL=http://127.0.0.1:9000
"""
from __future__ import annotations
import os, time
from pathlib import Path
from .base import Runner, png_bytes, glb_to_parts


class CloudAdapter:
    name = "base"
    def ready(self) -> tuple[bool, str]: return True, ""
    def generate(self, engine_id, png: bytes, params: dict, progress) -> bytes: raise NotImplementedError


class MockAdapter(CloudAdapter):
    name = "mock"

    def generate(self, engine_id, png, params, progress):
        import numpy as np
        import trimesh
        for i, msg in enumerate(["Queued on cloud (mock)", "Cold start (mock)", "Generating (mock)", "Downloading result (mock)"]):
            progress(0.2 + 0.13 * i, msg); time.sleep(0.6)
        body = trimesh.creation.capsule(height=1.0, radius=0.35); body.visual.vertex_colors = [180, 140, 90, 255]
        head = trimesh.creation.icosphere(3, radius=0.3); head.apply_translation([0, 0, 1.05]); head.visual.vertex_colors = [230, 200, 170, 255]
        sword = trimesh.creation.box([0.06, 0.06, 1.2]); sword.apply_translation([0.55, 0, 0.3]); sword.visual.vertex_colors = [200, 200, 210, 255]
        s = trimesh.Scene()
        for n, g in [("body", body), ("head", head), ("sword_R", sword)]:
            s.add_geometry(g, node_name=n, geom_name=n)
        s.apply_transform(trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0]))  # Z-up -> Y-up
        return s.export(file_type="glb")


class ModalAdapter(CloudAdapter):
    """UNTESTED. Calls the `generate` function of the deployed Modal app `meshforge` (cloud/modal_app.py)."""
    name = "modal"

    def ready(self):
        try:
            import modal  # noqa: F401
        except ImportError:
            return False, "pip install modal, then modal token new and modal deploy cloud/modal_app.py"
        has_env = os.environ.get("MODAL_TOKEN_ID") and os.environ.get("MODAL_TOKEN_SECRET")
        has_file = (Path.home() / ".modal.toml").exists()
        return (bool(has_env or has_file), "" if (has_env or has_file) else "Set MODAL_TOKEN_ID / MODAL_TOKEN_SECRET")

    def generate(self, engine_id, png, params, progress):
        import modal
        fn = modal.Function.from_name(os.environ.get("MESHFORGE_MODAL_APP", "meshforge"), "generate")
        progress(0.25, "Submitted to Modal (cold start can take 30-90 s)")
        call = fn.spawn(engine_id, png, params)
        t0 = time.time()
        while True:
            try:
                return call.get(timeout=5)
            except TimeoutError:
                progress(min(0.7, 0.25 + (time.time() - t0) / 300), f"Running on Modal GPU... {int(time.time() - t0)} s")


class RemoteServerAdapter(CloudAdapter):
    """Posts to another MeshForge server (e.g. on a rented GPU reached via SSH tunnel) using its local runner."""
    name = "remote"

    def __init__(self):
        self.url = os.environ.get("MESHFORGE_REMOTE_URL", "").rstrip("/")

    def ready(self):
        return (bool(self.url), "" if self.url else "Set MESHFORGE_REMOTE_URL")

    def generate(self, engine_id, png, params, progress):
        import requests
        form = {"engine": engine_id, "runner": "local", "remove_bg": "false",
                "params": __import__("json").dumps({**params, "postprocess": False})}
        r = requests.post(f"{self.url}/api/jobs", files={"image": ("in.png", png, "image/png")}, data=form, timeout=30)
        r.raise_for_status(); jid = r.json()["id"]
        while True:
            j = requests.get(f"{self.url}/api/jobs/{jid}", timeout=30).json()
            if j["status"] == "done":
                return requests.get(f"{self.url}/api/jobs/{jid}/mesh.glb", timeout=120).content
            if j["status"] == "error":
                raise RuntimeError(f"Remote error: {j['error']}")
            progress(0.2 + 0.5 * j["progress"], f"Remote: {j['message']}"); time.sleep(1)


ADAPTERS = {"mock": MockAdapter, "modal": ModalAdapter, "remote": RemoteServerAdapter}

UNCONFIGURED = (
    "Cloud runner is not configured. Set MESHFORGE_CLOUD=modal or MESHFORGE_CLOUD=remote. "
    "A demo mesh is returned only when MESHFORGE_CLOUD=mock is set explicitly. "
    "Refusing to invent a placeholder mesh."
)


class UnconfiguredAdapter(CloudAdapter):
    """Fails the job. This is the default when MESHFORGE_CLOUD is missing or unknown."""

    def __init__(self, reason: str):
        self.name = "unconfigured"
        self.reason = reason

    def ready(self):
        return False, self.reason

    def generate(self, engine_id, png, params, progress):
        raise RuntimeError(self.reason)


class CloudRunner(Runner):
    id, label = "cloud", "Cloud GPU"

    def __init__(self):
        raw = os.environ.get("MESHFORGE_CLOUD", "")
        name = raw.strip().lower()
        self.requested = name
        if name == "mock":
            self.adapter = MockAdapter()
        elif name in ADAPTERS:
            self.adapter = ADAPTERS[name]()
        elif not name:
            self.adapter = UnconfiguredAdapter(UNCONFIGURED)
        else:
            self.adapter = UnconfiguredAdapter(
                f"Unknown MESHFORGE_CLOUD={raw!r}. Use modal, remote, or mock. "
                "Refusing to invent a placeholder mesh."
            )

    def status(self):
        ok, why = self.adapter.ready()
        return {"id": self.id, "label": self.label, "ready": ok, "adapter": self.adapter.name, "hint": why,
                "explicit_mock": self.adapter.name == "mock",
                "untested": self.adapter.name in ("modal",)}

    def run(self, engine_id, image, params, progress):
        ok, why = self.adapter.ready()
        if not ok:
            raise RuntimeError(why or UNCONFIGURED)
        return glb_to_parts(self.adapter.generate(engine_id, png_bytes(image), params, progress))
