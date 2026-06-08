import asyncio
import json
import unittest
from unittest.mock import patch

from agent.swr_agent.main import ROBOT_VERSION_UNAVAILABLE, RuntimeInfo, SmartWebRideAgent, detect_robot_version


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[str] = []
        self.sent_event = asyncio.Event()

    async def send(self, message: str) -> None:
        self.sent.append(message)
        self.sent_event.set()


class AgentMainTest(unittest.IsolatedAsyncioTestCase):
    def make_agent(self) -> SmartWebRideAgent:
        return SmartWebRideAgent(
            "ws://center",
            "vm1",
            ["/root/debug"],
            version="test-agent",
            runtime_info=RuntimeInfo(python_version="3.12.3", robot_version="Robot Framework 7.4.2"),
        )

    def test_detect_robot_version_returns_first_output_line(self):
        class Result:
            returncode = 0
            stdout = "Robot Framework 7.4.2 (Python 3.12.3 on linux)\nextra"
            stderr = ""

        with patch("agent.swr_agent.main.subprocess.run", return_value=Result()):
            self.assertEqual(detect_robot_version(), "Robot Framework 7.4.2 (Python 3.12.3 on linux)")

    def test_detect_robot_version_accepts_robot_output_with_nonzero_exit_code(self):
        class Result:
            returncode = 251
            stdout = "Robot Framework 7.4.2 (Python 3.12.3 on linux)\n"
            stderr = ""

        with patch("agent.swr_agent.main.subprocess.run", return_value=Result()):
            self.assertEqual(detect_robot_version(), "Robot Framework 7.4.2 (Python 3.12.3 on linux)")

    def test_detect_robot_version_rejects_non_robot_error_output(self):
        class Result:
            returncode = 1
            stdout = ""
            stderr = "/usr/bin/python: No module named robot"

        with patch("agent.swr_agent.main.subprocess.run", return_value=Result()), patch("agent.swr_agent.main.shutil.which", return_value=None):
            self.assertEqual(detect_robot_version(), ROBOT_VERSION_UNAVAILABLE)

    def test_detect_robot_version_degrades_when_robot_is_missing(self):
        with patch("agent.swr_agent.main.subprocess.run", side_effect=OSError("missing")):
            self.assertEqual(detect_robot_version(), ROBOT_VERSION_UNAVAILABLE)

    async def test_send_event_serializes_through_websocket(self):
        agent = self.make_agent()
        websocket = FakeWebSocket()
        agent.websocket = websocket

        await agent.send_event("agent.heartbeat", agent.agent_status_payload())

        self.assertEqual(json.loads(websocket.sent[0]), {
            "type": "agent.heartbeat",
            "slaveId": "vm1",
            "version": "test-agent",
            "roots": ["/root/debug"],
            "pythonVersion": "3.12.3",
            "robotVersion": "Robot Framework 7.4.2",
        })

    async def test_heartbeat_loop_sends_agent_health_message(self):
        agent = self.make_agent()
        websocket = FakeWebSocket()
        agent.websocket = websocket

        task = asyncio.create_task(agent.send_heartbeat_loop())
        await asyncio.wait_for(websocket.sent_event.wait(), timeout=0.1)
        agent.websocket = None
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

        message = json.loads(websocket.sent[0])
        self.assertEqual(message["type"], "agent.heartbeat")
        self.assertEqual(message["slaveId"], "vm1")
        self.assertEqual(message["version"], "test-agent")
        self.assertEqual(message["roots"], ["/root/debug"])
        self.assertEqual(message["pythonVersion"], "3.12.3")
        self.assertEqual(message["robotVersion"], "Robot Framework 7.4.2")

    async def test_handle_message_returns_timeout_error_for_stuck_dispatch(self):
        agent = self.make_agent()
        websocket = FakeWebSocket()
        agent.websocket = websocket

        async def slow_dispatch(_message_type: str, _payload: dict) -> dict:
            await asyncio.sleep(1)
            return {"ok": True}

        agent.dispatch = slow_dispatch  # type: ignore[method-assign]

        with patch("agent.swr_agent.main.DISPATCH_TIMEOUT_SECONDS", 0.01):
            await agent.handle_message({"type": "system.activity", "requestId": "r1", "payload": {}})

        response = json.loads(websocket.sent[0])
        self.assertEqual(response["type"], "response")
        self.assertEqual(response["requestId"], "r1")
        self.assertIn("agent dispatch timed out: system.activity", response["payload"]["error"])

    async def test_terminal_open_uses_center_session_id(self):
        agent = self.make_agent()
        calls: list[dict] = []

        class FakePtyService:
            async def open(self, shell: str, cwd: str, argv: list[str] | None = None, session_id: str | None = None) -> str:
                calls.append({"shell": shell, "cwd": cwd, "argv": argv, "session_id": session_id})
                return session_id or "generated"

        agent.pty_service = FakePtyService()  # type: ignore[assignment]

        result = await agent.dispatch("terminal.open", {
            "sessionId": "center-session-1",
            "shell": "/bin/bash",
            "cwd": "/home/pzhou",
            "argv": ["/bin/bash", "-i"],
        })

        self.assertEqual(result, {"agentSessionId": "center-session-1"})
        self.assertEqual(calls, [{
            "shell": "/bin/bash",
            "cwd": "/home/pzhou",
            "argv": ["/bin/bash", "-i"],
            "session_id": "center-session-1",
        }])


if __name__ == "__main__":
    unittest.main()
