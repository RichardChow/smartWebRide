import unittest

from agent.swr_agent.activity_service import ActivityService


class ActivityServiceTest(unittest.TestCase):
    def test_scan_returns_well_formed_dict(self):
        result = ActivityService(["/tmp"]).scan()
        self.assertIn("robotRunning", result)
        self.assertIn("runId", result)
        self.assertIn("processes", result)
        self.assertIsInstance(result["robotRunning"], bool)
        self.assertIsInstance(result["processes"], list)

    def test_is_robot_process_matches_robot_executable(self):
        service = ActivityService(["/tmp"])
        self.assertTrue(service._is_robot_process(["/opt/venv/bin/robot", "suite.robot"], "1"))
        self.assertTrue(service._is_robot_process(["sudo", "/opt/venv/bin/robot", "s"], "1"))
        self.assertTrue(service._is_robot_process(["python", "-m", "robot.run", "x"], "1"))
        self.assertFalse(service._is_robot_process(["/bin/bash", "-i"], "1"))
        self.assertFalse(service._is_robot_process(["grep", "robot"], "1"))


if __name__ == "__main__":
    unittest.main()
