import { promises as fs } from 'node:fs';
import { call } from './client.mjs';
import { validate } from './schemas.mjs';

const [command = 'help', flag, file] = process.argv.slice(2);
const commands = ['doctor', 'models', 'spawn', 'status', 'list', 'wait', 'followup', 'cancel'];
try {
  if (command === 'help' || command === '--help') {
    console.log('Usage: node <plugin-root>/dist/control.mjs <' + commands.join('|') + '> [--json-file request.json | --stdin]\nJSON results on stdout. This is the plugin client, not the ZCode CLI.');
  } else {
    if (!commands.includes(command)) throw new Error('Unknown command: ' + command);
    let input = {};
    if (flag === '--json-file' && file) input = JSON.parse(await fs.readFile(file, 'utf8'));
    else if (flag === '--stdin' && !file) {
      let body = ''; for await (const chunk of process.stdin) { body += chunk; if (body.length > 1024 * 1024) throw new Error('Input too large'); }
      input = JSON.parse(body);
    } else if (flag) throw new Error('Use --json-file <path> or --stdin');
    const method = 'zcode_' + command;
    console.log(JSON.stringify(await call(method, validate(method, input)), null, 2));
  }
} catch (error) { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; }
