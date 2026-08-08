#!/usr/bin/env node
import { createCliProgram } from "./index.js";

createCliProgram()
  .parseAsync(process.argv)
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
