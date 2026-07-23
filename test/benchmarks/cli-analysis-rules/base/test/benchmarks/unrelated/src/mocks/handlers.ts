export const handlers = [
  http.get("/api/orders", () => HttpResponse.json({ orders: [] })),
];
