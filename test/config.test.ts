import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_WINDOW, parseConfig } from "../src/config.js";

describe("parseConfig", () => {
	it("applies model defaults", () => {
		const config = parseConfig({
			providers: {
				local: {
					baseUrl: "http://localhost:11434/v1/systemone",
					models: [{ id: "clef-flash" }],
				},
			},
		});

		expect(config.providers.local?.models[0]).toEqual({
			id: "clef-flash",
			name: "clef-flash",
			contextWindow: DEFAULT_CONTEXT_WINDOW,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it("rejects relative endpoint URLs", () => {
		expect(() =>
			parseConfig({ providers: { local: { baseUrl: "/v1/systemone", models: [{ id: "clef" }] } } }),
		).toThrow("expected an absolute URL");
	});

	it("rejects duplicate model ids within a provider", () => {
		expect(() =>
			parseConfig({
				providers: {
					local: {
						baseUrl: "http://localhost/v1/systemone",
						models: [{ id: "clef" }, { id: "clef" }],
					},
				},
			}),
		).toThrow("duplicate model id");
	});
});
