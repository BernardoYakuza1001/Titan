/**
 * PROJECT TITAN — Viva Native Checkout v2 keyed-card capture page (served HTML).
 *
 * ⚠️ READY-TO-ENABLE, NOT YET LIVE. This page implements keyed MOTO entry: the
 * operator types the card on THIS page, Viva's Native Checkout v2 SDK tokenizes it
 * directly to Viva (the raw PAN/CVC go browser->Viva, never to our backend), and we
 * receive only a one-time `chargeToken` + the MASKED pan, which the backend then
 * charges against the MOTO source (out of 3DS scope). It is gated on TWO Viva
 * enablements that the probe showed are NOT yet present on this account:
 *
 *   1. MOTO enabled on the account (so the charge is out-of-scope for 3DS), AND
 *   2. the OAuth app granted an ONLINE checkout / card-tokenization scope
 *      (e.g. urn:viva:payments:core:api:redirectcheckout). Current scopes are
 *      posmanagement / ecr only, so `VivaPayments.cards.requestToken` will fail
 *      until the scope is added.
 *
 * ENABLE CHECKLIST (verify against Viva "Handle Card Tokens" / Native Checkout v2
 * docs the day the scope is granted — these are the only SDK specifics I could not
 * test without the scope + a card):
 *   [ ] SDK script URL (SDK_SRC below) matches Viva's current Native Checkout v2 SDK.
 *   [ ] Init call (VivaPayments.setup / cards.setup) signature + field setters.
 *   [ ] requestToken(...) argument + resolved token field name.
 * Everything else (config via #hash, masked-pan derivation, brand detection, the
 * POST to /api/v1/payments with moto:true) is final.
 *
 * Config is passed by the app in the URL FRAGMENT (after #) so the OAuth + device
 * tokens are never sent to our server / logs:
 *   .../api/v1/viva/card-capture#accessToken=..&baseUrl=..&sourceCode=..&amount=..
 *      &currency=..&correlation=..&deviceToken=..&chargeUrl=..
 */
