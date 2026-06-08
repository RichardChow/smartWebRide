import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SlaveSession } from '../types';
import { SlaveStatusHome } from './SlaveStatusHome';

function makeSlave(overrides: Partial<SlaveSession> = {}): SlaveSession {
  return {
    slaveId: 'vm1',
    name: 'VM1 main debug node',
    host: '192.0.2.11',
    system: 'Linux / VMware',
    connectionMode: 'remote-agent',
    agentVersion: 'swr-agent-test',
    pythonVersion: '3.12.3',
    robotVersion: 'Robot Framework 7.4.2',
    mode: 'idle',
    holder: '',
    heartbeatAt: '2026-06-08T02:55:00.000Z',
    expiresAt: '',
    manualHoldReason: '',
    activeRunId: '',
    processSignal: 'none',
    allowedRoots: ['/root/debug', '/home/pzhou'],
    capabilities: {
      browseRobotRoot: true,
      runRobot: true,
      svnOps: true,
      processInspect: true,
      terminal: true,
      killProcess: true
    },
    ...overrides
  };
}

function renderHome(sessions: SlaveSession[]) {
  const onEnterSlave = vi.fn();
  const onReleaseSlave = vi.fn();
  const onForceTakeover = vi.fn();

  render(
    <SlaveStatusHome
      sessions={sessions}
      currentUser="Humphrey"
      statusMessage="Center 在线，Slave 状态来自真实 Agent 心跳"
      onEnterSlave={onEnterSlave}
      onReleaseSlave={onReleaseSlave}
      onForceTakeover={onForceTakeover}
    />
  );

  return { onEnterSlave, onForceTakeover, onReleaseSlave };
}

describe('SlaveStatusHome', () => {
  it('renders an idle slave as a writable terminal target', () => {
    const { onEnterSlave } = renderHome([makeSlave()]);

    expect(screen.getByRole('article', { name: 'VM1 main debug node 状态 空闲' })).toBeInTheDocument();
    expect(screen.getByText('Slave ID: vm1')).toBeInTheDocument();
    expect(screen.getByText('192.0.2.11')).toBeInTheDocument();
    expect(screen.getByText('Linux / VMware')).toBeInTheDocument();
    expect(screen.getByText('远程 Agent / swr-agent-test')).toBeInTheDocument();
    expect(screen.getByText('3.12.3')).toBeInTheDocument();
    expect(screen.getByText('Robot Framework 7.4.2')).toBeInTheDocument();
    expect(screen.queryByText('Robot 目录')).not.toBeInTheDocument();
    expect(screen.getByText('自动释放时间')).toBeInTheDocument();
    expect(screen.queryByText('PTY')).not.toBeInTheDocument();
    expect(screen.queryByText('Stop')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '连接终端' }));

    expect(onEnterSlave).toHaveBeenCalledWith('vm1', false);
  });

  it('lets the current holder continue and release the terminal', () => {
    const { onEnterSlave, onReleaseSlave } = renderHome([makeSlave({ mode: 'held', holder: 'Humphrey', expiresAt: '2026-06-08T03:10:00.000Z' })]);

    fireEvent.click(screen.getByRole('button', { name: '继续终端' }));
    fireEvent.click(screen.getByRole('button', { name: '释放 Slave' }));

    expect(onEnterSlave).toHaveBeenCalledWith('vm1', false);
    expect(onReleaseSlave).toHaveBeenCalledWith('vm1');
  });

  it('shows read-only entry and takeover flow for a slave held by another user', () => {
    const { onEnterSlave, onForceTakeover } = renderHome([
      makeSlave({
        mode: 'running',
        holder: 'Alice',
        expiresAt: '2026-06-08T03:10:00.000Z',
        manualHoldReason: 'Alice 正在定位问题',
        processSignal: 'robot'
      })
    ]);

    expect(screen.getByText('Robot 进程')).toBeInTheDocument();
    expect(screen.getByText('Robot 运行中')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '查看状态' }));
    expect(onEnterSlave).toHaveBeenCalledWith('vm1', true);

    fireEvent.click(screen.getByRole('button', { name: '强制接管' }));

    expect(screen.getByText('检测到该节点有 Robot 任务正在运行，强制接管将关闭其全部会话、可能打断正在运行的任务。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认接管' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('接管理由（必填）'), { target: { value: '紧急调试' } });
    fireEvent.click(screen.getByRole('button', { name: '确认接管' }));

    expect(onForceTakeover).toHaveBeenCalledWith('vm1', '紧急调试');
  });

  it('disables terminal connection for an offline slave', () => {
    const { onEnterSlave } = renderHome([makeSlave({ agentVersion: '', mode: 'offline', heartbeatAt: '', capabilities: { ...makeSlave().capabilities, terminal: true } })]);

    const button = screen.getByRole('button', { name: '不可连接' });
    expect(button).toBeDisabled();

    fireEvent.click(button);
    expect(onEnterSlave).not.toHaveBeenCalled();
  });
});
