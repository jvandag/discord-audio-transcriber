import { mkdir, access } from 'node:fs/promises';
import { runProcess } from '../src/shared/process.js';

const directory = 'vendor/whisper.cpp';
const revision = '48f628a84833905ee4a0658ee6d4a5c915ce1997'; // v1.8.7
await mkdir('vendor', { recursive: true });
try {
  await access(`${directory}/CMakeLists.txt`);
} catch {
  await runProcess(
    'git',
    [
      'clone',
      '--depth',
      '1',
      '--branch',
      'v1.8.7',
      'https://github.com/ggml-org/whisper.cpp.git',
      directory,
    ],
    180_000,
  );
}
const actual = (await runProcess('git', ['-C', directory, 'rev-parse', 'HEAD'])).trim();
if (actual !== revision)
  throw new Error('Existing vendor/whisper.cpp has another revision; move it aside before setup.');
await runProcess(
  'cmake',
  [
    '-S',
    directory,
    '-B',
    `${directory}/build`,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DGGML_CUDA=OFF',
    '-DWHISPER_BUILD_TESTS=OFF',
    '-DWHISPER_BUILD_SERVER=OFF',
  ],
  60_000,
);
await runProcess(
  'cmake',
  ['--build', `${directory}/build`, '--config', 'Release', '-j', '4', '--target', 'whisper-cli'],
  600_000,
);
console.log(
  `Built ${directory}/build/bin/whisper-cli (v1.8.7). Next: npm run model:download -- base.en`,
);
