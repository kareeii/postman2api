import { Hono } from "hono";
import { POSTMAN_MODELS } from "../provider/models";

export const modelsRouter = new Hono();

modelsRouter.get("/v1/models", (c) => {
  return c.json({
    object: "list",
    data: POSTMAN_MODELS.map((m) => ({
      id: m.id,
      object: "model",
      created: m.created,
      owned_by: m.owned_by,
      context_window: m.context_window,
      max_output: m.max_output,
      thinking: m.thinking,
    })),
  });
});
