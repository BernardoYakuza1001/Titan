package io.titan.pos;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Viva Smart Checkout (fiat card payment) + payment confirmation.
 *
 * Flow: collect an amount → call the Titan backend `POST /api/v1/checkout/orders`
 * (device-authed) to create a Viva order → open Viva's HOSTED checkout page in a
 * WebView. The card is entered on Viva's page; this app never sees PAN/CVV. After
 * the page opens we POLL `GET /api/v1/checkout/orders/{orderCode}` until the
 * backend (notified by Viva's webhook) reports PAID or FAILED, then show a result.
 * Framework-only (no SDK) so it builds with the Gradle-free pipeline.
 */
public class VivaCheckoutActivity extends Activity {

    private EditText backendUrl, deviceToken, amount, currency, initialTxnId;
    private CheckBox motoCheck, recurringCheck;
    private TextView status;
    private Button payButton;

    /** Pre-filled test device session token (TERM-1). Production: minted by the Auth service. */
    private static final String DEMO_DEVICE_TOKEN =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJURVJNLTEiLCJleHAiOjE4MTQwMzU3MjV9.XGtg688cDXy5b6P8gwOV1UBvG__D8SFEkgUO-jRn2Ms";
    /** Cloud backend (Render). Works from any network — no PC / LAN IP / firewall. */
    private static final String DEFAULT_BACKEND = "https://titan-acquiring.onrender.com";

    /** Polling: ~2 minutes at 3s intervals while the customer pays on Viva's page. */
    private static final int POLL_INTERVAL_MS = 3000;
    private static final int POLL_MAX_ATTEMPTS = 40;

    private volatile boolean destroyed = false;
    private final AtomicBoolean settled = new AtomicBoolean(false); // a terminal result was shown
    private WebView checkoutWeb;                                    // held so we can destroy it

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildForm());
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        // Tear the WebView down explicitly — otherwise it leaks the Activity + a
        // native rendering context every time checkout opens (a real problem on a
        // long-running kiosk terminal).
        if (checkoutWeb != null) {
            try {
                ViewGroup parent = (ViewGroup) checkoutWeb.getParent();
                if (parent != null) parent.removeView(checkoutWeb);
                checkoutWeb.stopLoading();
                checkoutWeb.loadUrl("about:blank");
                checkoutWeb.removeAllViews();
                checkoutWeb.destroy();
            } catch (Exception ignored) {
            }
            checkoutWeb = null;
        }
        super.onDestroy();
    }

    private LinearLayout buildForm() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0E2A23"));
        root.setPadding(40, 40, 40, 40);

        TextView title = new TextView(this);
        title.setText("Pay by card — Viva Smart Checkout");
        title.setTextColor(0xFFE6F4EF);
        title.setTextSize(20);
        title.setPadding(0, 0, 0, 24);
        root.addView(title);

        String cur = getIntent().getStringExtra("currency");
        if (cur == null || cur.isEmpty()) cur = "EUR";
        backendUrl = field("Backend URL (cloud)", DEFAULT_BACKEND, InputType.TYPE_TEXT_VARIATION_URI);
        deviceToken = field("Device session token (pre-filled)", DEMO_DEVICE_TOKEN, InputType.TYPE_CLASS_TEXT);
        amount = field("Amount (minor units, e.g. 100 = 1.00)", "100", InputType.TYPE_CLASS_NUMBER);
        currency = field("Currency", cur, InputType.TYPE_CLASS_TEXT);
        root.addView(backendUrl);
        root.addView(deviceToken);
        root.addView(amount);
        root.addView(currency);

        motoCheck = new CheckBox(this);
        motoCheck.setText("MOTO — manual / telephone order (no OTP)");
        motoCheck.setTextColor(0xFFE6F4EF);
        motoCheck.setPadding(0, 12, 0, 8);
        root.addView(motoCheck);

        recurringCheck = new CheckBox(this);
        recurringCheck.setText("Enable recurring mandate (lets you charge again later with NO OTP)");
        recurringCheck.setTextColor(0xFFE6F4EF);
        recurringCheck.setPadding(0, 0, 0, 12);
        root.addView(recurringCheck);

        Button testButton = new Button(this);
        testButton.setText("Test connection");
        testButton.setOnClickListener(v -> testConnection());
        root.addView(testButton);

        payButton = new Button(this);
        payButton.setText("Create order & pay");
        payButton.setOnClickListener(v -> createOrderAndPay());
        root.addView(payButton);

        // ---- Repeat charge (merchant-initiated, NO OTP) ----
        TextView repeatHint = new TextView(this);
        repeatHint.setText("— or charge a returning customer (no OTP) —");
        repeatHint.setTextColor(0xFF7FA89B);
        repeatHint.setPadding(0, 24, 0, 4);
        root.addView(repeatHint);

        initialTxnId = field("Initial txn ID (from a prior recurring-mandate payment)", "", InputType.TYPE_CLASS_TEXT);
        root.addView(initialTxnId);

        Button repeatButton = new Button(this);
        repeatButton.setText("Repeat charge (no OTP)");
        repeatButton.setOnClickListener(v -> repeatCharge());
        root.addView(repeatButton);

        status = new TextView(this);
        status.setTextColor(0xFFE6F4EF);
        status.setPadding(0, 24, 0, 0);
        root.addView(status);
        return root;
    }

    private EditText field(String hint, String def, int inputType) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setText(def);
        e.setInputType(inputType);
        e.setTextColor(0xFFE6F4EF);
        e.setHintTextColor(0xFF7FA89B);
        return e;
    }

    private void createOrderAndPay() {
        final String base = backendUrl.getText().toString().trim().replaceAll("/+$", "");
        final String token = deviceToken.getText().toString().trim();
        final String cur = currency.getText().toString().trim().toUpperCase();
        long amt;
        try {
            amt = Long.parseLong(amount.getText().toString().trim());
        } catch (Exception e) {
            Toast.makeText(this, "Invalid amount", Toast.LENGTH_SHORT).show();
            return;
        }
        if (token.isEmpty()) {
            Toast.makeText(this, "Device token required", Toast.LENGTH_SHORT).show();
            return;
        }
        final long amountMinor = amt;
        final boolean moto = motoCheck.isChecked();
        final boolean recurring = recurringCheck.isChecked();
        final String correlation = "pos-" + UUID.randomUUID();

        if (base.startsWith("http://") && !base.contains("localhost") && !base.contains("127.0.0.1")) {
            Toast.makeText(this, "Warning: http (not https) sends the device token in the clear. Use https in production.",
                    Toast.LENGTH_LONG).show();
        }

        payButton.setEnabled(false);
        status.setText("Creating order... (first call may take ~30s if the server was idle)");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("correlationToken", correlation);
                body.put("merchantId", "MERCH-1");
                body.put("amountMinor", amountMinor);
                body.put("currency", cur);
                body.put("moto", moto);
                body.put("recurring", recurring);

                HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/v1/checkout/orders").openConnection();
                c.setRequestMethod("POST");
                c.setRequestProperty("Authorization", "Bearer " + token);
                c.setRequestProperty("Content-Type", "application/json");
                c.setConnectTimeout(20000);   // tolerate Render free-tier cold start
                c.setReadTimeout(40000);
                c.setDoOutput(true);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                int code = c.getResponseCode();
                String resp = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
                if (code >= 200 && code < 300) {
                    JSONObject j = new JSONObject(resp);
                    String url = j.optString("checkoutUrl", "");
                    String orderCode = j.optString("orderCode", "");
                    if (url.isEmpty()) {
                        showError("No checkoutUrl in response: " + resp);
                    } else {
                        runOnUiThread(() -> openCheckout(url, orderCode, base, token));
                    }
                } else {
                    showError("Order failed (" + code + "): " + resp);
                }
            } catch (Exception e) {
                showError("Error: " + e.getMessage());
            }
        }).start();
    }

    /** Swap the form for Viva's hosted checkout page + a bar, and start polling for the result. */
    private void openCheckout(String url, final String orderCode, final String base, final String token) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        LinearLayout bar = new LinearLayout(this);
        bar.setBackgroundColor(Color.parseColor("#0B1F1A"));
        bar.setGravity(Gravity.CENTER_VERTICAL);

        final TextView poll = new TextView(this);
        poll.setText("  Waiting for payment…");
        poll.setTextColor(0xFFBFE3D6);
        bar.addView(poll, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button check = new Button(this);
        check.setText("Check status");
        check.setOnClickListener(v -> checkStatusOnce(base, token, orderCode, poll));
        bar.addView(check);

        Button close = new Button(this);
        close.setText("✕ Close");
        close.setOnClickListener(v -> finish());
        bar.addView(close);

        root.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        WebView web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient());
        root.addView(web, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        checkoutWeb = web;
        setContentView(root);
        web.loadUrl(url);

        if (orderCode != null && !orderCode.isEmpty()) {
            startPolling(base, token, orderCode, poll);
        } else {
            // Without an order code we cannot confirm — say so instead of waiting forever.
            poll.setText("  Cannot track payment automatically — missing order reference");
            check.setEnabled(false);
        }
    }

    /** Render the result EXACTLY once if the status is terminal. Returns true once settled.
     *  Takes the full status JSON body so it can surface the Viva transaction id (the
     *  anchor a returning customer is charged against with no OTP). */
    private boolean renderIfTerminal(String body, final String orderCode) {
        if (body == null) return settled.get();
        String st = "", txn = "";
        try {
            JSONObject j = new JSONObject(body);
            st = j.optString("status", "");
            txn = j.optString("vivaTransactionId", "");
        } catch (Exception e) {
            return settled.get();
        }
        final String fTxn = txn;
        if ("PAID".equals(st) && settled.compareAndSet(false, true)) {
            runOnUiThread(() -> showResult(true, orderCode, fTxn));
            return true;
        }
        if ("FAILED".equals(st) && settled.compareAndSet(false, true)) {
            runOnUiThread(() -> showResult(false, orderCode, ""));
            return true;
        }
        return settled.get();
    }

    /** Background loop: ask the backend for the order status until it settles. */
    private void startPolling(final String base, final String token, final String orderCode, final TextView poll) {
        new Thread(() -> {
            int attempts = 0;
            while (!destroyed && !settled.get() && attempts < POLL_MAX_ATTEMPTS) {
                attempts++;
                if (renderIfTerminal(safeStatusBody(base, token, orderCode), orderCode)) return;
                try { Thread.sleep(POLL_INTERVAL_MS); } catch (InterruptedException e) { return; }
            }
            // Gave up auto-polling (e.g. webhook slower than the window) — DON'T show
            // failure (the payment may have succeeded). Prompt the operator to confirm.
            if (!destroyed && !settled.get()) {
                runOnUiThread(() -> poll.setText("  Still pending — tap ‘Check status’ to confirm"));
            }
        }).start();
    }

    /** Manual one-shot status check (fallback if the customer says they paid). */
    private void checkStatusOnce(final String base, final String token, final String orderCode, final TextView poll) {
        runOnUiThread(() -> poll.setText("  Checking…"));
        new Thread(() -> {
            String body = safeStatusBody(base, token, orderCode);
            if (renderIfTerminal(body, orderCode)) return;
            String shown = "PENDING";
            try { if (body != null) shown = new JSONObject(body).optString("status", "PENDING"); } catch (Exception ignored) { }
            final String f = shown;
            runOnUiThread(() -> poll.setText("  Status: " + f + " — waiting…"));
        }).start();
    }

    /** GET the order status; returns the raw JSON body (status + vivaTransactionId) or null. */
    private String safeStatusBody(String base, String token, String orderCode) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/v1/checkout/orders/" + orderCode).openConnection();
            c.setRequestProperty("Authorization", "Bearer " + token);
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            int code = c.getResponseCode();
            String resp = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
            if (code == 200) return resp;
        } catch (Exception ignored) {
            // network blip / cold start — the loop will retry
        }
        return null;
    }

    /** Final result screen. On success, surfaces the Viva transaction id — save it as
     *  the customer's anchor to charge them again later with NO OTP. */
    private void showResult(boolean success, String orderCode, String vivaTxnId) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(success ? Color.parseColor("#0E2A23") : Color.parseColor("#2A0E12"));
        root.setPadding(48, 48, 48, 48);

        TextView t = new TextView(this);
        t.setText(success ? "✓ Payment received" : "✗ Payment failed / cancelled");
        t.setTextColor(0xFFE6F4EF);
        t.setTextSize(26);
        t.setGravity(Gravity.CENTER);
        root.addView(t);

        TextView sub = new TextView(this);
        sub.setText("Order " + orderCode);
        sub.setTextColor(0xFF9FC4B6);
        sub.setPadding(0, 16, 0, 16);
        sub.setGravity(Gravity.CENTER);
        root.addView(sub);

        if (success && vivaTxnId != null && !vivaTxnId.isEmpty()) {
            TextView anchor = new TextView(this);
            anchor.setText("Recurring anchor (save for no-OTP repeat charges):\n" + vivaTxnId);
            anchor.setTextColor(0xFFBFE3D6);
            anchor.setTextIsSelectable(true);
            anchor.setPadding(0, 0, 0, 28);
            anchor.setGravity(Gravity.CENTER);
            root.addView(anchor);
        }

        Button done = new Button(this);
        done.setText("Done");
        done.setOnClickListener(v -> finish());
        root.addView(done);

        setContentView(root);
    }

    /** Merchant-initiated repeat charge — NO OTP. Charges a returning customer by
     *  chaining off the initial recurring-mandate transaction id. */
    private void repeatCharge() {
        final String base = backendUrl.getText().toString().trim().replaceAll("/+$", "");
        final String token = deviceToken.getText().toString().trim();
        final String cur = currency.getText().toString().trim().toUpperCase();
        final String initTxn = initialTxnId.getText().toString().trim();
        if (initTxn.isEmpty()) {
            Toast.makeText(this, "Enter the initial transaction ID (from a prior recurring-mandate payment)", Toast.LENGTH_LONG).show();
            return;
        }
        long amt;
        try {
            amt = Long.parseLong(amount.getText().toString().trim());
        } catch (Exception e) {
            Toast.makeText(this, "Invalid amount", Toast.LENGTH_SHORT).show();
            return;
        }
        final long amountMinor = amt;
        final String correlation = "rec-" + UUID.randomUUID();
        setStatus("Charging returning customer (no OTP)…");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("correlationToken", correlation);
                body.put("merchantId", "MERCH-1");
                body.put("initialTransactionId", initTxn);
                body.put("amountMinor", amountMinor);
                body.put("currency", cur);

                HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/v1/recurring/charge").openConnection();
                c.setRequestMethod("POST");
                c.setRequestProperty("Authorization", "Bearer " + token);
                c.setRequestProperty("Content-Type", "application/json");
                c.setConnectTimeout(20000);
                c.setReadTimeout(40000);
                c.setDoOutput(true);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                int code = c.getResponseCode();
                String resp = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
                if (code >= 200 && code < 300) {
                    JSONObject j = new JSONObject(resp);
                    String st = j.optString("status", "");
                    if ("RECURRING_APPROVED".equals(st)) {
                        setStatus("✓ Charged (no OTP) — txn " + j.optString("vivaTransactionId", ""));
                    } else {
                        setStatus("Declined: " + resp);
                    }
                } else {
                    setStatus("Charge failed (" + code + "): " + resp);
                }
            } catch (Exception e) {
                setStatus("Error: " + e.getMessage());
            }
        }).start();
    }

    /** Quick reachability check — GET /api/v1/health with a short timeout. */
    private void testConnection() {
        final String base = backendUrl.getText().toString().trim().replaceAll("/+$", "");
        setStatus("Testing " + base + " ... (cold start can take ~30s)");
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/v1/health").openConnection();
                c.setConnectTimeout(12000);
                c.setReadTimeout(12000);
                int code = c.getResponseCode();
                String resp = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
                if (code == 200) {
                    setStatus("✓ Backend reachable: " + resp);
                } else {
                    setStatus("Reachable, but HTTP " + code + " — wrong path? " + resp);
                }
            } catch (Exception e) {
                setStatus("✗ Not reachable: " + e.getMessage()
                        + "\nIf this is the Render URL, wait ~30s (cold start) and retry. Check the URL is https and correct.");
            }
        }).start();
    }

    private void setStatus(String msg) {
        runOnUiThread(() -> status.setText(msg));
    }

    private void showError(String msg) {
        runOnUiThread(() -> {
            status.setText(msg);
            payButton.setEnabled(true);
        });
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) sb.append(line);
        }
        return sb.toString();
    }
}
