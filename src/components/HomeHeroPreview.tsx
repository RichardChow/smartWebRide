import { Activity, RadioTower, Server, TerminalSquare } from 'lucide-react';
import heroImage from '../assets/smartwebride-hero-candidate-20260609.png';
import type { SlaveSession } from '../types';
import { SlaveStatusHome } from './SlaveStatusHome';

interface HomeHeroPreviewProps {
  sessions: SlaveSession[];
  currentUser: string;
  statusMessage?: string;
  onEnterSlave: (slaveId: string, readOnly: boolean) => void;
  onReleaseSlave: (slaveId: string) => void;
  onForceTakeover: (slaveId: string, reason: string) => void;
}

export function HomeHeroPreview(props: HomeHeroPreviewProps) {
  const onlineCount = props.sessions.filter((session) => session.mode !== 'offline').length;
  const writableCount = props.sessions.filter((session) => session.mode === 'idle').length;
  const runningCount = props.sessions.filter((session) => session.mode === 'running').length;

  return (
    <div className="home-hero-preview">
      <section className="home-hero-preview-console" aria-labelledby="home-hero-preview-title">
        <div className="home-hero-preview-band">
          <img className="home-hero-preview-image" src={heroImage} alt="" aria-hidden="true" />
        <div className="home-hero-preview-scrim" aria-hidden="true" />
        <div className="home-hero-preview-copy">
          <p className="eyebrow">备用探索 / Smart RIDE Console</p>
          <h1 id="home-hero-preview-title">选择调试 Slave</h1>
          <p>在同一个控制台里确认节点心跳、占用状态和 Robot 调试环境，然后进入 Web SSH 终端。</p>
          </div>
          <div className="home-hero-preview-metrics" aria-label="预览状态摘要">
            <span>
              <Server size={16} />
              在线 {onlineCount}
            </span>
            <span>
              <TerminalSquare size={16} />
              可连接 {writableCount}
            </span>
            <span>
              <Activity size={16} />
              运行 {runningCount}
            </span>
          </div>
        </div>

        <div className="home-hero-preview-console-head">
          <div>
            <span><RadioTower size={15} /> Center Live Console</span>
            <strong>Slave 状态与调试入口</strong>
          </div>
          <p>备用探索页，不作为当前默认首页。</p>
        </div>

        <SlaveStatusHome {...props} hideCommandBand />
      </section>
    </div>
  );
}
