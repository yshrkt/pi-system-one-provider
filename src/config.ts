import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const CONFIG_PATH_ENV = "PI_SYSTEM_ONE_CONFIG";
export const DEFAULT_CONTEXT_WINDOW = 65_536;

export interface SystemOneModelConfig {
	id: string;
	name: string;
	contextWindow: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
}

export interface SystemOneProviderConfig {
	name?: string;
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	models: SystemOneModelConfig[];
}

export interface SystemOneConfig {
	providers: Record<string, SystemOneProviderConfig>;
}

function fail(path: string, message: string): never {
	throw new Error(`${path}: ${message}`);
}

function object(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		fail(path, "expected an object");
	}
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		fail(path, "expected a non-empty string");
	}
	return value;
}

function optionalString(value: unknown, path: string): string | undefined {
	return value === undefined ? undefined : nonEmptyString(value, path);
}

function nonNegativeNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		fail(path, "expected a non-negative finite number");
	}
	return value;
}

function positiveInteger(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		fail(path, "expected a positive integer");
	}
	return value as number;
}

function parseHeaders(value: unknown, path: string): Record<string, string> | undefined {
	if (value === undefined) return undefined;
	const source = object(value, path);
	return Object.fromEntries(
		Object.entries(source).map(([key, header]) => [key, nonEmptyString(header, `${path}.${key}`)]),
	);
}

function parseCost(value: unknown, path: string): SystemOneModelConfig["cost"] {
	if (value === undefined) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const source = object(value, path);
	return {
		input: source.input === undefined ? 0 : nonNegativeNumber(source.input, `${path}.input`),
		output: source.output === undefined ? 0 : nonNegativeNumber(source.output, `${path}.output`),
		cacheRead: source.cacheRead === undefined ? 0 : nonNegativeNumber(source.cacheRead, `${path}.cacheRead`),
		cacheWrite:
			source.cacheWrite === undefined ? 0 : nonNegativeNumber(source.cacheWrite, `${path}.cacheWrite`),
	};
}

function parseModel(value: unknown, path: string): SystemOneModelConfig {
	const source = object(value, path);
	const id = nonEmptyString(source.id, `${path}.id`);
	return {
		id,
		name: source.name === undefined ? id : nonEmptyString(source.name, `${path}.name`),
		contextWindow:
			source.contextWindow === undefined
				? DEFAULT_CONTEXT_WINDOW
				: positiveInteger(source.contextWindow, `${path}.contextWindow`),
		cost: parseCost(source.cost, `${path}.cost`),
	};
}

function parseProvider(value: unknown, path: string): SystemOneProviderConfig {
	const source = object(value, path);
	const baseUrl = nonEmptyString(source.baseUrl, `${path}.baseUrl`);
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		fail(`${path}.baseUrl`, "expected an absolute URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		fail(`${path}.baseUrl`, "expected an http or https URL");
	}
	if (!Array.isArray(source.models) || source.models.length === 0) {
		fail(`${path}.models`, "expected a non-empty array");
	}

	const models = source.models.map((model, index) => parseModel(model, `${path}.models[${index}]`));
	const ids = new Set<string>();
	for (const model of models) {
		if (ids.has(model.id)) fail(`${path}.models`, `duplicate model id ${JSON.stringify(model.id)}`);
		ids.add(model.id);
	}

	const name = optionalString(source.name, `${path}.name`);
	const apiKey = optionalString(source.apiKey, `${path}.apiKey`);
	const headers = parseHeaders(source.headers, `${path}.headers`);
	return {
		baseUrl,
		models,
		...(name === undefined ? {} : { name }),
		...(apiKey === undefined ? {} : { apiKey }),
		...(headers === undefined ? {} : { headers }),
	};
}

export function parseConfig(value: unknown): SystemOneConfig {
	const root = object(value, "config");
	const providersObject = object(root.providers, "config.providers");
	const entries = Object.entries(providersObject);
	if (entries.length === 0) fail("config.providers", "expected at least one provider");

	return {
		providers: Object.fromEntries(
			entries.map(([providerId, provider]) => {
				if (providerId.trim() === "") fail("config.providers", "provider ids must not be empty");
				return [providerId, parseProvider(provider, `config.providers.${providerId}`)];
			}),
		),
	};
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return resolve(env[CONFIG_PATH_ENV] ?? `${homedir()}/.pi/agent/classifier-models.json`);
}

export async function loadConfig(path = configPath()): Promise<SystemOneConfig> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		throw new Error(`Could not read System One provider config at ${path}`, { cause: error });
	}

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(`Invalid JSON in System One provider config at ${path}`, { cause: error });
	}

	try {
		return parseConfig(value);
	} catch (error) {
		throw new Error(`Invalid System One provider config at ${path}`, { cause: error });
	}
}