export const CARD_CAPTURE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>Card entry (MOTO)</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background:#0E2A23; color:#E6F4EF; margin:0; padding:20px; }
  h1 { font-size:18px; margin:0 0 16px; }
  label { display:block; font-size:13px; color:#9FC4B6; margin:12px 0 4px; }
  input { width:100%; box-sizing:border-box; padding:12px; font-size:16px; border:1px solid #2E5547;
          border-radius:8px; background:#0B1F1A; color:#E6F4EF; }
  .row { display:flex; gap:12px; } .row > div { flex:1; }
  button { width:100%; margin-top:20px; padding:14px; font-size:16px; font-weight:600; border:0;
           border-radius:8px; background:#1E7A5A; color:#fff; }
  button[disabled] { opacity:.5; }
  #msg { margin-top:16px; font-size:14px; white-space:pre-wrap; }
  .ok { color:#7FE3B4; } .err { color:#FF9F9F; }
  .note { font-size:12px; color:#7FA89B; margin-top:8px; }
</style>
</head>
<body>
  <h1>Card entry — MOTO (no OTP)</h1>
  <form id="f" autocomplete="off">
    <label>Cardholder name</label>
    <input id="holder" inputmode="text" />
    <label>Card number</label>
    <input id="number" inputmode="numeric" autocomplete="cc-number" placeholder="•••• •••• •••• ••••" />
    <div class="row">
      <div><label>Expiry MM</label><input id="mm" inputmode="numeric" maxlength="2" placeholder="MM" /></div>
      <div><label>Expiry YYYY</label><input id="yyyy" inputmode="numeric" maxlength="4" placeholder="YYYY" /></div>
      <div><label>CVC</label><input id="cvc" inputmode="numeric" maxlength="4" placeholder="CVC" /></div>
    </div>
    <button id="pay" type="submit">Charge</button>
    <div class="note">Card data is tokenized directly by Viva. This terminal never stores the full card number.</div>
  </form>
  <div id="msg"></div>

<script>
  // ---- config from URL fragment (kept off the server) ----
  var cfg = {};
  (location.hash.slice(1)).split('&').forEach(function (kv) {
    if (!kv) return; var p = kv.split('='); cfg[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || '');
  });
  var msg = document.getElementById('msg');
  function show(t, cls) { msg.textContent = t; msg.className = cls || ''; }

  // ---- helpers (final; no Viva dependency) ----
  function digits(s) { return (s || '').replace(/\\D/g, ''); }
  function brandOf(n) {
    if (/^4/.test(n)) return 'VISA';
    if (/^(5[1-5]|2[2-7])/.test(n)) return 'MASTERCARD';
    if (/^3[47]/.test(n)) return 'AMEX';
    if (/^(6011|65|64[4-9])/.test(n)) return 'DISCOVER';
    if (/^3(0[0-5]|6|8)/.test(n)) return 'DINERS';
    if (/^35/.test(n)) return 'JCB';
    if (/^62/.test(n)) return 'UNIONPAY';
    return 'UNKNOWN';
  }
  function maskedOf(n) {
    var first = n.slice(0, 6), last = n.slice(-4);
    var stars = Math.max(2, n.length - first.length - last.length);
    return first + new Array(stars + 1).join('*') + last;
  }

  // ---- Native Checkout v2 SDK ----
  // [verify on enable] exact SDK URL from Viva's Native Checkout v2 docs.
  var SDK_SRC = (cfg.baseUrl || 'https://api.vivapayments.com') + '/web/checkout/v2/js';
  var sdk = document.createElement('script');
  sdk.src = SDK_SRC;
  sdk.onload = function () { show('Ready.'); };
  sdk.onerror = function () { show('Could not load the Viva SDK from ' + SDK_SRC + '\\n(Is the online card-tokenization scope enabled?)', 'err'); };
  document.head.appendChild(sdk);

  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var number = digits(document.getElementById('number').value);
    var cvc = digits(document.getElementById('cvc').value);
    var mm = digits(document.getElementById('mm').value);
    var yyyy = digits(document.getElementById('yyyy').value);
    var holder = document.getElementById('holder').value.trim();
    if (number.length < 12 || cvc.length < 3 || mm.length < 1 || yyyy.length < 4) { show('Check the card fields.', 'err'); return; }

    var pay = document.getElementById('pay'); pay.disabled = true; show('Tokenizing with Viva…');

    // [verify on enable] init + setters + requestToken per Viva Native Checkout v2 docs.
    try {
      VivaPayments.setup({ baseURL: cfg.baseUrl, accessToken: cfg.accessToken });
      VivaPayments.cards.setCardHolderName(holder);
      VivaPayments.cards.setCardNumber(number);
      VivaPayments.cards.setExpirationMonth(mm.padStart(2, '0'));
      VivaPayments.cards.setExpirationYear(yyyy);
      VivaPayments.cards.setCvc(cvc);
    } catch (err) {
      show('Viva SDK not available yet: ' + err + '\\n(Enable the online card-tokenization OAuth scope.)', 'err');
      pay.disabled = false; return;
    }

    VivaPayments.cards.requestToken({ amount: Number(cfg.amount) })
      .then(function (res) {
        var chargeToken = (res && (res.chargeToken || res.token)) || res;
        return charge(chargeToken, maskedOf(number), brandOf(number));
      })
      .catch(function (err) { show('Tokenization failed: ' + err, 'err'); pay.disabled = false; });
  });

  // ---- charge the chargeToken on our backend (MOTO source) ----
  function charge(chargeToken, maskedPan, cardBrand) {
    show('Charging…');
    return fetch(cfg.chargeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.deviceToken },
      body: JSON.stringify({
        correlationToken: cfg.correlation,
        merchantId: cfg.merchantId || 'MERCH-1',
        amountMinor: Number(cfg.amount),
        currency: cfg.currency,
        paymentToken: chargeToken,
        maskedPan: maskedPan,
        cardBrand: cardBrand,
        moto: true
      })
    }).then(function (r) { return r.json().then(function (b) { return { s: r.status, b: b }; }); })
      .then(function (o) {
        if (o.s >= 200 && o.s < 300 && o.b && o.b.status === 'FIAT_APPROVED') {
          show('✓ Approved — ' + maskedPan, 'ok');
        } else {
          show('Declined / error (' + o.s + '): ' + JSON.stringify(o.b), 'err');
          document.getElementById('pay').disabled = false;
        }
      });
  }
</script>
</body>
</html>`;
