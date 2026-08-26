import { makeApplication, packageApplication } from "./forge-api.js";

const dir = process.cwd();
await packageApplication(dir);
const outputs = await makeApplication(dir);
process.stdout.write(`${JSON.stringify({ passed: true, outputs }, null, 2)}\n`);
