import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  devIndicators: false,
  turbopack: { root: repositoryRoot },
  outputFileTracingRoot: repositoryRoot,
};

export default config;
