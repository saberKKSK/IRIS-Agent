import { defineConfig } from "mygo-cli";

export default defineConfig({
	// The window's title and the app's identity for installers.
	name: "伊里斯",
	identifier: "dev.iris.agent",
	version: "0.1.0",
	// `mygo dev` runs devCommand and loads devUrl; `mygo build` runs
	// buildCommand and embeds frontendDist into the app.
	devUrl: "http://localhost:5173",
	devCommand: "bun run dev:web",
	buildCommand: "bun run build:web",
	frontendDist: "dist",
	bindings: "src/mygo.ts",
	out: "build",
});
