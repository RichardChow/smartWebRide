import type { Project } from '../types';

export interface FixturePayload {
  generatedAt: string;
  projects: Project[];
}

const fixturePaths = ['/fixtures/generated-fixtures.json', '/fixtures/generated-fixtures.example.json'];

export async function loadProjects(): Promise<FixturePayload> {
  let lastError = '';
  for (const fixturePath of fixturePaths) {
    const response = await fetch(fixturePath);
    if (response.ok) return (await response.json()) as FixturePayload;
    lastError = `${fixturePath}: ${response.status} ${response.statusText}`;
  }
  throw new Error(`Failed to load project fixtures: ${lastError}`);
}
