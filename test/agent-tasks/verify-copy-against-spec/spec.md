# Shipping status copy

Every surface that shows the shipping status of an order that has not shipped
yet must render the same sentence.

| Surface | Page source | Data shown | Expected copy |
| --- | --- | --- | --- |
| Order summary | `src/pages/summary.tsx` | shipping status before shipment | Ships after payment clears |
| Order confirmation | `src/pages/confirmation.tsx` | shipping status before shipment | Ships after payment clears |
