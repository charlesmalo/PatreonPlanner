import { execFileSync } from 'node:child_process';

const DEFAULT_SOCKET_PATH = '/var/run/docker.sock';
const DEFAULT_SOCKET_URI = `unix://${DEFAULT_SOCKET_PATH}`;

/**
 * Testcontainers looks for the daemon at the well-known socket paths and does not read Docker
 * CLI contexts, so runtimes that put their socket elsewhere (Colima, OrbStack, rootless Docker)
 * are invisible to it. Resolve the active context and pass its endpoint through DOCKER_HOST.
 */
export default function globalSetup(): void {
  if (process.env.DOCKER_HOST) return;

  let host: string;
  try {
    host = execFileSync(
      'docker',
      ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    // No docker CLI, or no context: let Testcontainers report the failure itself.
    return;
  }

  if (!host || host === DEFAULT_SOCKET_URI) return;

  process.env.DOCKER_HOST = host;
  // Ryuk mounts the daemon socket by its path *inside* the VM, where it is always the default.
  process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= DEFAULT_SOCKET_PATH;
}
