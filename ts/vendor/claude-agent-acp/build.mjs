import { chmod, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const packageDir = dirname(fileURLToPath(import.meta.url));
const entryPoint = join(packageDir, "dist/index.js");
const outfile = join(packageDir, "dist/bundle.js");

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile,
  banner: { js: "#!/usr/bin/env node" },
  external: [],
  loader: { ".json": "json" },
  plugins: [
    {
      name: "strip-entry-shebang",
      setup(build) {
        build.onLoad({ filter: /dist[/\\]index\.js$/ }, async (args) => {
          if (args.path !== entryPoint) return undefined;
          const contents = await readFile(args.path, "utf8");
          return { contents: contents.replace(/^#!.*\n/, ""), loader: "js" };
        });
      },
    },
  ],
});

await chmod(outfile, 0o755);
