import { api } from "@electron-forge/core";

const dir = process.cwd();
await api.package({ dir, interactive: false });
const outputs = await api.make({ dir, interactive: false, skipPackage: true });
process.stdout.write(`${JSON.stringify({ passed: true, outputs }, null, 2)}\n`);
