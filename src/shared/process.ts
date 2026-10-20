import { spawn } from 'node:child_process';
/** Bounded output, no shell interpolation, and a timeout with kill escalation. */
export function runProcess(
  executable: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let output = '';
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const collect = (data: Buffer) => {
      output = (output + data.toString()).slice(-16_384);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      // Native tools may print speech; do not expose their output in errors/logs.
      if (timedOut || code !== 0)
        reject(new Error(`${executable} ${timedOut ? 'timed out' : `exited with code ${code}`}`));
      else resolve(output);
    });
  });
}
