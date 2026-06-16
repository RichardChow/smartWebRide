import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EnvironmentStatus } from '../types';
import { EnvironmentStatusPanel } from './EnvironmentStatusPanel';

function makeEnvironment(overrides: Partial<EnvironmentStatus> = {}): EnvironmentStatus {
  return {
    environmentId: '233_setup',
    jobName: '233_setup',
    displayName: 'AT Regression 233',
    testBedIp: '172.18.98.233',
    envFile: '233_trex_env.xlsx',
    neDevices: [
      { ip: '200.200.18.101', type: 'NPT1800' },
      { ip: '200.200.13.132', type: 'NPT1300' }
    ],
    status: 'jenkins_running',
    severity: 'busy',
    summary: 'Jenkins build is running.',
    updatedAt: '2026-06-15T02:42:00.000Z',
    signals: [
      { source: 'jenkins', status: 'busy', severity: 'busy', summary: 'Build #395 is running.', detail: { buildNumber: 395 } }
    ],
    neSessions: [
      { targetIp: '200.200.18.101', user: 'admin', sourceIp: '172.18.98.119', protocol: 'ssh', since: '', raw: '' }
    ],
    ...overrides
  };
}

describe('EnvironmentStatusPanel', () => {
  it('renders configured NE devices and busy signals', () => {
    render(<EnvironmentStatusPanel statuses={[makeEnvironment()]} />);

    expect(screen.getByRole('region', { name: '测试环境占用状态' })).toBeInTheDocument();
    expect(screen.getByText('AT Regression 233')).toBeInTheDocument();
    expect(screen.getByText('Jenkins 运行')).toBeInTheDocument();
    expect(screen.getByText('200.200.18.101 NPT1800')).toBeInTheDocument();
    expect(screen.getByText('jenkins: Build #395 is running.')).toBeInTheDocument();
    expect(screen.getByText('NE session: admin@200.200.18.101')).toBeInTheDocument();
  });

  it('shows unknown probe state without claiming the environment is free', () => {
    render(
      <EnvironmentStatusPanel
        statuses={[
          makeEnvironment({
            status: 'unknown',
            severity: 'unknown',
            summary: 'Office probe is not configured.',
            signals: [{ source: 'jenkins', status: 'unknown', severity: 'unknown', summary: 'Jenkins probe is not configured.', detail: {} }],
            neSessions: []
          })
        ]}
      />
    );

    expect(screen.getByText('未知')).toBeInTheDocument();
    expect(screen.getByText('Office probe is not configured.')).toBeInTheDocument();
    expect(screen.queryByText('Jenkins 运行')).not.toBeInTheDocument();
  });
});
