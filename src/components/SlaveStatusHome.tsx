import { Activity, Eye, Lock, LogOut, Play, RotateCw, Server, ShieldAlert, ShieldCheck, WifiOff } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { canOpenWritableTerminal } from '../lib/terminalLogic';
import type { EnvironmentStatus, SlaveSession } from '../types';
import { EnvironmentStatusPanel } from './EnvironmentStatusPanel';

interface SlaveStatusHomeProps {
  sessions: SlaveSession[];
  environmentStatuses?: EnvironmentStatus[];
  currentUser: string;
  statusMessage?: string;
  hideCommandBand?: boolean;
  onEnterSlave: (slaveId: string, readOnly: boolean) => void;
  onReleaseSlave: (slaveId: string) => void;
  onForceTakeover: (slaveId: string, reason: string) => void;
}

const statusText: Record<SlaveSession['mode'], string> = {
  idle: '空闲',
  held: '占用',
  running: '运行中',
  offline: '离线'
};

const statusIcon: Record<SlaveSession['mode'], ReactNode> = {
  idle: <ShieldCheck size={16} />,
  held: <Lock size={16} />,
  running: <Activity size={16} />,
  offline: <WifiOff size={16} />
};

const summaryLabels: Record<SlaveSession['mode'], string> = {
  idle: '空闲',
  held: '占用',
  running: '运行',
  offline: '离线'
};

const statusDescriptions: Record<SlaveSession['mode'], string> = {
  idle: '可以获取调试锁',
  held: '已有用户持锁',
  running: '检测到 Robot 进程',
  offline: '等待 Agent 回连'
};

