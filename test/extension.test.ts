import type { ClassifierApi, ClassifierContext, ClassifierModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerProviders, SYSTEM_ONE_API } from "../extensions/system-one-provider.js";
import { parseConfig } from "../src/config.js";

function setup(apiKey?: string): ProviderConfig {
	let registered: ProviderConfig | undefined;
	const pi = {
		registerProvider(name: string, config: ProviderConfig) {
			expect(name).toBe("ollama-system-one");
			registered = config;
		},
	} as ExtensionAPI;

	registerProviders(
		pi,
		parseConfig({
			providers: {
				"ollama-system-one": {
					baseUrl: "http://localhost:11434/v1/systemone?source=pi",
					...(apiKey === undefined ? {} : { apiKey }),
					models: [{ id: "clef-flash", name: "Clef Flash" }],
				},
			},
		}),
	);

	if (registered === undefined) throw new Error("provider was not registered");
	return registered;
}

function classifier(config: ProviderConfig) {
	const implementation = config.classifiers?.[SYSTEM_ONE_API];
	if (implementation === undefined) throw new Error("classifier was not registered");
	const model = config.models?.[0];
	if (model === undefined || model.type !== "classifier") throw new Error("classifier model was not registered");
	if (model.baseUrl === undefined) throw new Error("classifier model has no baseUrl");
	const registeredModel: ClassifierModel<ClassifierApi> = {
		type: "classifier",
		id: model.id,
		name: model.name,
		provider: "ollama-system-one",
		api: SYSTEM_ONE_API,
		baseUrl: model.baseUrl,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
	};
	return { implementation, model: registeredModel };
}

const context: ClassifierContext = {
	state: { text: "ship it" },
	questions: {
		safe: {
			type: "bool",
			instructions: "Is this safe?",
			criteria: { true: "safe", false: "unsafe" },
		},
	},
};

describe("System One provider", () => {
	it("posts directly to baseUrl and maps bool to noul", async () => {
		const { implementation, model } = classifier(setup());
		const request = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
			new Response(
				JSON.stringify({
					model: "clef-flash",
					answers: { safe: { type: "noul", noul: 0.9 } },
					usage: { input_tokens: 12, output_tokens: 1 },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			),
		);

		const result = await implementation.classify(model, context, {
			apiKey: "pi-system-one-no-auth",
			fetch: request as typeof fetch,
			maxRetries: 0,
		});

		expect(result.stopReason).toBe("stop");
		expect(result.answers.safe).toEqual({ type: "bool", probability: 0.9 });
		expect(request).toHaveBeenCalledOnce();
		const [url, init] = request.mock.calls[0] ?? [];
		expect(String(url)).toBe("http://localhost:11434/v1/systemone?source=pi");
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "clef-flash",
			state: { text: "ship it" },
			questions: {
				safe: {
					type: "noul",
					instructions: "Is this safe?",
					criteria: { true: "safe", false: "unsafe" },
				},
			},
		});
		expect(new Headers(init?.headers).has("authorization")).toBe(false);
	});

	it("uses Pi-resolved API keys as bearer credentials", async () => {
		const { implementation, model } = classifier(setup("$SYSTEM_ONE_API_KEY"));
		const request = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
			return new Response(JSON.stringify({ answers: { safe: { type: "noul", noul: 0.1 } } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		const result = await implementation.classify(model, context, {
			apiKey: "secret",
			fetch: request as typeof fetch,
			maxRetries: 0,
		});

		expect(result.stopReason).toBe("stop");
	});
});
