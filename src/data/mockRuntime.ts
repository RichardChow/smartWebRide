import type { ExecutionNode, SlaveSession } from '../types';

const now = Date.now();

function minutesFromNow(minutes: number): string {
  return new Date(now + minutes * 60_000).toISOString();
}

function minutesAgo(minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

export const slaveSessions: SlaveSession[] = [
  {
    slaveId: 'vm1',
    name: 'VM1 主控调试节点',
    host: '192.0.2.11',
    system: 'Linux / sample',
    connectionMode: 'remote-agent',
    agentVersion: 'swr-agent 0.1.0',
    mode: 'idle',
    holder: '',
    heartbeatAt: minutesAgo(1),
    expiresAt: minutesFromNow(15),
    manualHoldReason: '',
    activeRunId: '',
    processSignal: 'none',
    allowedRoots: ['/tmp/swr-debug', '/opt/robot/cases'],
    capabilities: {
      browseRobotRoot: true,
      runRobot: true,
      svnOps: true,
      processInspect: true,
      terminal: true,
      killProcess: true
    }
  },
  {
    slaveId: 'vm2',
    name: 'VM2 内容工厂节点',
    host: '192.0.2.12',
    system: 'Linux / sample',
    connectionMode: 'remote-agent',
    agentVersion: 'swr-agent 0.1.0',
    mode: 'held',
    holder: 'Alice',
    heartbeatAt: minutesAgo(3),
    expiresAt: minutesFromNow(27),
    manualHoldReason: '调试后等待开发定位接口偶发异常',
    activeRunId: '',
    processSignal: 'python',
    allowedRoots: ['/tmp/swr-debug', '/opt/robot/suites'],
    capabilities: {
      browseRobotRoot: true,
      runRobot: true,
      svnOps: true,
      processInspect: true,
      terminal: true,
      killProcess: true
    }
  },
  {
    slaveId: 'richardpc',
    name: 'richardpc 本地预览节点',
    host: '127.0.0.1',
    system: 'Windows / local preview',
    connectionMode: 'local-agent',
    agentVersion: 'swr-agent 0.1.0',
    mode: 'running',
    holder: 'Humphrey',
    heartbeatAt: minutesAgo(0),
    expiresAt: minutesFromNow(12),
    manualHoldReason: '',
    activeRunId: 'run-richardpc-smoke',
    processSignal: 'robot',
    allowedRoots: ['B:/workspace/smartWebRide/sample_data/Case'],
    capabilities: {
      browseRobotRoot: true,
      runRobot: true,
      svnOps: false,
      processInspect: true,
      terminal: true,
      killProcess: true
    }
  },
  {
    slaveId: 'office-linux-placeholder',
    name: '办公室 Linux slave 占位',
    host: 'pending.office.local',
    system: 'Linux / Jenkins slave',
    connectionMode: 'remote-agent',
    agentVersion: '',
    mode: 'offline',
    holder: '',
    heartbeatAt: '',
    expiresAt: '',
    manualHoldReason: '办公室环境接入后由 Agent 心跳上报',
    activeRunId: '',
    processSignal: 'unknown',
    allowedRoots: [],
    capabilities: {
      browseRobotRoot: false,
      runRobot: false,
      svnOps: false,
      processInspect: false,
      terminal: false,
      killProcess: false
    }
  }
];

export const executionNodes: ExecutionNode[] = slaveSessions.map((session) => ({
  id: session.slaveId,
  name: session.name,
  host: session.host,
  system: session.system,
  status: session.mode === 'held' ? 'locked' : session.mode,
  owner: session.holder,
  lockUntil: session.expiresAt,
  lastRun: session.activeRunId || '暂无真实执行'
}));
