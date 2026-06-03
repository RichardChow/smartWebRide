import { Activity, Eye, Lock, LogOut, Play, RotateCw, ShieldAlert, ShieldCheck, WifiOff } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { canOpenWritableTerminal } from '../lib/terminalLogic';
import type { SlaveSession } from '../types';

interface SlaveStatusHomeProps {
  sessions: SlaveSession[];
  currentUser: string;
  statusMessage?: string;
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

function formatTime(value: string): string {
  if (!value) return '无';
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false });
}

function formatRoots(roots: string[]): string {
  if (roots.length === 0) return '未上报';
  if (roots.length === 1) return roots[0];
  return `${roots[0]} (+${roots.length - 1})`;
}

function formatMode(mode: SlaveSession['connectionMode']): string {
  return mode === 'local-agent' ? '本机 Agent' : '远程 Agent';
}

export function SlaveStatusHome({ sessions, currentUser, statusMessage, onEnterSlave, onReleaseSlave, onForceTakeover }: SlaveStatusHomeProps) {
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

  return (
    <div className="slave-status-home">
      <section className="slave-command-band" aria-labelledby="slave-home-title">
        <div>
          <p className="eyebrow">环境入口</p>
          <h1 id="slave-home-title">选择调试 Slave</h1>
          <p>返回这个页面不会释放环境。只有关闭当前终端会话，或者点击“释放 Slave”，该节点才会回到空闲状态。</p>
        </div>

        <div className="slave-summary-strip" aria-label="Slave 状态统计">
          <span className="status-idle">空闲 {counts.idle}</span>
          <span className="status-held">占用 {counts.held}</span>
          <span className="status-running">运行 {counts.running}</span>
          <span className="status-offline">离线 {counts.offline}</span>
        </div>
      </section>

      {statusMessage ? <p className="slave-center-status">{statusMessage}</p> : null}

      <section className="slave-board" aria-label="Slave 状态列表">
        <div className="slave-board-header">
          <span>状态</span>
          <span>节点</span>
          <span>占用</span>
          <span>心跳 / 进程</span>
          <span>操作</span>
        </div>

        <div className="slave-list">
          {sessions.map((session) => {
            const writable = canOpenWritableTerminal(session, currentUser);
            const ownedByCurrentUser = Boolean(session.holder && session.holder === currentUser);
            const heldByOther = session.mode !== 'offline' && (Boolean(session.holder) && session.holder !== currentUser);
            const readOnly = !writable;
            const disabled = session.mode === 'offline' || !session.capabilities.terminal;
            const actionLabel = disabled ? '不可连接' : ownedByCurrentUser ? '继续终端' : readOnly ? '查看状态' : '连接终端';
            const actionClass = readOnly ? 'secondary-button' : ownedByCurrentUser ? 'continue-button' : 'primary-button';
            const actionHint = disabled
              ? '等待 Agent 心跳恢复'
              : ownedByCurrentUser
                ? '当前账号仍持有调试锁，返回不会释放环境'
                : readOnly
                  ? '别人正在使用，只允许查看状态'
                  : '连接后获取调试锁';

            return (
              <article key={session.slaveId} className={`slave-row status-${session.mode}`}>
                <div className="slave-state-cell">
                  <span className={`status-beacon status-${session.mode}`} aria-hidden="true" />
                  <strong>{statusIcon[session.mode]} {statusText[session.mode]}</strong>
                </div>

                <div className="slave-node-cell">
                  <strong>{session.name}</strong>
                  <span>{session.host} / {session.system}</span>
                  <span>{formatMode(session.connectionMode)} / {session.agentVersion || 'agent 未在线'}</span>
                  <span title={session.allowedRoots.join('\n')}>Robot 目录：{formatRoots(session.allowedRoots)}</span>
                </div>

                <div className="slave-cell">
                  <small>当前持有人</small>
                  <strong>{session.holder || '无'}</strong>
                  <span>锁过期：{formatTime(session.expiresAt)}</span>
                  {session.mode === 'running' && session.processSignal !== 'none' ? (
                    <span className="hold-reason">{session.holder ? 'Robot 运行中' : 'Robot 运行中（无人值守）'}</span>
                  ) : null}
                  {session.jenkinsJob ? <span className="hold-reason">Jenkins: {session.jenkinsJob}</span> : null}
                  {session.manualHoldReason ? <span className="hold-reason">{session.manualHoldReason}</span> : null}
                </div>

                <div className="slave-cell">
                  <small>最近心跳</small>
                  <strong>{formatTime(session.heartbeatAt)}</strong>
                  <span>进程信号：{session.processSignal}</span>
                  <span>
                    能力：{session.capabilities.terminal ? 'PTY' : '-'} / {session.capabilities.runRobot ? 'Robot' : '-'} /{' '}
                    {session.capabilities.killProcess ? 'Stop' : '-'}
                  </span>
                </div>

                <div className="slave-action-cell">
                  <button className={actionClass} disabled={disabled} onClick={() => onEnterSlave(session.slaveId, readOnly)}>
                    {readOnly ? <Eye size={16} /> : ownedByCurrentUser ? <RotateCw size={16} /> : <Play size={16} />}
                    {actionLabel}
                  </button>
                  {ownedByCurrentUser ? (
                    <button className="release-button" onClick={() => onReleaseSlave(session.slaveId)}>
                      <LogOut size={16} />
                      释放 Slave
                    </button>
                  ) : null}
                  {heldByOther ? (
                    <button className="takeover-button" onClick={() => { setTakeoverTarget(session); setTakeoverReason(''); }}>
                      <ShieldAlert size={16} />
                      强制接管
                    </button>
                  ) : null}
                  <span>{actionHint}</span>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <p className="slave-policy-line">
        占用策略：调试锁为准，Agent 心跳只表示机器在线；Robot/Python 进程信号只作为辅助判断，不自动释放环境。
      </p>

      {takeoverTarget ? (
        <div className="takeover-modal-backdrop" role="dialog" aria-modal="true" onClick={() => setTakeoverTarget(null)}>
          <div className="takeover-modal" onClick={(event) => event.stopPropagation()}>
            <h2><ShieldAlert size={18} /> 强制接管 {takeoverTarget.name}</h2>
            <p>当前持有人：<strong>{takeoverTarget.holder || '无'}</strong></p>
            {takeoverTarget.mode === 'running' && takeoverTarget.processSignal !== 'none' ? (
              <p className="takeover-warning">⚠ 检测到该节点有 Robot 任务正在运行，强制接管将关闭其全部会话、可能打断正在运行的任务。</p>
            ) : null}
            <label>
              接管理由（必填）
              <textarea
                value={takeoverReason}
                onChange={(event) => setTakeoverReason(event.target.value)}
                placeholder="说明为何需要强制接管，将记入审计。"
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
