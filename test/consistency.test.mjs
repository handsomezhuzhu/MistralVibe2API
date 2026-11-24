/**
 * Catalog consistency: the static model list and the price table must agree,
 * and the Vibe CLI's wire names must be offered. A new model added to one
 * place but not the other fails here instead of silently mispricing usage.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MODELS, MODEL_PRICES } from "../src/core.mjs";

test("the Vibe CLI's wire names are in the catalog", () => {
  // The harness LocalModelRoute default and its utility routes: these are the
  // names the official client sends, so the proxy must offer them.
  for (const id of [
    "mistral-vibe-cli-latest",
    "mistral-vibe-cli-with-tools",
    "mistral-vibe-cli-fast",
  ]) {
    assert.ok(MODELS[id], `${id} is offered`);
  }
});

test("every catalog model has a price entry (possibly null)", () => {
  const missing = Object.keys(MODELS).filter((id) => !(id in MODEL_PRICES));
  assert.deepEqual(missing, [], `missing price entries: ${missing.join(", ")}`);
});

test("every non-null price is positive and complete", () => {
  for (const [id, price] of Object.entries(MODEL_PRICES)) {
    if (price == null) continue;
    assert.ok(price.input > 0, `${id} input price > 0`);
    assert.ok(price.output > 0, `${id} output price > 0`);
    if (price.cachedInput != null) {
      assert.ok(price.cachedInput >= 0, `${id} cached price >= 0`);
      assert.ok(
        price.cachedInput <= price.input,
        `${id} cached price is not above the input price`
      );
    }
  }
});

test("priced models are all in the catalog", () => {
  const orphans = Object.keys(MODEL_PRICES).filter((id) => !(id in MODELS));
  assert.deepEqual(orphans, [], `prices without a model: ${orphans.join(", ")}`);
});

test("every catalog model has limits and a tool flag", () => {
  for (const [id, model] of Object.entries(MODELS)) {
    assert.ok(model.name, `${id} has a name`);
    assert.ok(
      Number.isInteger(model.limit?.context) && model.limit.context > 0,
      `${id} has a positive context limit`
    );
    assert.ok(
      Number.isInteger(model.limit?.output) && model.limit.output > 0,
      `${id} has a positive output limit`
    );
    assert.equal(typeof model.tool_call, "boolean", `${id} declares tool_call`);
  }
});
