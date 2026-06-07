import { compileFix, REJECT } from '../dist/index.js';
import fs from 'fs';
import readline from 'node:readline';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

async function main() {
    await runPipeline();
}

function fixStream(src) {
  const fix = compileFix(src);
  return new Transform({
    objectMode: true,
    transform(record, _enc, cb) {
      const out = fix(record);
      if (out === REJECT) cb(); 
      else cb(null, out);
    },
  });
}

async function runPipeline() {
  const fixes = fs.readFileSync('./examples/mem10.fix', { encoding: 'utf-8' });

  const lines = readline.createInterface({
    input: fs.createReadStream('./examples/mem10.demo.jsonl', { encoding: 'utf-8' }),
    crlfDelay: Infinity
  });

  await pipeline(
    lines,
    async function* (source) {
      for await (const line of source) {
        if (line.trim()) yield JSON.parse(line);
      }
    },
    fixStream(fixes),
    async function* (source) {
      for await (const obj of source) {
        console.log('Object from pipeline:', obj);
      }
    }
  );
}

main();