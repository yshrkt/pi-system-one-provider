import { setTimeout as delay } from "node:timers/promises";
import type {
	ClassifierAnswer, ClassifierApi, ClassifierContext, ClassifierModel,
	ClassifierOptions, ClassifierResult, ProviderHeaders, Usage,
} from "@earendil-works/pi-ai";

export const SYSTEM_ONE_API = "system-one-endpoint";
type Model = ClassifierModel<ClassifierApi>;

class HttpError extends Error {
	constructor(readonly response: Response, body: string) {
		const detail = body.trim();
		const truncated = detail.length > 4000 ? `${detail.slice(0, 4000)}... [truncated ${detail.length - 4000} chars]` : detail;
		super(`System One API error (${response.status}): ${truncated || `System One API returned ${response.status}`}`);
	}
}

class RequestTimeout extends Error {
	constructor(milliseconds: number) {
		super(`Request timed out after ${milliseconds}ms`);
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function number(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`System One API returned an invalid ${field}`);
	}
	return value;
}

function readAnswers(value: unknown, questions: ClassifierContext["questions"]): Record<string, ClassifierAnswer> {
	if (!record(value)) throw new Error("System One API returned an unexpected response");
	return Object.fromEntries(Object.entries(questions).map(([id, question]): [string, ClassifierAnswer] => {
		const answer = value[id];
		if (!record(answer)) throw new Error(`System One API did not return an answer for ${id}`);
		switch (question.type) {
			case "bool":
				if (answer.type === "noul") {
					return [id, { type: "bool", probability: number(answer.noul, `probability for ${id}`) }];
				}
				break;
			case "score":
				if (answer.type === "score") {
					return [id, {
						type: "score", score: number(answer.score, `score for ${id}`),
						confidence: number(answer.confidence, `confidence for ${id}`),
					}];
				}
				break;
			case "choice":
				if (answer.type === "choice" && typeof answer.choice === "string") {
					if (!record(answer.probabilities)) throw new Error(`System One API returned invalid probabilities for ${id}`);
					return [id, {
						type: "choice", choice: answer.choice,
						confidence: number(answer.confidence, `confidence for ${id}`),
						probabilities: Object.fromEntries(Object.entries(answer.probabilities).map(([key, value]) =>
							[key, number(value, `probability for ${id}.${key}`)],
						)),
					}];
				}
		}
		throw new Error(`System One API did not return a ${question.type} answer for ${id}`);
	}));
}

function readUsage(value: unknown, model: Model): Usage | undefined {
	if (!record(value) || (value.input_tokens === undefined && value.output_tokens === undefined)) return undefined;
	const tokens = (count: unknown) => typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0;
	const input = tokens(value.input_tokens);
	const output = tokens(value.output_tokens);
	const inputCost = input * model.cost.input / 1_000_000;
	const outputCost = output * model.cost.output / 1_000_000;
	return {
		input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output,
		cost: { input: inputCost, output: outputCost, cacheRead: 0, cacheWrite: 0, total: inputCost + outputCost },
	};
}

function headers(model: Model, options: ClassifierOptions): Headers {
	const result = new Headers({ "content-type": "application/json", authorization: `Bearer ${options.apiKey}` });
	for (const source of [model.headers, options.headers] as (ProviderHeaders | undefined)[]) {
		for (const [key, value] of Object.entries(source ?? {})) {
			if (value === null) result.delete(key);
			else result.set(key, value);
		}
	}
	return result;
}

function retryable(error: unknown): boolean {
	if (error instanceof RequestTimeout || error instanceof TypeError) return true;
	if (!(error instanceof HttpError)) return false;
	const override = error.response.headers.get("x-should-retry");
	if (override === "true" || override === "false") return override === "true";
	const status = error.response.status;
	return [408, 409, 429].includes(status) || status >= 500;
}

function retryDelay(error: unknown, attempt: number, limit: number): number {
	if (error instanceof HttpError) {
		const responseHeaders = error.response.headers;
		const milliseconds = responseHeaders.get("retry-after-ms");
		const secondsOrDate = responseHeaders.get("retry-after");
		let requested = milliseconds === null ? NaN : Number.parseFloat(milliseconds);
		if (!Number.isFinite(requested) && secondsOrDate !== null) {
			const seconds = Number.parseFloat(secondsOrDate);
			requested = Number.isNaN(seconds) ? Date.parse(secondsOrDate) - Date.now() : seconds * 1000;
		}
		if (Number.isFinite(requested)) {
			if (limit > 0 && requested > limit) {
				throw new Error(`Server requested ${Math.ceil(requested / 1000)}s retry delay (max: ${Math.ceil(limit / 1000)}s). ${error.message}`);
			}
			return Math.max(0, requested);
		}
	}
	return Math.min(500 * 2 ** attempt, 8000) * (1 - Math.random() * 0.25);
}

async function post(model: Model, body: string, options: ClassifierOptions): Promise<{ response: Response; data: unknown }> {
	const requestHeaders = headers(model, options);
	const url = new URL(model.baseUrl);
	for (let attempt = 0; ; attempt++) {
		options.signal?.throwIfAborted();
		const timeout = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs);
		const signals = [options.signal, timeout].filter((signal): signal is AbortSignal => signal !== undefined);
		try {
			const response = await (options.fetch ?? globalThis.fetch)(url, {
				method: "POST", headers: requestHeaders, body,
				signal: signals.length ? AbortSignal.any(signals) : null,
			});
			if (!response.ok) throw new HttpError(response, await response.text());
			return { response, data: await response.json() };
		} catch (caught) {
			options.signal?.throwIfAborted();
			const error = timeout?.aborted ? new RequestTimeout(options.timeoutMs!) : caught;
			if (attempt >= (options.maxRetries ?? 2) || !retryable(error)) throw error;
			await delay(retryDelay(error, attempt, options.maxRetryDelayMs ?? 60_000), undefined, { signal: options.signal });
		}
	}
}

/** Classify through the configured endpoint. Pi dependencies are used only for types. */
export async function classifySystemOne(model: Model, context: ClassifierContext, options: ClassifierOptions = {}): Promise<ClassifierResult> {
	const result: ClassifierResult = {
		api: model.api, provider: model.provider, model: model.id,
		answers: {}, stopReason: "stop", timestamp: Date.now(),
	};
	try {
		options.signal?.throwIfAborted();
		if (model.api !== SYSTEM_ONE_API) throw new Error(`Unsupported classifier API: ${model.api}`);
		if (!options.apiKey) throw new Error(`No API key for provider: ${model.provider}`);
		const payload = {
			model: model.id, state: context.state,
			questions: Object.fromEntries(Object.entries(context.questions).map(([id, question]) =>
				[id, question.type === "bool" ? { ...question, type: "noul" } : question],
			)),
		};
		const replacement = await options.onPayload?.(payload, model);
		const { response, data } = await post(model, JSON.stringify(replacement === undefined ? payload : replacement), options);
		await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
		if (!record(data)) throw new Error("System One API returned an unexpected response");
		// The server may bill a response even if its answers are malformed.
		const usage = readUsage(data.usage, model);
		if (usage !== undefined) result.usage = usage;
		result.answers = readAnswers(data.answers, context.questions);
	} catch (error) {
		result.stopReason = options.signal?.aborted ? "aborted" : "error";
		result.errorMessage = error instanceof Error ? error.message : String(error);
	}
	return result;
}
