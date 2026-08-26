import { packageApplication } from "./forge-api.js";

const dir = process.cwd();
await packageApplication(dir);
process.stdout.write(`${JSON.stringify({ passed: true }, null, 2)}\n`);
