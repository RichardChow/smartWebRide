import { expect, test } from '@playwright/test';

const slaveFixtures = [
  {
    slaveId: 'vm1',
    name: 'VM1 主控调试节点',
    host: '192.0.2.11',
    system: 'Linux / VMware',
    connectionMode: 'remote-agent',
    agentVersion: 'swr-agent-test',
    mode: 'idle',
    holder: '',
    heartbeatAt: new Date().toISOString(),
    expiresAt: '',
    manualHoldReason: '',
    activeRunId: '',
    processSignal: 'none',
    allowedRoots: ['/tmp/swr-debug', '/opt/robot/cases'],
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
    slaveId: 'vm2',
    name: 'VM2 内容节点',
    host: '192.0.2.12',
    system: 'Linux / VMware',
    connectionMode: 'remote-agent',
    agentVersion: 'swr-agent-test',
    mode: 'held',
    holder: 'Alice',
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    manualHoldReason: '排查失败用例',
    activeRunId: '',
    processSignal: 'none',
    allowedRoots: ['/tmp/swr-debug', '/opt/robot/suites'],
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
    slaveId: 'vm3',
    name: '运行中节点',
    host: '192.0.2.13',
    system: 'Linux',
    connectionMode: 'remote-agent',
    agentVersion: 'swr-agent-test',
    mode: 'running',
    holder: 'Bob',
    heartbeatAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    manualHoldReason: '',
    activeRunId: 'run-1',
    processSignal: 'robot',
    allowedRoots: ['/tmp/swr-debug'],
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
    slaveId: 'offline',
    name: '离线节点',
    host: '192.0.2.14',
    system: 'Linux',
    connectionMode: 'remote-agent',
    agentVersion: '',
    mode: 'offline',
    holder: '',
    heartbeatAt: '',
    expiresAt: '',
    manualHoldReason: '',
    activeRunId: '',
    processSignal: 'none',
    allowedRoots: ['/tmp/swr-debug'],
    capabilities: {
      browseRobotRoot: true,
      runRobot: true,
      svnOps: false,
      processInspect: true,
      terminal: true,
      killProcess: true
    }
  }
];

test.beforeEach(async ({ page }) => {
  let currentSlaves = JSON.parse(JSON.stringify(slaveFixtures));

  await page.route('**/api/slaves', async (route) => {
    await route.fulfill({ json: currentSlaves });
  });

  await page.route('**/api/slaves/vm1/lock', async (route) => {
    const lockedVm1 = {
      ...currentSlaves[0],
      mode: 'held',
      holder: 'Humphrey',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      manualHoldReason: 'Web SSH 调试锁'
    };
    currentSlaves = [lockedVm1, ...currentSlaves.slice(1)];
    await route.fulfill({
      json: lockedVm1
    });
  });

  await page.route('**/api/slaves/vm1/terminal/sessions', async (route) => {
    await route.fulfill({ json: { id: 'e2e-session', slaveId: 'vm1', shell: '/bin/bash', readOnly: false } });
  });
});

test('slave home only exposes slave status entry', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '选择调试 Slave' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'RIDE Workspace' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '工作台' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '项目浏览' })).toHaveCount(0);
  await expect(page.getByText('空闲').first()).toBeVisible();
  await expect(page.getByText('占用').first()).toBeVisible();
  await expect(page.getByText('运行中').first()).toBeVisible();
  await expect(page.getByText('离线').first()).toBeVisible();
});

test('idle slave enters smartWebRide terminal without HomeHub dependency text', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '连接终端' }).click();
  await expect(page.getByRole('region', { name: 'SmartSSH 终端' })).toBeVisible();
  await expect(page.getByText('smartWebRide Center / Agent', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'VM1 主控调试节点' })).toBeVisible();
  await expect(page.getByText('HomeHub')).toHaveCount(0);
  await expect(page.getByText('localhost:8001')).toHaveCount(0);
});

test('current lock holder can continue terminal from slave home', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: '连接终端' }).click();
  await expect(page.getByRole('region', { name: 'SmartSSH 终端' })).toBeVisible();
  await page.getByRole('button', { name: '返回 Slave' }).click();

  await expect(page.getByRole('button', { name: '继续终端' })).toBeVisible();
  await page.getByRole('button', { name: '继续终端' }).click();
  await expect(page.getByRole('region', { name: 'SmartSSH 终端' })).toBeVisible();
  await expect(page.getByText('只读页面不会创建 PTY')).toHaveCount(0);
});

test('occupied slave opens read-only terminal status', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '查看状态' }).first().click();

  await expect(page.getByRole('region', { name: 'SmartSSH 终端' })).toBeVisible();
  await expect(page.getByText('当前由 Alice 占用，只允许查看状态。')).toBeVisible();
  await expect(page.getByText('只读页面不会创建 PTY，也不会写入远程文件。')).toBeVisible();
  await expect(page.getByRole('button', { name: '文件' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ctrl+C' })).toHaveCount(0);
});
