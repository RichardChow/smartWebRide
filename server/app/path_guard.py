from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException


def ensure_allowed_path(path: str, allowed_roots: list[str]) -> Path:
    if not allowed_roots:
        raise HTTPException(status_code=403, detail="no allowed roots configured")

    resolved = Path(path).expanduser().resolve()
    roots = [Path(root).expanduser().resolve() for root in allowed_roots]
    if not any(resolved == root or root in resolved.parents for root in roots):
        raise HTTPException(status_code=403, detail="path outside allowed roots")
    return resolved

