from __future__ import annotations

from pathlib import Path


class PathGuardError(ValueError):
    pass


def ensure_allowed_path(path: str, allowed_roots: list[str]) -> Path:
    if not allowed_roots:
        raise PathGuardError("no allowed roots configured")
    resolved = Path(path).expanduser().resolve()
    roots = [Path(root).expanduser().resolve() for root in allowed_roots]
    if not any(resolved == root or root in resolved.parents for root in roots):
        raise PathGuardError("path outside allowed roots")
    return resolved

