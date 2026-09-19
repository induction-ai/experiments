/**
 * Writes index.html at the repo root: the site's home page, listing every
 * experiment with its dates. Jekyll only falls back to README.md for the home
 * page when there is no index.html, so this replaces it on the site while the
 * README stays the repo's front page on GitHub. Runs in the Pages workflow
 * (.github/workflows/pages.yml) before the Jekyll build, so it is never
 * committed and can't go stale. Run it locally with `pnpm pages:index`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readExperiments, renderIndex } from "../src/index.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);
const experiments = readExperiments(path.join(root, "experiments"));
fs.writeFileSync(path.join(root, "index.html"), renderIndex(experiments));
console.log(
  `wrote index.html (${experiments.length} experiment${experiments.length === 1 ? "" : "s"})`
);
