import { Activity, AlertTriangle, CheckCircle2, CircleHelp, Network, RadioTower, Server } from 'lucide-react';
import type { ReactNode } from 'react';
import type { EnvironmentOccupancyStatus, EnvironmentSeverity, EnvironmentSignal, EnvironmentStatus } from '../types';

interface EnvironmentStatusPanelProps {
  statuses: EnvironmentStatus[];
}

const statusLabels: Record<EnvironmentOccupancyStatus, string> = {
  free: '空闲',
  jenkins_running: 'Jenkins 运行',
  manual_robot_active: '手工 Robot',
  manual_robot_stale: '疑似遗留',
  login_only: '网元登录',
  smartwebride_held: '平台占用',
  unknown: '未知'
};

const severityIcons: Record<EnvironmentSeverity, ReactNode> = {
  free: <CheckCircle2 size={16} />,
  warning: <AlertTriangle size={16} />,
  busy: <Activity size={16} />,
  unknown: <CircleHelp size={16} />
};

function formatSignal(signal: EnvironmentSignal): string {
  return `${signal.source}: ${signal.summary || signal.status}`;
}

export function EnvironmentStatusPanel({ statuses }: EnvironmentStatusPanelProps) {
  if (statuses.length === 0) return null;

  const counts = statuses.reduce(
    (acc, item) => {
      acc[item.severity] += 1;
      return acc;
    },
    { free: 0, warning: 0, busy: 0, unknown: 0 } as Record<EnvironmentSeverity, number>
  );

  return (
    <section className="environment-panel" aria-label="测试环境占用状态">
      <div className="environment-panel-head">
        <div>
          <p className="eyebrow">AT Regression</p>
          <h2>测试环境占用</h2>
        </div>
        <div className="environment-summary" aria-label="测试环境统计">
          <span className="env-summary-item env-severity-busy">忙碌 {counts.busy}</span>
          <span className="env-summary-item env-severity-warning">注意 {counts.warning}</span>
          <span className="env-summary-item env-severity-free">空闲 {counts.free}</span>
          <span className="env-summary-item env-severity-unknown">未知 {counts.unknown}</span>
        </div>
      </div>

      <div className="environment-list">
        {statuses.map((item) => (
          <article key={item.environmentId} className={`environment-card env-severity-${item.severity}`}>
            <div className="environment-status-cell">
              <span className={`environment-status-mark env-severity-${item.severity}`}>{severityIcons[item.severity]}</span>
              <div>
                <strong>{statusLabels[item.status]}</strong>
                <span>{item.summary}</span>
              </div>
            </div>

            <div className="environment-main-cell">
              <div className="environment-title">
                <Server size={17} />
                <div>
                  <strong>{item.displayName}</strong>
                  <span>{item.jobName} / {item.testBedIp}</span>
                </div>
              </div>
              <div className="environment-file-line">
                <RadioTower size={15} />
                <span>{item.envFile}</span>
              </div>
            </div>

            <div className="environment-ne-cell">
              <strong><Network size={15} /> 网元</strong>
              <div className="environment-device-list">
                {item.neDevices.map((device) => (
                  <span key={device.ip} className="environment-device-chip" title={device.type || device.ip}>
                    {device.ip}{device.type ? ` ${device.type}` : ''}
                  </span>
                ))}
              </div>
            </div>

            <div className="environment-signal-cell">
              <strong>信号</strong>
              <div className="environment-signal-list">
                {item.signals.slice(0, 4).map((signal) => (
                  <span key={`${item.environmentId}-${signal.source}`} className={`environment-signal env-severity-${signal.severity}`}>
                    {formatSignal(signal)}
                  </span>
                ))}
                {item.neSessions.length > 0 ? (
                  <span className="environment-signal env-severity-warning">
                    NE session: {item.neSessions.map((session) => `${session.user || 'user'}@${session.targetIp}`).join(', ')}
                  </span>
                ) : null}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