function formatTime(value: string): string {
  if (!value) return '无';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '无';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function formatMode(mode: SlaveSession['connectionMode']): string {
  return mode === 'local-agent' ? '本机 Agent' : '远程 Agent';
}

function formatAgentConnection(session: SlaveSession): string {
  return `${formatMode(session.connectionMode)} / ${session.agentVersion || 'Agent 未在线'}`;
}

function formatRuntimeVersion(value: string): string {
  return value || '未上报';
}

function formatProcessSignal(signal: SlaveSession['processSignal']): string {
  switch (signal) {
    case 'robot':
      return 'Robot';
    case 'python':
      return 'Python';
    case 'unknown':
      return '未知';
    case 'none':
    default:
      return '无';
  }
}

function getSlaveAction(session: SlaveSession, currentUser: string) {
  const writable = canOpenWritableTerminal(session, currentUser);
  const ownedByCurrentUser = Boolean(session.holder && session.holder === currentUser);
  const heldByOther = session.mode !== 'offline' && Boolean(session.holder && session.holder !== currentUser);
  const readOnly = !writable;
  const disabled = session.mode === 'offline' || !session.capabilities.terminal;
  const label = disabled ? '不可连接' : ownedByCurrentUser ? '继续终端' : readOnly ? '查看状态' : '连接终端';
  const hint = disabled
    ? '等待 Agent 心跳恢复'
    : ownedByCurrentUser
      ? '当前账号仍持有调试锁，返回不会释放环境'
      : readOnly
        ? '别人正在使用，只允许查看状态'
        : '连接后获取调试锁';
  const className = readOnly ? 'secondary-button' : ownedByCurrentUser ? 'continue-button' : 'primary-button';

  return { className, disabled, heldByOther, hint, label, ownedByCurrentUser, readOnly };
}

function FieldLine({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="slave-field-line">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function SlaveStatusHome({ sessions, environmentStatuses = [], currentUser, statusMessage, hideCommandBand = false, onEnterSlave, onReleaseSlave, onForceTakeover }: SlaveStatusHomeProps) {
  const [takeoverTarget, setTakeoverTarget] = useState<SlaveSession | null>(null);
  const [takeoverReason, setTakeoverReason] = useState('');

  function confirmTakeover() {
    if (!takeoverTarget || !takeoverReason.trim()) return;
    onForceTakeover(takeoverTarget.slaveId, takeoverReason.trim());
    setTakeoverTarget(null);
    setTakeoverReason('');
  }

  const counts = sessions.reduce(
    (acc, session) => {
      acc[session.mode] += 1;
      return acc;
    },
    { idle: 0, held: 0, running: 0, offline: 0 } as Record<SlaveSession['mode'], number>
  );

  const summaryItems = (['idle', 'held', 'running', 'offline'] as Array<SlaveSession['mode']>).map((mode) => ({
    count: counts[mode],
    label: summaryLabels[mode],
    mode
  }));

  return (
    <div className="slave-status-home">
      {hideCommandBand ? null : (
        <section className="slave-command-band" aria-labelledby="slave-home-title">
          <div className="slave-command-copy">
            <p className="eyebrow">环境入口</p>
            <h1 id="slave-home-title">选择调试 Slave</h1>
            <p>返回这个页面不会释放环境。只有关闭当前终端会话，或者点击“释放 Slave”，该节点才会回到空闲状态。</p>
          </div>

          <div className="slave-summary-strip" aria-label="Slave 状态统计">
            {summaryItems.map((item) => (
              <span key={item.mode} className={`status-summary-card status-${item.mode}`}>
                <small>{item.label}</small>
                <strong>{item.count}</strong>
              </span>
            ))}
          </div>
        </section>
      )}

      {statusMessage ? <p className="slave-center-status">{statusMessage}</p> : null}

      <EnvironmentStatusPanel statuses={environmentStatuses} />

      <section className="slave-board" aria-label="Slave 状态列表">
        <div className="slave-list">
          {sessions.map((session) => {
            const action = getSlaveAction(session, currentUser);

            return (
              <article key={session.slaveId} className={`slave-card status-${session.mode}`} aria-label={`${session.name} 状态 ${statusText[session.mode]}`}>
                <div className="slave-card-status">
                  <span className={`status-beacon status-${session.mode}`} aria-hidden="true" />
                  <div>
                    <strong>{statusIcon[session.mode]} {statusText[session.mode]}</strong>
                    <span>{statusDescriptions[session.mode]}</span>
                  </div>
                </div>

                <div className="slave-card-main">
                  <div className="slave-node-heading">
                    <Server size={17} />
                    <div>
                      <strong>{session.name}</strong>
                      <span>Slave ID: {session.slaveId}</span>
                    </div>
                  </div>
                  <div className="slave-meta-grid">
                    <FieldLine label="主机" value={session.host} />
                    <FieldLine label="系统" value={session.system} />
                    <FieldLine label="连接" value={formatAgentConnection(session)} />
                    <FieldLine label="Python" value={formatRuntimeVersion(session.pythonVersion)} />
                    <FieldLine label="Robot" value={formatRuntimeVersion(session.robotVersion)} />
                  </div>
                </div>

                <div className="slave-card-health">
                  <FieldLine label="持有人" value={session.holder || '无'} />
                  <FieldLine label="自动释放时间" value={formatTime(session.expiresAt)} />
                  <FieldLine label="Agent 心跳" value={formatTime(session.heartbeatAt)} />
                  <FieldLine label="Robot 进程" value={formatProcessSignal(session.processSignal)} />
                  {session.mode === 'running' && session.processSignal !== 'none' ? (
                    <span className="hold-reason">{session.holder ? 'Robot 运行中' : 'Robot 运行中（无人值守）'}</span>
                  ) : null}
                  {session.jenkinsJob ? <span className="hold-reason">Jenkins: {session.jenkinsJob}</span> : null}
                  {session.manualHoldReason ? <span className="hold-reason">{session.manualHoldReason}</span> : null}
                </div>

                <div className="slave-card-actions">
                  <button className={action.className} disabled={action.disabled} onClick={() => onEnterSlave(session.slaveId, action.readOnly)}>
                    {action.readOnly ? <Eye size={16} /> : action.ownedByCurrentUser ? <RotateCw size={16} /> : <Play size={16} />}
                    {action.label}
                  </button>
                  {action.ownedByCurrentUser ? (
                    <button className="release-button" onClick={() => onReleaseSlave(session.slaveId)}>
                      <LogOut size={16} />
                      释放 Slave
                    </button>
                  ) : null}
                  {action.heldByOther ? (
                    <button className="takeover-button" onClick={() => { setTakeoverTarget(session); setTakeoverReason(''); }}>
                      <ShieldAlert size={16} />
                      强制接管
                    </button>
                  ) : null}
                  <span>{action.hint}</span>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <p className="slave-policy-line">
        占用说明：占用锁决定可写调试权限；Agent 心跳只表示连接在线；Robot 进程用于辅助识别运行态，不会自动释放环境。
      </p>

      {takeoverTarget ? (
        <div className="takeover-modal-backdrop" role="dialog" aria-modal="true" onClick={() => setTakeoverTarget(null)}>
          <div className="takeover-modal" onClick={(event) => event.stopPropagation()}>
            <h2><ShieldAlert size={18} /> 强制接管 {takeoverTarget.name}</h2>
            <p>当前持有人：<strong>{takeoverTarget.holder || '无'}</strong></p>
            {takeoverTarget.mode === 'running' && takeoverTarget.processSignal !== 'none' ? (
              <p className="takeover-warning"><ShieldAlert size={16} /> 检测到该节点有 Robot 任务正在运行，强制接管将关闭其全部会话、可能打断正在运行的任务。</p>
            ) : null}
            <label>
              接管理由（必填）
              <textarea
                value={takeoverReason}
                onChange={(event) => setTakeoverReason(event.target.value)}
                placeholder="说明为什么需要强制接管，将记入审计。"
                rows={3}
              />
            </label>
            <div className="takeover-modal-actions">
              <button className="secondary-button" onClick={() => setTakeoverTarget(null)}>取消</button>
              <button className="takeover-button" disabled={!takeoverReason.trim()} onClick={confirmTakeover}>
                <ShieldAlert size={16} /> 确认接管
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
