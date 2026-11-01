import { writeFileSync } from "node:fs";
import { renderOpenApiJson } from "./document.js";

/** `pnpm openapi`: writes openapi/openapi.json (committed; CI fails if it's stale). */
const target = new URL("../../openapi/openapi.json", import.meta.url);
writeFileSync(target, renderOpenApiJson());
process.stdout.write(`wrote ${target.pathname}\n`);
