import base64
import tempfile
import unittest
from pathlib import Path

from agent.swr_agent.file_service import FileService


class FileServiceTest(unittest.TestCase):
    def test_creates_directory_inside_allowed_root(self):
        with tempfile.TemporaryDirectory() as root:
            service = FileService([root])
            target = Path(root) / "new-folder"

            result = service.mkdir(str(target))

            self.assertTrue(result["ok"])
            self.assertTrue(target.is_dir())

    def test_writes_base64_file_inside_allowed_root(self):
        with tempfile.TemporaryDirectory() as root:
            service = FileService([root])
            target = Path(root) / "upload.bin"
            payload = base64.b64encode(b"\x00robot\xff").decode("ascii")

            result = service.write_base64(str(target), payload)

            self.assertEqual(result["size"], 7)
            self.assertEqual(target.read_bytes(), b"\x00robot\xff")


if __name__ == "__main__":
    unittest.main()
