import { Router } from "express";

export const ordersRouter = Router();

ordersRouter.get("/orders/:id", async (request, response) => {
  response.json({ id: request.params.id, status: "open" });
});
