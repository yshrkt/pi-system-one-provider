import type { ClassifierOptions, ProviderHeaders } from "@earendil-works/pi-ai";
import {
	classifySystemOne,
	isRecord,
	type SystemOneTransport,
} from "@earendil-works/pi-ai/api/system-one-shared";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, type SystemOneConfig, type SystemOneProviderConfig } from "../src/config.js";

export const SYSTEM_ONE_API = "system-one-endpoint";
const NO_AUTH_CREDENTIAL = "pi-system-one-no-auth";

const transport: SystemOneTransport = {
	api: SYSTEM_ONE_API,
	label: "System One API",
	url: (model) => new URL(model.baseUrl),
	payload: (model, request) => ({ model: model.id, ...request }),
	output: (body) => {
		if (!isRecord(body)) throw new Error("System One API returned an unexpected response");
		return body;
	},
};

function hasAuthorizationHeader(headers: Record<string, unknown> | undefined): boolean {
	return Object.keys(headers ?? {}).some((name) => name.toLowerCase() === "authorization");
}

function classifierOptions(
	provider: SystemOneProviderConfig,
	options: ClassifierOptions | undefined,
): ClassifierOptions {
	if (provider.apiKey !== undefined || hasAuthorizationHeader(provider.headers) || hasAuthorizationHeader(options?.headers)) {
		return options ?? {};
	}

	const headers: ProviderHeaders = { ...options?.headers, authorization: null };
	return { ...options, headers };
}

export function registerProviders(pi: ExtensionAPI, config: SystemOneConfig): void {
	for (const [providerId, provider] of Object.entries(config.providers)) {
		pi.registerProvider(providerId, {
			...(provider.name === undefined ? {} : { name: provider.name }),
			baseUrl: provider.baseUrl,
			apiKey: provider.apiKey ?? NO_AUTH_CREDENTIAL,
			...(provider.headers === undefined ? {} : { headers: provider.headers }),
			models: provider.models.map((model) => ({
				type: "classifier" as const,
				id: model.id,
				name: model.name,
				api: SYSTEM_ONE_API,
				baseUrl: provider.baseUrl,
				input: ["text" as const],
				cost: model.cost,
				contextWindow: model.contextWindow,
			})),
			classifiers: {
				[SYSTEM_ONE_API]: {
					classify: (model, context, options) =>
						classifySystemOne(transport, model, context, classifierOptions(provider, options)),
				},
			},
		});
	}
}

export default async function systemOneProvider(pi: ExtensionAPI): Promise<void> {
	registerProviders(pi, await loadConfig());
}
