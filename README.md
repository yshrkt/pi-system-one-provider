# pi-system-one-provider

A [Pi](https://github.com/earendil-works/pi) provider extension that registers classifier models backed by System One-compatible HTTP endpoints.

It deliberately keeps classifier configuration out of Pi's `models.json`. The extension reads a separate `~/.pi/agent/classifier-models.json` file and treats each provider's `baseUrl` as the complete endpoint URL. It never appends `/v1/systemone` or any other path.

## Requirements

- Pi 1.0 or later
- Node.js 22.19 or later when developing the package

## Install

From this checkout:

```sh
pi install ./path/to/pi-system-one-provider
```

Once published to npm:

```sh
pi install npm:pi-system-one-provider
```

## Configure

Create `~/.pi/agent/classifier-models.json`:

```json
{
  "providers": {
    "ollama-system-one": {
      "name": "Local System One",
      "baseUrl": "http://localhost:11434/v1/systemone",
      "models": [
        {
          "id": "clef-flash",
          "name": "Clef Flash"
        },
        {
          "id": "nimble",
          "name": "Nimble",
          "contextWindow": 65536
        }
      ]
    }
  }
}
```

The same configuration is available at [`examples/classifier-models.json`](examples/classifier-models.json).

`baseUrl` is the URL that receives the POST request. The example above is used exactly as written; the extension does not turn it into `http://localhost:11434/v1/systemone/v1/systemone`.

Use a dedicated provider ID such as `ollama-system-one`. Registering the same provider ID as another Pi provider replaces that provider's model list.

Provider fields:

| Field | Required | Description |
| --- | --- | --- |
| `baseUrl` | yes | Complete `http` or `https` System One endpoint URL |
| `models` | yes | Non-empty array of classifier models |
| `name` | no | Provider display name |
| `apiKey` | no | Pi config value: literal, `$ENV_VAR`, `${ENV_VAR}`, or `!command` |
| `headers` | no | Additional request headers |

Model fields:

| Field | Required | Default |
| --- | --- | --- |
| `id` | yes | — |
| `name` | no | `id` |
| `contextWindow` | no | `65536` |
| `cost` | no | all rates `0` |

For an authenticated endpoint:

```json
{
  "providers": {
    "hosted-system-one": {
      "baseUrl": "https://example.com/v1/systemone",
      "apiKey": "$SYSTEM_ONE_API_KEY",
      "models": [{ "id": "security-one" }]
    }
  }
}
```

Pi resolves the key and the extension sends it as `Authorization: Bearer ...`. When `apiKey` is omitted, no Authorization header is sent. You can also supply a custom authorization scheme through `headers`.

To use a different config location, set `PI_SYSTEM_ONE_CONFIG` to its path before starting Pi.

## Use from codemode

Enable Pi's built-in `codemode` extension, then discover and invoke the registered classifier:

```js
const model = await models.getModelOfType("classifier", "ollama-system-one", "clef-flash");
const result = await models.classify(model, {
  state: { text: "The deployment removed authentication from the admin route." },
  questions: {
    severity: {
      type: "score",
      instructions: "How severe is this change?",
      criteria: ["low", "medium", "high"]
    },
    securityRelevant: {
      type: "bool",
      instructions: "Is this security relevant?",
      criteria: { "true": "security impact", "false": "no security impact" }
    }
  }
});
text(result);
```

Pi's public `bool` question type is translated to System One's wire-level `noul` type. `choice` and `score` pass through unchanged. The request includes the selected model ID so endpoints such as Ollama can route multiple models through the same URL.

## Develop

```sh
npm install
npm run check
```

The tests verify configuration validation, exact endpoint handling, authentication, and `bool`/`noul` translation without requiring a live model server.
