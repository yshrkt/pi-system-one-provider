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

	it("retries transient HTTP errors and preserves hooks, headers, and usage costs", async () => {
		const { implementation, model } = classifier(setup("secret"));
		model.cost = { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 };
		model.headers = { "X-Source": "model", Authorization: "Bearer model" };
		const onResponse = vi.fn();
		const request = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("busy", { status: 503, headers: { "retry-after-ms": "0" } }))
			.mockResolvedValueOnce(new Response(JSON.stringify({
				answers: { safe: { type: "noul", noul: 0.8 } },
				usage: { input_tokens: 100, output_tokens: 10 },
			}), { headers: { "x-request-id": "test" } }));
		const result = await implementation.classify(model, context, {
			apiKey: "secret",
			fetch: request,
			maxRetries: 1,
			headers: { "x-source": "caller", authorization: null },
			onPayload: (payload) => ({ ...payload as object, extra: true }),
			onResponse,
		});
		expect(result.stopReason).toBe("stop");
		expect(request).toHaveBeenCalledTimes(2);
		const init = request.mock.calls[1]?.[1];
		expect(new Headers(init?.headers).get("x-source")).toBe("caller");
		expect(new Headers(init?.headers).has("authorization")).toBe(false);
		expect(JSON.parse(String(init?.body)).extra).toBe(true);
		expect(onResponse).toHaveBeenCalledWith({ status: 200, headers: { "content-type": "text/plain;charset=UTF-8", "x-request-id": "test" } }, model);
		expect(result.usage?.totalTokens).toBe(110);
		expect(result.usage?.cost.total).toBeCloseTo(0.00024);
	});

	it("passes choice and score questions through and parses their answers", async () => {
		const { implementation, model } = classifier(setup());
		const questions: ClassifierContext["questions"] = {
			label: { type: "choice", instructions: "Choose", criteria: { a: "A", b: "B" } },
			severity: { type: "score", instructions: "Rate", criteria: ["low", "high"] },
		};
		const answers = {
			label: { type: "choice", choice: "a", probabilities: { a: 0.8, b: 0.2 }, confidence: 0.9 },
			severity: { type: "score", score: 0.7, confidence: 0.6 },
		};
		const request = vi.fn<typeof fetch>(async (_url, init) => {
			expect(JSON.parse(String(init?.body)).questions).toEqual(questions);
			return new Response(JSON.stringify({ answers }));
		});
		const result = await implementation.classify(model, { state: {}, questions }, {
			apiKey: "pi-system-one-no-auth", fetch: request, maxRetries: 0,
		});
		expect(result.stopReason).toBe("stop");
		expect(result.answers).toEqual(answers);
	});

	it("reports HTTP error bodies without retrying authentication errors", async () => {
		const { implementation, model } = classifier(setup());
		const request = vi.fn<typeof fetch>(async () => new Response("invalid credential", { status: 401 }));
		const result = await implementation.classify(model, context, {
			apiKey: "pi-system-one-no-auth", fetch: request,
		});
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("System One API error (401): invalid credential");
		expect(request).toHaveBeenCalledOnce();
	});

	it("returns aborted without sending a request when already cancelled", async () => {
		const { implementation, model } = classifier(setup());
		const request = vi.fn<typeof fetch>();
		const result = await implementation.classify(model, context, {
			apiKey: "pi-system-one-no-auth", fetch: request,
			signal: AbortSignal.abort(new Error("cancelled")),
		});
		expect(result.stopReason).toBe("aborted");
		expect(request).not.toHaveBeenCalled();
	});

	it("cancels an in-flight request", async () => {
		const { implementation, model } = classifier(setup());
		const controller = new AbortController();
		const request = vi.fn<typeof fetch>(async (_url, init) => {
			controller.abort(new Error("cancelled"));
			init?.signal?.throwIfAborted();
			throw new Error("expected request cancellation");
		});
		const result = await implementation.classify(model, context, {
			apiKey: "pi-system-one-no-auth", fetch: request, signal: controller.signal,
		});
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("cancelled");
		expect(request).toHaveBeenCalledOnce();
	});

	it("interrupts the server's retry delay on cancellation", async () => {
		const { implementation, model } = classifier(setup());
		const controller = new AbortController();
		const request = vi.fn<typeof fetch>(async () => {
			return new Response("busy", { status: 503, headers: { "retry-after": "60" } });
		});
		const timer = setTimeout(() => controller.abort(), 10);
		try {
			const result = await implementation.classify(model, context, {
				apiKey: "pi-system-one-no-auth", fetch: request, signal: controller.signal,
			});
			expect(result.stopReason).toBe("aborted");
			expect(request).toHaveBeenCalledOnce();
		} finally {
			clearTimeout(timer);
		}
	}, 1000);

	it("retries timeouts with a fresh signal", async () => {
		const { implementation, model } = classifier(setup());
		const expired = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(expired.signal);
		try {
			const request = vi.fn<typeof fetch>()
				.mockImplementationOnce(async (_url, init) => {
					expired.abort();
					init?.signal?.throwIfAborted();
					throw new Error("expected timeout");
				})
				.mockImplementationOnce(async (_url, init) => {
					expect(init?.signal?.aborted).toBe(false);
					return new Response(JSON.stringify({ answers: { safe: { type: "noul", noul: 0.9 } } }));
				});
			const pending = implementation.classify(model, context, {
				apiKey: "pi-system-one-no-auth", fetch: request, timeoutMs: 5000, maxRetries: 1,
			});
			const result = await pending;
			expect(result.stopReason).toBe("stop");
			expect(request).toHaveBeenCalledTimes(2);
			expect(timeout).toHaveBeenCalledTimes(2);
		} finally {
			timeout.mockRestore();
		}
	});

	it("reports timeout exhaustion as an error", async () => {
		const { implementation, model } = classifier(setup());
		const expired = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(expired.signal);
		try {
			const request = vi.fn<typeof fetch>(async (_url, init) => {
				expired.abort();
				init?.signal?.throwIfAborted();
				throw new Error("expected timeout");
			});
			const result = await implementation.classify(model, context, {
				apiKey: "pi-system-one-no-auth", fetch: request, timeoutMs: 5, maxRetries: 0,
			});
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBe("Request timed out after 5ms");
			expect(timeout).toHaveBeenCalledWith(5);
			expect(request).toHaveBeenCalledOnce();
		} finally {
			timeout.mockRestore();
		}
	});

	it("rejects excessive server retry delays without waiting", async () => {
		const { implementation, model } = classifier(setup());
		const request = vi.fn<typeof fetch>(async () =>
			new Response("busy", { status: 503, headers: { "retry-after": "120" } }),
		);
		const result = await implementation.classify(model, context, {
			apiKey: "pi-system-one-no-auth", fetch: request, maxRetryDelayMs: 1000,
		});
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Server requested 120s retry delay (max: 1s)");
		expect(request).toHaveBeenCalledOnce();
	});

	it.each([
		{},
		{ safe: { type: "score", score: 0.8 } },
		{ safe: { type: "noul", noul: "0.8" } },
	])("reports malformed answers and retains billed usage: %j", async (answers) => {
		const { implementation, model } = classifier(setup());
		const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
			answers, usage: { input_tokens: 12, output_tokens: 1 },
		})));
		const result = await implementation.classify(model, context, {
			apiKey: "pi-system-one-no-auth", fetch: request,
		});
		expect(result.stopReason).toBe("error");
		expect(result.answers).toEqual({});
		expect(result.usage?.totalTokens).toBe(13);
		expect(request).toHaveBeenCalledOnce();
	});
});
