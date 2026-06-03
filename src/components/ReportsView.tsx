import { CheckCircle2, FileText, Timer, XCircle } from 'lucide-react';
import type { Project, ReportSummary } from '../types';

interface ReportsViewProps {
  project: Project;
}

export function ReportsView({ project }: ReportsViewProps) {
  const failures = project.cases.filter((item) => item.tags.some((tag) => tag.toLowerCase().includes('debug'))).slice(0, 5);
  const report: ReportSummary = {
    id: `report-${project.id}`,
    projectId: project.id,
    runName: `${project.name} mock nightly`,
    status: failures.length > 0 ? 'failed' : 'passed',
    duration: project.id === 'test-suite' ? '28m 42s' : '6m 18s',
    passed: Math.max(8, project.totalCases - failures.length),
    failed: failures.length,
    skipped: project.id === 'test-suite' ? 12 : 1,
    failedCases: failures
  };

  return (
    <div className="view-stack">
      <section className="report-band">
        <div>
          <p className="eyebrow">Report Center</p>
          <h2>{report.runName}</h2>
          <p>当前报告是根据真实 case 索引生成的 mock 摘要。</p>
        </div>
        <span className={`result-mark ${report.status}`}>
          {report.status === 'passed' ? <CheckCircle2 size={20} /> : <XCircle size={20} />}
          {report.status}
        </span>
      </section>

      <section className="metrics-grid">
        <div className="metric-tile pass"><span>通过</span><strong>{report.passed}</strong></div>
        <div className="metric-tile fail"><span>失败</span><strong>{report.failed}</strong></div>
        <div className="metric-tile skip"><span>跳过</span><strong>{report.skipped}</strong></div>
        <div className="metric-tile"><span>耗时</span><strong>{report.duration}</strong></div>
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>失败聚合</h2>
            <p>后续接入 `output.xml` 后替换为真实失败详情。</p>
          </div>
        </div>
        <div className="failure-list">
          {report.failedCases.map((item) => (
            <div key={item.id} className="failure-row">
              <XCircle size={17} />
              <div>
                <strong>{item.name}</strong>
                <span>{item.filePath}</span>
              </div>
              <small>{item.tags.slice(0, 3).join(', ') || 'no tags'}</small>
            </div>
          ))}
          {report.failedCases.length === 0 ? <p className="subtle-text">没有 mock 失败用例。</p> : null}
        </div>
      </section>

      <section className="panel">
        <div className="report-links">
          <button className="secondary-button" disabled><FileText size={16} /> log.html 占位</button>
          <button className="secondary-button" disabled><FileText size={16} /> report.html 占位</button>
          <button className="secondary-button" disabled><Timer size={16} /> output.xml 占位</button>
        </div>
      </section>
    </div>
  );
}
