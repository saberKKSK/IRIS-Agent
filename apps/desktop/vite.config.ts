import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

import { defineConfig } from "vite";

/**
 * 模型不进仓库（许可禁止再分发），所以 dev 下由 vite 直接把那个目录挂到
 * /live2d：这样浏览器里也能调版式，不必开着 MyGo 窗口。MyGo 窗口里走的是
 * Go 那边的 live2d:// 自定义协议，不经过这里。
 */
const MODEL_DIR = process.env.IRIS_LIVE2D_DIR ?? "C:/IRIS Agent/assets/live2d/大肥鱼/DeepSeek";

const MIME: Record<string, string> = {
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".moc3": "application/octet-stream",
	".jpg": "image/jpeg",
	".webp": "image/webp",
	".txt": "text/plain; charset=utf-8",
};

function live2dDevServer() {
	return {
		name: "iris-live2d-dev",
		configureServer(server: { middlewares: { use(fn: (req: { url?: string }, res: any, next: () => void) => void): void } }) {
			const base = resolve(MODEL_DIR);
			server.middlewares.use((req, res, next) => {
				const path = (req.url ?? "").split("?")[0] ?? "";
				if (!path.startsWith("/live2d/")) return next();
				let rel: string;
				try {
					rel = decodeURIComponent(path.slice("/live2d".length));
				} catch {
					res.statusCode = 400;
					res.end("bad path");
					return;
				}
				const full = resolve(base, "." + rel);
				if (full !== base && !full.startsWith(base + sep)) {
					res.statusCode = 403;
					res.end("outside");
					return;
				}
				if (!existsSync(full)) {
					res.statusCode = 404;
					res.end("not found");
					return;
				}
				res.setHeader("Content-Type", MIME[extname(full).toLowerCase()] ?? "application/octet-stream");
				res.setHeader("Cache-Control", "no-cache");
				res.end(readFileSync(full));
			});
		},
	};
}

export default defineConfig({
	plugins: [live2dDevServer()],
	server: {
		// The app loads this address during `mygo dev` (devUrl in mygo.config.ts).
		host: "127.0.0.1",
		port: 5173,
		strictPort: true,
		watch: { ignored: ["**/.mygo/**", "**/build/**"] },
	},
});
