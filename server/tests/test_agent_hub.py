import unittest
import asyncio
import json
import time

from server.app import main as app_main
from server.app.agent_hub import AgentHub, TerminalSession, build_terminal_argv
from server.app.slave_registry import SlaveRegistry


class FakeWebSocket:
    def __init__(self, fail_send: bool = False) -> None:
        self.fail_send = fail_send
        self.sent: list[dict] = []
        self.closed = False

    async def send_json(self, payload: dict) -> None:
        if self.fail_send:
            raise RuntimeError("send failed")
        self.sent.append(payload)

    async def close(self) -> None:
        self.closed = True


class TerminalArgvTest(unittest.TestCase):
    def test_linux_bash_uses_login_interactive_shell(self):
        self.assertEqual(build_terminal_argv("/bin/bash"), ["/bin/bash", "--login", "-i"])

    def test_windows_powershell_keeps_no_logo(self):
        self.assertEqual(build_terminal_argv("powershell.exe"), ["powershell.exe", "-NoLogo"])


class AgentHubSessionTest(unittest.IsolatedAsyncioTestCase):
    def _seed(self, hub: AgentHub) -> None:
        hub._sessions["s1"] = TerminalSession("s1", "vm1", "a1", "/bin/bash", holder="Humphrey")
        hub._sessions["s2"] = TerminalSession("s2", "vm1", "a2", "/bin/bash", holder="Humphrey")
        hub._sessions["s3"] = TerminalSession("s3", "vm2", "a3", "/bin/bash", holder="Alice")

    def test_list_slave_sessions_filters_by_slave(self):
        hub = AgentHub()
        self._seed(hub)
        self.assertEqual({s.session_id for s in hub.list_slave_sessions("vm1")}, {"s1", "s2"})

    async def test_close_slave_sessions_removes_only_target_slave(self):
        hub = AgentHub()
        self._seed(hub)
        closed = await hub.close_slave_sessions("vm1")  # 无 agent 注册 → 仅本地清理
        self.assertEqual(set(closed), {"s1", "s2"})
        self.assertIsNone(hub.get_terminal_session("s1"))
        self.assertIsNone(hub.get_terminal_session("s2"))
        self.assertIsNotNone(hub.get_terminal_session("s3"))

    async def test_close_slave_sessions_notifies_browser_reason(self):
        hub = AgentHub()
        self._seed(hub)
        queue: asyncio.Queue[dict[str, str]] = asyncio.Queue()
        session = hub.get_terminal_session("s1")
        session.output_queues.add(queue)

        await hub.close_slave_sessions("vm1", "已被 Humphrey 强制接管：紧急调试")

        event = await asyncio.wait_for(queue.get(), timeout=0.1)
        self.assertEqual(event, {"type": "closed", "message": "已被 Humphrey 强制接管：紧急调试"})

    async def test_terminal_cwd_message_is_forwarded_to_browser_queue(self):
        hub = AgentHub()
        connection = hub.attach_agent("vm1", object())  # type: ignore[arg-type]
        connection.agent_to_center_session["a1"] = "s1"
        hub._sessions["s1"] = TerminalSession("s1", "vm1", "a1", "/bin/bash", holder="Humphrey")
        queue: asyncio.Queue[dict[str, str]] = asyncio.Queue()
        hub._sessions["s1"].output_queues.add(queue)

        await hub.handle_agent_message(connection, '{"type":"terminal.cwd","sessionId":"a1","cwd":"/root/debug"}')

        event = await asyncio.wait_for(queue.get(), timeout=0.1)
        self.assertEqual(event, {"type": "cwd", "data": "/root/debug"})
        self.assertEqual(hub._sessions["s1"].history_snapshot(), [{"type": "cwd", "data": "/root/debug"}])

    async def test_terminal_output_is_buffered_for_later_attach(self):
        hub = AgentHub()
        connection = hub.attach_agent("vm1", object())  # type: ignore[arg-type]
        connection.agent_to_center_session["a1"] = "s1"
        hub._sessions["s1"] = TerminalSession("s1", "vm1", "a1", "/bin/bash", holder="Humphrey")
        queue: asyncio.Queue[dict[str, str]] = asyncio.Queue()
        hub._sessions["s1"].output_queues.add(queue)

        await hub.handle_agent_message(connection, '{"type":"terminal.output","sessionId":"a1","data":"hello\\n"}')

        event = await asyncio.wait_for(queue.get(), timeout=0.1)
        self.assertEqual(event, {"type": "output", "data": "hello\n"})
        self.assertEqual(hub._sessions["s1"].history_snapshot(), [{"type": "output", "data": "hello\n"}])

    async def test_agent_heartbeat_updates_last_seen(self):
        hub = AgentHub()
        connection = hub.attach_agent("vm1", object())  # type: ignore[arg-type]
        connection.last_seen_at = 1.0

        payload = await hub.handle_agent_message(connection, '{"type":"agent.heartbeat","slaveId":"vm1","pythonVersion":"3.12.3","robotVersion":"Robot Framework 7.4.2"}')

        self.assertGreater(connection.last_seen_at, 1.0)
        self.assertEqual(connection.request_failures, 0)
        self.assertEqual(payload["pythonVersion"], "3.12.3")
        self.assertEqual(payload["robotVersion"], "Robot Framework 7.4.2")

    async def test_request_timeout_records_failure_with_context(self):
        hub = AgentHub()
        connection = hub.attach_agent("vm1", FakeWebSocket())

        with self.assertRaises(RuntimeError) as context:
            await connection.request("system.activity", {}, timeout=0.01)

        self.assertIn("agent request timed out: vm1 system.activity", str(context.exception))
        self.assertEqual(connection.request_failures, 1)
        self.assertIn("vm1 system.activity", connection.last_error)

    async def test_request_payload_error_raises_without_counting_connection_failure(self):
        hub = AgentHub()
        connection = hub.attach_agent("vm1", FakeWebSocket())

        task = asyncio.create_task(connection.request("terminal.open", {}, timeout=1))
        await asyncio.sleep(0)
        request_id = connection.websocket.sent[0]["requestId"]
        await hub.handle_agent_message(connection, json.dumps({
            "type": "response",
            "requestId": request_id,
            "payload": {"error": "cwd does not exist"},
        }))

        with self.assertRaises(RuntimeError) as context:
            await task

        self.assertIn("agent request failed: vm1 terminal.open: cwd does not exist", str(context.exception))
        self.assertEqual(connection.request_failures, 0)
        self.assertIn("cwd does not exist", connection.last_error)

    async def test_request_can_allow_payload_error_for_file_api(self):
        hub = AgentHub()
        connection = hub.attach_agent("vm1", FakeWebSocket())

        task = asyncio.create_task(connection.request("file.list", {}, timeout=1, fail_on_error=False))
        await asyncio.sleep(0)
        request_id = connection.websocket.sent[0]["requestId"]
        await hub.handle_agent_message(connection, json.dumps({
            "type": "response",
            "requestId": request_id,
            "payload": {"error": "permission denied"},
        }))

        self.assertEqual(await task, {"error": "permission denied"})
        self.assertEqual(connection.request_failures, 0)

    async def test_orphan_response_error_records_failure(self):
        hub = AgentHub()
        connection = hub.attach_agent("vm1", FakeWebSocket())

        await hub.handle_agent_message(connection, json.dumps({
            "type": "response",
            "requestId": "notify-1",
            "payload": {"error": "unknown pty session"},
        }))

        self.assertEqual(connection.request_failures, 1)
        self.assertIn("unknown pty session", connection.last_error)

    async def test_create_terminal_session_rejects_missing_agent_session_id(self):
        hub = AgentHub()
        connection = hub.attach_agent("vm1", FakeWebSocket())

        task = asyncio.create_task(hub.create_terminal_session("vm1", "/bin/bash", "/home/pzhou", holder="Humphrey"))
        await asyncio.sleep(0)
        request_id = connection.websocket.sent[0]["requestId"]
        await hub.handle_agent_message(connection, json.dumps({
            "type": "response",
            "requestId": request_id,
            "payload": {"ok": True},
        }))

        with self.assertRaises(RuntimeError) as context:
            await task

        self.assertIn("agent terminal.open returned no agentSessionId: vm1", str(context.exception))
        self.assertEqual(hub.list_terminal_sessions(), [])

    async def test_create_terminal_session_buffers_output_before_open_response(self):
        hub = AgentHub()
        connection = hub.attach_agent("vm1", FakeWebSocket())

        task = asyncio.create_task(hub.create_terminal_session("vm1", "/bin/bash", "/home/pzhou", holder="Humphrey"))
        await asyncio.sleep(0)
        open_message = connection.websocket.sent[0]
        session_id = open_message["payload"]["sessionId"]
        session = hub.get_terminal_session(session_id)
        self.assertIsNotNone(session)
        queue: asyncio.Queue[dict[str, str]] = asyncio.Queue()
        session.output_queues.add(queue)

        await hub.handle_agent_message(connection, json.dumps({
            "type": "terminal.cwd",
            "sessionId": session_id,
            "cwd": "/home/pzhou",
        }))
        event = await asyncio.wait_for(queue.get(), timeout=0.1)
        self.assertEqual(event, {"type": "cwd", "data": "/home/pzhou"})

        await hub.handle_agent_message(connection, json.dumps({
            "type": "response",
            "requestId": open_message["requestId"],
            "payload": {"agentSessionId": session_id},
        }))

        created = await task
        self.assertEqual(created.session_id, session_id)
        self.assertEqual(created.agent_session_id, session_id)
        self.assertEqual(created.history_snapshot(), [{"type": "cwd", "data": "/home/pzhou"}])

    async def test_create_terminal_session_flushes_old_agent_orphan_output(self):
        hub = AgentHub()
        connection = hub.attach_agent("vm1", FakeWebSocket())

        task = asyncio.create_task(hub.create_terminal_session("vm1", "/bin/bash", "/home/pzhou", holder="Humphrey"))
        await asyncio.sleep(0)
        open_message = connection.websocket.sent[0]
        center_session_id = open_message["payload"]["sessionId"]
        agent_session_id = "old-agent-session"
        session = hub.get_terminal_session(center_session_id)
        self.assertIsNotNone(session)
        queue: asyncio.Queue[dict[str, str]] = asyncio.Queue()
        session.output_queues.add(queue)

        await hub.handle_agent_message(connection, json.dumps({
            "type": "terminal.output",
            "sessionId": agent_session_id,
            "data": "early prompt",
        }))
        self.assertTrue(queue.empty())

        await hub.handle_agent_message(connection, json.dumps({
            "type": "response",
            "requestId": open_message["requestId"],
            "payload": {"agentSessionId": agent_session_id},
        }))

        created = await task
        event = await asyncio.wait_for(queue.get(), timeout=0.1)
        self.assertEqual(created.session_id, center_session_id)
        self.assertEqual(created.agent_session_id, agent_session_id)
        self.assertEqual(event, {"type": "output", "data": "early prompt"})
        self.assertEqual(created.history_snapshot(), [{"type": "output", "data": "early prompt"}])

    async def test_terminal_input_waits_for_short_ack(self):
        hub = AgentHub()
        connection = hub.attach_agent("vm1", FakeWebSocket())
        hub._sessions["s1"] = TerminalSession("s1", "vm1", "a1", "/bin/bash", holder="Humphrey")

        task = asyncio.create_task(hub.terminal_input("s1", "echo ok\n"))
        await asyncio.sleep(0)

        self.assertEqual(connection.websocket.sent[0]["type"], "terminal.input")
        self.assertEqual(connection.websocket.sent[0]["payload"]["agentSessionId"], "a1")
        await hub.handle_agent_message(connection, json.dumps({
            "type": "response",
            "requestId": connection.websocket.sent[0]["requestId"],
            "payload": {"ok": True},
        }))
        await task
        self.assertEqual(connection.pending, {})

    async def test_notify_send_failure_records_failure(self):
        hub = AgentHub()
        connection = hub.attach_agent("vm1", FakeWebSocket(fail_send=True))

        with self.assertRaises(RuntimeError) as context:
            await connection.notify("terminal.input", {"agentSessionId": "a1", "data": "x"})

        self.assertIn("agent send failed: vm1 terminal.input", str(context.exception))
        self.assertEqual(connection.request_failures, 1)

    async def test_stale_connection_can_be_closed_without_removing_new_connection(self):
        hub = AgentHub()
        old_socket = FakeWebSocket()
        old_connection = hub.attach_agent("vm2", old_socket)  # type: ignore[arg-type]
        new_connection = hub.attach_agent("vm2", FakeWebSocket())  # type: ignore[arg-type]
        old_connection.last_seen_at = time.time() - 60

        self.assertTrue(hub.is_connection_stale(old_connection, stale_seconds=20))
        await hub.close_agent_connection(old_connection, "stale")

        self.assertTrue(old_socket.closed)
        self.assertFalse(hub.detach_agent("vm2", old_connection))
        self.assertTrue(hub.is_online("vm2"))
        self.assertIs(hub._agents["vm2"], new_connection)

    def test_find_reusable_terminal_session_matches_slave_and_holder(self):
        hub = AgentHub()
        self._seed(hub)
        hub._sessions["s1"].created_at = 1.0
        hub._sessions["s2"].created_at = 2.0

        self.assertEqual(hub.find_reusable_terminal_session("vm1", "Humphrey").session_id, "s2")
        self.assertIsNone(hub.find_reusable_terminal_session("vm1", "Alice"))
        self.assertIsNone(hub.find_reusable_terminal_session("vm1", ""))

    def test_find_reusable_terminal_session_ignores_split_sessions(self):
        hub = AgentHub()
        self._seed(hub)
        hub._sessions["s1"].created_at = 1.0
        hub._sessions["s2"].created_at = 2.0
        hub._sessions["s2"].reusable = False

        self.assertEqual(hub.find_reusable_terminal_session("vm1", "Humphrey").session_id, "s1")

    def test_stale_agent_disconnect_does_not_remove_new_connection(self):
        hub = AgentHub()
        old_connection = hub.attach_agent("vm2", object())  # type: ignore[arg-type]
        new_connection = hub.attach_agent("vm2", object())  # type: ignore[arg-type]
        hub._sessions["s3"] = TerminalSession("s3", "vm2", "a3", "/bin/bash", holder="Alice")

        self.assertFalse(hub.detach_agent("vm2", old_connection))
        self.assertTrue(hub.is_online("vm2"))
        self.assertIsNotNone(hub.get_terminal_session("s3"))

        self.assertTrue(hub.detach_agent("vm2", new_connection))
        self.assertFalse(hub.is_online("vm2"))
        self.assertIsNone(hub.get_terminal_session("s3"))


class TerminalSessionRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_create_terminal_session_reuses_existing_holder_session(self):
        old_registry = app_main.registry
        old_hub = app_main.hub

        class FakeAgent:
            def __init__(self) -> None:
                self.agent_to_center_session: dict[str, str] = {}
                self.requests: list[dict] = []

            async def request(self, message_type: str, payload: dict, timeout: float = 15) -> dict:
                self.requests.append({"type": message_type, "payload": payload})
                return {"agentSessionId": payload["sessionId"]}

        try:
            app_main.registry = SlaveRegistry()
            app_main.hub = AgentHub()
            app_main.registry.mark_agent_online("vm1", "test-agent", ["/tmp"])
            app_main.registry.lock("vm1", "Humphrey")
            app_main.hub._agents["vm1"] = FakeAgent()  # type: ignore[assignment]

            first = await app_main.create_terminal_session("vm1", "Humphrey")
            second = await app_main.create_terminal_session("vm1", "Humphrey")

            self.assertEqual(first.id, second.id)
            self.assertEqual(len(app_main.hub.list_terminal_sessions()), 1)
        finally:
            app_main.registry = old_registry
            app_main.hub = old_hub

    async def test_create_terminal_session_new_mode_uses_requested_cwd_without_becoming_reusable(self):
        old_registry = app_main.registry
        old_hub = app_main.hub

        class FakeAgent:
            def __init__(self) -> None:
                self.agent_to_center_session: dict[str, str] = {}
                self.requests: list[dict] = []

            async def request(self, message_type: str, payload: dict, timeout: float = 15) -> dict:
                self.requests.append({"type": message_type, "payload": payload})
                return {"agentSessionId": payload["sessionId"]}

        try:
            app_main.registry = SlaveRegistry()
            app_main.hub = AgentHub()
            app_main.registry.mark_agent_online("vm1", "test-agent", ["/tmp", "/root/debug"])
            app_main.registry.lock("vm1", "Humphrey")
            fake_agent = FakeAgent()
            app_main.hub._agents["vm1"] = fake_agent  # type: ignore[assignment]

            primary = await app_main.create_terminal_session("vm1", "Humphrey")
            split = await app_main.create_terminal_session("vm1", "Humphrey", mode="new", cwd="/root/debug/case")
            resumed = await app_main.create_terminal_session("vm1", "Humphrey")

            self.assertNotEqual(primary.id, split.id)
            self.assertEqual(primary.id, resumed.id)
            self.assertEqual(fake_agent.requests[1]["payload"]["cwd"], "/root/debug/case")
            self.assertFalse(app_main.hub.get_terminal_session(split.id).reusable)
        finally:
            app_main.registry = old_registry
            app_main.hub = old_hub

    async def test_create_terminal_session_rejects_cwd_outside_allowed_roots(self):
        old_registry = app_main.registry
        old_hub = app_main.hub

        class FakeAgent:
            def __init__(self) -> None:
                self.agent_to_center_session: dict[str, str] = {}

            async def request(self, message_type: str, payload: dict, timeout: float = 15) -> dict:
                return {"agentSessionId": payload["sessionId"]}

        try:
            app_main.registry = SlaveRegistry()
            app_main.hub = AgentHub()
            app_main.registry.mark_agent_online("vm1", "test-agent", ["/root/debug"])
            app_main.registry.lock("vm1", "Humphrey")
            app_main.hub._agents["vm1"] = FakeAgent()  # type: ignore[assignment]

            with self.assertRaises(app_main.HTTPException) as context:
                await app_main.create_terminal_session("vm1", "Humphrey", mode="new", cwd="/etc")

            self.assertEqual(context.exception.status_code, 400)
            self.assertEqual(len(app_main.hub.list_terminal_sessions()), 0)
        finally:
            app_main.registry = old_registry
            app_main.hub = old_hub


if __name__ == "__main__":
    unittest.main()
