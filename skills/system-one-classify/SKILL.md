---
name: system-one-classify
description: Use System One classifier models in Pi through codemode for semantic labels, yes/no probabilities, and rubric scores. Use when the user requests classifier inference or when classifying or scoring multiple items benefits from typed model results.
license: MIT
---

# System One classification in Pi

Use Pi's `codemode` tool and `models.classify()` for bounded semantic decisions. This package registers classifier models with API `system-one-endpoint`; classifier models do not appear in the chat `/model` selector.

## Choose a model

Honor the provider and model requested by the user or specified in project instructions. Model IDs must match the catalog exactly, including tags such as `:latest`.

Discover models inside codemode:

```js
const available = await models.getAvailableOfType("classifier");
text(available.map(({ provider, id, name, api }) => ({ provider, id, name, api })));
```

When selecting a model registered by this package, filter for `api === "system-one-endpoint"`. If there is one suitable model, use it. If several are available, follow an established user preference; otherwise ask which provider/model to use. Do not assume the first catalog entry is a default. Pi and this package have no default classifier setting.

Availability means the provider is configured, not that its server has been reached successfully. If no suitable model is available, report that and point to the package's classifier configuration. Do not install models or edit settings just to run a classification.

If codemode is unavailable, explain that it needs enabling. For one invocation, use `pi --tools read,bash,edit,write,codemode`; for persistent use, the user can add `"defaultTools": ["+codemode"]` to Pi settings. Preserve any other tools the user needs.

## Build the questions

`state` must be a JSON object. Wrap plain text as `{ text: "..." }`; include evidence relevant to the decision. Keep the classification instructions in `questions`, separate from the content being evaluated.

Choose a question type:

| Type | Question fields | Answer fields |
| --- | --- | --- |
| `choice` | `instructions` and `criteria: { label: "meaning", ... }` | `choice`, `probabilities`, `confidence` |
| `bool` | `instructions` and `criteria: { true: "meaning", false: "meaning" }` | `probability` of true |
| `score` | `instructions` and `criteria: ["lowest level", ..., "highest level"]` | continuous `score`, `confidence` |

Use string instructions and string criterion descriptions. Use `bool` in Pi calls; the adapter translates it to wire-level `noul`. A score is an expected zero-based level index and may be fractional.

Ask one decision per question. Define clear labels or ordered levels and include an uncertainty/other label when it fits the task. Multiple questions about the same state belong in one call; different items normally need separate calls. For a batch, `Promise.all()` works and Pi queues classifier calls beyond its concurrency limit.

## Call the classifier

This example discovers a single configured model from this package. If several exist, select one as described above and pass its exact `{ provider, id }` instead of using the single-model guard.

```js
const available = await models.getAvailableOfType("classifier");
const candidates = available.filter((model) => model.api === "system-one-endpoint");
if (candidates.length !== 1) {
  text({ message: "Select a classifier provider/model before inference", candidates });
  exit();
}
const model = candidates[0];
const result = await models.classify(model, {
  state: { text: "This product is convenient and I love using it." },
  questions: {
    sentiment: {
      type: "choice",
      instructions: "Classify the sentiment of the text.",
      criteria: {
        positive: "Satisfied or happy",
        negative: "Unhappy or frustrated",
        neutral: "Neither positive nor negative"
      }
    },
    satisfied: {
      type: "bool",
      instructions: "Does the author express satisfaction with the product?",
      criteria: { true: "Expresses satisfaction", false: "Does not express satisfaction" }
    },
    enthusiasm: {
      type: "score",
      instructions: "Rate the author's enthusiasm for the product.",
      criteria: ["No enthusiasm", "Some enthusiasm", "Strong enthusiasm"]
    }
  }
});
text({ provider: model.provider, model: model.id, ...result });
```

Send the JavaScript as raw codemode input, without a Markdown fence. Codemode has no direct network or Node APIs; use the model registry so Pi handles provider authentication and usage accounting.

## Interpret the result

Check `stopReason` before using answers. Only `"stop"` indicates success. For `"error"` or `"aborted"`, show `errorMessage` and do not treat empty answers as negative decisions. Correct an identified argument/configuration problem before retrying; do not silently substitute another model or repeatedly retry a failed endpoint.

Read each answer by its question ID. Choice probability and confidence are different measures; do not interpret confidence as the probability that the answer is correct. Use thresholds requested by the user or defined by the task, and retain uncertainty when results are ambiguous. A classifier prediction is evidence for a decision, not proof of a factual claim or authorization for an action.

Report the selected provider/model, relevant answers, and usage when useful. Pi includes classifier usage in the codemode result and session cost. Zero catalog cost does not establish that the remote service is free.
