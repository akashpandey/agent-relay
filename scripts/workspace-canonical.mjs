#!/usr/bin/env node
import { canonicalWorkspacePath } from '../dashboard/workspaces.js';

const workspace = process.argv[2] || '';
const canonical = canonicalWorkspacePath(workspace);
if (canonical) console.log(canonical);
