import type { EnvironmentStatus, ExecutionNode, SlaveSession } from '../types';

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
    pythonVersion: '3.12.3',
    robotVersion: 'Robot Framework 7.4.2',
    mode: 'idle',
    holder: '',
    holderEmail: '',
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
    pythonVersion: '3.12.3',
    robotVersion: 'Robot Framework 7.4.2',
    mode: 'held',
    holder: 'Alice',
    holderEmail: 'alice@example.com',
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
    pythonVersion: '3.12.3',
    robotVersion: 'Robot Framework 7.4.2',
    mode: 'running',
    holder: 'Humphrey',
    holderEmail: 'humphrey@example.com',
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
    pythonVersion: '',
    robotVersion: '',
    mode: 'offline',
    holder: '',
    holderEmail: '',
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

export const environmentStatuses: EnvironmentStatus[] = [
  {
    environmentId: '233_setup',
    jobName: '233_setup',
    displayName: 'AT Regression 233',
    testBedIp: '172.18.98.233',
    envFile: '233_trex_env.xlsx',
    neDevices: [
      { ip: '200.200.18.101', type: 'NPT1800' },
      { ip: '200.200.13.132', type: 'NPT1300' },
      { ip: '200.200.122.201', type: 'NPT1022' },
      { ip: '200.200.15.150', type: 'NPT1050i' }
    ],
    status: 'jenkins_running',
    severity: 'busy',
    summary: 'Jenkins build is running in the office sample signal.',
    updatedAt: minutesAgo(0),
    signals: [
      { source: 'jenkins', status: 'busy', severity: 'busy', summary: '233_setup build is running.', detail: { buildNumber: 395 } },
      { source: 'robot', status: 'warning', severity: 'warning', summary: 'Manual Robot process looks stale.', detail: { cwd: '/root/debug/tyl_debug' } }
    ],
    neSessions: [
      { targetIp: '200.200.18.101', user: 'admin', sourceIp: '172.18.98.119', protocol: 'ssh', since: '', raw: '' }
    ]
  },
  {
    environmentId: '234_setup',
    jobName: '234_setup',
    displayName: 'AT Regression 234',
    testBedIp: '172.18.98.234',
    envFile: '234_trex_env.xlsm',
    neDevices: [
      { ip: '200.200.125.129', type: 'NPT1250' },
      { ip: '200.200.24.224', type: 'NPT2400A' },
      { ip: '200.200.105.151', type: 'NPT1050i' },
      { ip: '200.200.112.213', type: 'NPT1012D' }
    ],
    status: 'free',
    severity: 'free',
    summary: 'No active sample signal detected.',
    updatedAt: minutesAgo(2),
    signals: [
      { source: 'jenkins', status: 'free', severity: 'free', summary: 'Jenkins is idle.', detail: {} },
      { source: 'robot', status: 'free', severity: 'free', summary: 'Robot process is absent.', detail: {} }
    ],
    neSessions: []
  },
  {
    environmentId: '249_setup',
    jobName: '249_setup',
    displayName: 'AT Regression 249',
    testBedIp: '172.18.98.249',
    envFile: '249_breakout_env.xlsx',
    neDevices: [
      { ip: '200.200.23.231', type: 'NPT2300' },
      { ip: '200.200.21.210', type: 'NPT2100A' },
      { ip: '200.200.122.209', type: 'NPT1022B' },
      { ip: '200.200.11.114', type: 'NPT1100' }
    ],
    status: 'unknown',
    severity: 'unknown',
    summary: 'Office probe is not configured in local preview.',
    updatedAt: minutesAgo(5),
    signals: [
      { source: 'jenkins', status: 'unknown', severity: 'unknown', summary: 'Jenkins probe is not configured.', detail: {} },
      { source: 'ne', status: 'unknown', severity: 'unknown', summary: 'NE session probe is not configured.', detail: {} }
    ],
    neSessions: []
  }
];
