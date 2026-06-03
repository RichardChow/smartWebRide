import tempfile
import unittest
from pathlib import Path

from agent.swr_agent.path_guard import PathGuardError, ensure_allowed_path


class AgentPathGuardTest(unittest.TestCase):
    def test_allows_inside_root(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "arg.txt"
            target.write_text("--loglevel TRACE:INFO", encoding="utf-8")
            self.assertEqual(ensure_allowed_path(str(target), [root]), target.resolve())

    def test_rejects_outside_root(self):
        with tempfile.TemporaryDirectory() as root:
            with tempfile.TemporaryDirectory() as other:
                with self.assertRaises(PathGuardError):
                    ensure_allowed_path(other, [root])


if __name__ == "__main__":
    unittest.main()

