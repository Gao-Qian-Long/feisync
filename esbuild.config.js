const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

const plugin = {
  name: "feisync",
  version: "0.1.0",
};

async function build() {
  if (watch) {
    const context = await esbuild.context({
      entryPoints: ["main.ts"],
      bundle: true,
      external: ["obsidian"],
      format: "cjs",
      platform: "node",
      target: "node16",
      outfile: "main.js",
      sourcemap: true,
      minify: false,
      define: {
        "process.env.NODE_ENV": '"development"',
      },
    });

    await context.watch();
    console.log("Watching for changes...");
  } else {
    await esbuild.build({
      entryPoints: ["main.ts"],
      bundle: true,
      external: ["obsidian"],
      format: "cjs",
      platform: "node",
      target: "node16",
      outfile: "main.js",
      sourcemap: false,
      minify: true,
      define: {
        "process.env.NODE_ENV": '"production"',
      },
    });
    console.log("Build complete.");
  }
}

build().catch((e) => {
  console.error(e);
  process.exit(1);
});