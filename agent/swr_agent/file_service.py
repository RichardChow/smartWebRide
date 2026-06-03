from __future__ import annotations

import base64
import stat
from pathlib import Path

from .path_guard import ensure_allowed_path


def _entry(path: Path) -> dict:
    info = path.stat()
    mode = info.st_mode
    if path.is_dir():
        kind = "directory"
    elif path.is_symlink():
        kind = "symlink"
    else:
        kind = "file"
    return {
        "name": path.name,
        "type": kind,
        "size": info.st_size,
        "permissions": stat.filemode(mode),
        "owner": str(info.st_uid) if hasattr(info, "st_uid") else "",
        "group": str(info.st_gid) if hasattr(info, "st_gid") else "",
        "modified": info.st_mtime,
        "path": str(path),
    }


class FileService:
    def __init__(self, allowed_roots: list[str]) -> None:
        self.allowed_roots = allowed_roots

    def list(self, path: str) -> dict:
        directory = ensure_allowed_path(path, self.allowed_roots)
        if not directory.is_dir():
            raise ValueError("path is not a directory")
        return {
            "cwd": str(directory),
            "files": [_entry(child) for child in directory.iterdir()],
        }

    def read(self, path: str) -> dict:
        target = ensure_allowed_path(path, self.allowed_roots)
        if not target.is_file():
            raise ValueError("path is not a file")
        data = target.read_bytes()
        try:
            content = data.decode("utf-8")
            encoding = "utf-8"
        except UnicodeDecodeError:
            content = base64.b64encode(data).decode("ascii")
            encoding = "base64"
        return {"content": content, "size": len(data), "encoding": encoding}

    def write(self, path: str, content: str) -> dict:
        target = ensure_allowed_path(path, self.allowed_roots)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        return {"ok": True, "size": len(content.encode("utf-8"))}

    def write_base64(self, path: str, content: str) -> dict:
        target = ensure_allowed_path(path, self.allowed_roots)
        target.parent.mkdir(parents=True, exist_ok=True)
        data = base64.b64decode(content.encode("ascii"))
        target.write_bytes(data)
        return {"ok": True, "size": len(data)}

    def mkdir(self, path: str, parents: bool = False) -> dict:
        target = ensure_allowed_path(path, self.allowed_roots)
        target.mkdir(parents=parents, exist_ok=parents)
        return {"ok": True, "path": str(target)}
