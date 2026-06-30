# Keyed MOTO (manual / telephone order) — drop-in, ready to enable

This is the in-app **keyed card entry** path: an operator types the card, Viva
tokenizes it **directly** (raw PAN/CVC go browser→Viva, never to our backend), and
the backend charges the resulting one-time `chargeToken` against the **MOTO source**
— which is **out of scope for 3D Secure / OTP**.

It is **built and wired, but gated on two Viva account enablements** that a
read-only probe showed are not present yet. Until both are granted, a keyed charge
cannot tokenize and the request simply fails (no money moves).

## The two enablements to request from Viva (one support message)
1. **MOTO** enabled on the account (so the charge is out-of-scope for 3DS). MOTO is
   granted on request to specific merchant categories — and shifts fraud-chargeback
   liability to the merchant (no 3DS liability shift).
2. An **online checkout / card-tokenization OAuth scope** on your API credentials
   (e.g. `urn:viva:payments:core:api:redirectcheckout`). Your app's current scopes
   are `…posmanagement` / `…ecr` only, so `VivaPayments.cards.requestToken` will
   fail until this is added.

> Message: *"Please enable MOTO on my account and add the online checkout /
> card-tokenization (Native Checkout v2 / redirectcheckout) scope to my API
> credentials. Can I also use the Virtual Terminal for MOTO meanwhile?"*

**Immediate alternative (zero dev):** Viva's **Virtual Terminal** does keyed MOTO
with no OTP and no PCI burden on us, needing only MOTO enabled.

## What's already in place (this repo)
- **Backend charge → MOTO source.** `POST /api/v1/payments` accepts `"moto": true`
  and charges the `VIVA_MOTO_SOURCE_CODE` source (falls back to the e-commerce
  source if unset). Wired through `PaymentIntent.moto` → `VivaWalletAcquiringAdapter`.
- **`GET /api/v1/viva/native-session`** (device-authed) → `{ accessToken, baseUrl,
  sourceCode }` the SDK needs. (Returns a token today; tokenization works once the
  scope above is granted.)
- **`GET /api/v1/viva/card-capture`** → the keyed-card capture page
  (`card-capture.page.ts`). Holds no secrets; the app passes the session in the URL
  **fragment** so tokens never hit the server.
- **`VIVA_MOTO_SOURCE_CODE`** env (Render) — set it to the MOTO source's 4-digit code.

## Flow once enabled
1. App calls `GET /api/v1/viva/native-session` (device JWT) → `{accessToken, baseUrl, sourceCode}`.
2. App opens a WebView at
   `https://<backend>/api/v1/viva/card-capture#accessToken=…&baseUrl=…&amount=<minor>&currency=EUR&correlation=<id>&deviceToken=<device JWT>&chargeUrl=https://<backend>/api/v1/payments`
3. Operator keys the card → Viva SDK returns a `chargeToken` (PAN/CVC never reach us).
4. Page POSTs `{ paymentToken: chargeToken, maskedPan, cardBrand, amountMinor, currency, correlationToken, moto: true }` to `/api/v1/payments`.
5. Backend charges the MOTO source → `FIAT_APPROVED`, recorded in the immutable ledger. No OTP.

## To finalize the day the scope is granted (the only untestable bits)
In `card-capture.page.ts`, verify three SDK specifics against Viva's current
"Handle Card Tokens" / Native Checkout v2 docs (marked `[verify on enable]`):
the SDK script URL, the `setup`/field-setter calls, and the `requestToken` argument
+ returned token field. Everything else (config-via-fragment, masked-PAN derivation,
brand detection, the charge POST) is final. Then add a "Card entry (MOTO)" button in
the app that performs steps 1–2 above.
