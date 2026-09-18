// skills/agent-relay is canonical; the plugin directory is a generated copy.
import fs from 'node:fs';

const source = new URL('../skills/agent-relay/', import.meta.url);
const destination = new URL('../plugins/agent-relay/skills/agent-relay/', import.meta.url);
fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true });
console.log('Plugin skill synchronized from skills/agent-relay');
