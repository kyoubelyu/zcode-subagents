import { settings, readJson, sameProcess } from '../src/common.mjs';
import { request } from '../src/client.mjs';
import path from 'node:path';

const command = process.argv[2] || 'status';
const config = settings();
if (command !== 'status' && command !== 'stop') throw new Error('Usage: node scripts/control.mjs [status|stop]');
const owner = await readJson(path.join(config.home, 'supervisor.lock/owner.json'));
if (!await sameProcess(owner)) {
  console.log('Supervisor is not running.');
} else if (command === 'stop') {
  process.kill(owner.pid, 'SIGTERM');
  console.log('Supervisor stop requested. Existing workers continue; use zcode_cancel to cancel tasks.');
} else {
  console.log(JSON.stringify(await request(config, undefined, undefined, true), null, 2));
}
