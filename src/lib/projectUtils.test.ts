import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Project } from '../types';
import { buildMockDiff, createMockRunSession, flattenTree, getDefaultRobotPath, searchCases } from './projectUtils';

const payload = JSON.parse(readFileSync(path.join(process.cwd(), 'public', 'fixtures', 'generated-fixtures.example.json'), 'utf8')) as {
  projects: Project[];
};
const projects = payload.projects;

describe('project fixture utilities', () => {
  it('loads the public sample project', () => {
    expect(projects.map((item) => item.name)).toEqual(['Sample Robot Project']);
    expect(projects[0].totalRobotFiles).toBeGreaterThan(0);
    expect(projects[0].totalCases).toBeGreaterThan(0);
  });

  it('flattens the generated tree and keeps robot files indexed', () => {
    const nodes = flattenTree(projects[0].tree);
    expect(nodes.some((node) => node.path.endsWith('.robot'))).toBe(true);
    expect(getDefaultRobotPath(projects[0])).toMatch(/\.robot$/);
  });

  it('searches cases across name, path, tags and docs', () => {
    const results = searchCases(projects[0], 'ipv4');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].projectId).toBe(projects[0].id);
  });

  it('creates mock run sessions without calling Robot Framework', () => {
    const session = createMockRunSession(projects[0], 'ipv4', 'vm2');
    expect(session.logs.join('\n')).toContain('--dryrun is skipped');
    expect(session.nodeId).toBe('vm2');
  });

  it('builds VCS changes without binding the UI to real SVN', () => {
    const changes = buildMockDiff(projects[0]);
    expect(changes).toHaveLength(3);
    expect(changes[0].diff).toContain('smartWebRide phase-1 mock diff');
  });
});
