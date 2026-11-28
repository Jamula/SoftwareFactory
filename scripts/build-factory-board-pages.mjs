#!/usr/bin/env node
import { resolve } from "node:path";
import {
  DEFAULT_REPO,
  buildStaticBoardPagesBundle,
  fetchFactoryBoardSnapshot,
} from "../tools/engineering-factory/factory-board.mjs";

const outputDir = resolve(process.argv[2] || "dist/pages");
const repo = process.env.FACTORY_BOARD_REPO || DEFAULT_REPO;
const fetched = await fetchFactoryBoardSnapshot({ repo });
const result = buildStaticBoardPagesBundle({
  outputDir,
  repo,
  snapshot: fetched.snapshot,
  intervalSeconds: 60,
});
process.stderr.write(`Built static SoftwareFactory Live Board at ${result.outputDir}\n`);
