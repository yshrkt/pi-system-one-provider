import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("loads a Git-style install without node_modules through Pi's extension loader", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-system-one-install-"));
	try {
		for (const path of ["extensions", "src", "examples", "package.json"]) {
			await cp(new URL(`../${path}`, import.meta.url), join(directory, path), { recursive: true });
		}
		const loader = new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
		const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
			import { loadExtensions, createExtensionRuntime } from ${JSON.stringify(loader.href)};
			const runtime = createExtensionRuntime();
			const result = await loadExtensions([${JSON.stringify(join(directory, "extensions/system-one-provider.ts"))}], ${JSON.stringify(directory)}, undefined, runtime);
			console.log(JSON.stringify({ errors: result.errors, count: result.extensions.length, providers: runtime.pendingProviderRegistrations.map(p => p.name) }));
		`], {
			cwd: directory,
			env: { ...process.env, PI_SYSTEM_ONE_CONFIG: join(directory, "examples/classifier-models.json") },
		});
		expect(JSON.parse(stdout)).toEqual({ errors: [], count: 1, providers: ["ollama-system-one"] });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 30_000);
