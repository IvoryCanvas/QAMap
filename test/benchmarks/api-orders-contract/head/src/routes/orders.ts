import { Router } from "express";

export const ordersRouter = Router();

ordersRouter.get("/orders/:id", async (request, response) => {
  response.json({ id: request.params.id, status: "open" });
});

ordersRouter.patch("/orders/:id/cancel", async (request, response) => {
  response.json({ id: request.params.id, status: "cancelled" });
});
