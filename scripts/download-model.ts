import { mkdir, rename, rm } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { normalizeModel } from '../src/transcription/models.js';

const model = normalizeModel(process.argv[2] ?? loadConfig().defaultModel);
const directory = loadConfig().modelsDirectory;
await mkdir(directory, { recursive: true });
const path = join(directory, `ggml-${model}.bin`);
const temporary = `${path}.download`;
const response = await fetch(
  `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`,
  { signal: AbortSignal.timeout(600_000) },
);
if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
try {
  const reader = response.body.getReader();
  async function* chunks() {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  await pipeline(Readable.from(chunks()), createWriteStream(temporary, { mode: 0o600 }));
  const hash = createHash('sha1');
  for await (const chunk of createReadStream(temporary)) hash.update(chunk);
  const known: Record<string, string> = {
    tiny: 'bd577a113a864445d4c299885e0cb97d4ba92b5f',
    'tiny.en': 'c78c86eb1a8faa21b369bcd33207cc90d64ae9df',
    base: '465707469ff3a37a2b9b8d8f89f2f99de7299dac',
    'base.en': '137c40403d78fd54d454da0f9bd998f78703390c',
    small: '55356645c2b361a969dfd0ef2c5a50d530afd8d5',
    'small.en': 'db8a495a91d927739e50b3fc1cc4c6b8f6c2d022',
    medium: 'fd9727b6e1217c2f614f9b698455c4ffd82463b4',
    'medium.en': '8c30f0e44ce9560643ebd10bbe50cd20eafd3723',
    'large-v3': 'ad82bf6a9043ceed055076d0fd39f5f186ff8062',
    'large-v3-q5_0': 'e6e2ed78495d403bef4b7cff42ef4aaadcfea8de',
    'large-v3-turbo': '4af2b29d7ec73d781377bfd1758ca957a807e941',
    'large-v3-turbo-q5_0': 'e050f7970618a659205450ad97eb95a18d69c9ee',
  };
  if (hash.digest('hex') !== known[model])
    throw new Error('Model checksum mismatch; download was not installed.');
  await rename(temporary, path);
  console.log(`Installed ${path}`);
} finally {
  await rm(temporary, { force: true });
}
