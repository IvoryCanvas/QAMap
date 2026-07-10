import { http, HttpResponse } from "msw";

export const orderHandlers = [
  http.get("/api/orders", () => HttpResponse.json([{ id: "order-1", status: "open" }])),
];
