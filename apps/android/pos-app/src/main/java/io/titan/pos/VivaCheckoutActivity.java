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

/**
 * Viva Smart Checkout (fiat card payment).
 *
 * Flow: collect an amount → call the Titan backend `POST /api/v1/checkout/orders`
 * (device-authed) to create a Viva order → open Viva's HOSTED checkout page for
 * that order in a WebView. The card is entered on Viva's page; this app never
 * sees PAN/CVV. Framework-only (no SDK) so it builds with the Gradle-free pipeline.
 */
public class VivaCheckoutActivity extends Activity {

    private EditText backendUrl, deviceToken, amount, currency;
    private TextView status;
    private Button payButton;

    /** Pre-filled test device session token (TERM-1). Production: minted by the Auth service. */
    private static final String DEMO_DEVICE_TOKEN =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJURVJNLTEiLCJleHAiOjE4MTQwMzU3MjV9.XGtg688cDXy5b6P8gwOV1UBvG__D8SFEkgUO-jRn2Ms";
    /** Example: your PC's LAN IP where the backend runs. Real phone CANNOT use 10.0.2.2. */
    private static final String DEFAULT_BACKEND = "http://192.168.8.20:3000";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(buildForm());
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
        backendUrl = field("Backend URL (your PC's LAN IP)", DEFAULT_BACKEND, InputType.TYPE_TEXT_VARIATION_URI);
        deviceToken = field("Device session token (pre-filled)", DEMO_DEVICE_TOKEN, InputType.TYPE_CLASS_TEXT);
        amount = field("Amount (minor units, e.g. 100 = 1.00)", "100", InputType.TYPE_CLASS_NUMBER);
        currency = field("Currency", cur, InputType.TYPE_CLASS_TEXT);
        root.addView(backendUrl);
        root.addView(deviceToken);
        root.addView(amount);
        root.addView(currency);

        Button testButton = new Button(this);
        testButton.setText("Test connection");
        testButton.setOnClickListener(v -> testConnection());
        root.addView(testButton);

        payButton = new Button(this);
        payButton.setText("Create order & pay");
        payButton.setOnClickListener(v -> createOrderAndPay());
        root.addView(payButton);

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
        final String correlation = "pos-" + UUID.randomUUID();

        payButton.setEnabled(false);
        status.setText("Creating order...");
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("correlationToken", correlation);
                body.put("merchantId", "MERCH-1");
                body.put("amountMinor", amountMinor);
                body.put("currency", cur);

                HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/v1/checkout/orders").openConnection();
                c.setRequestMethod("POST");
                c.setRequestProperty("Authorization", "Bearer " + token);
                c.setRequestProperty("Content-Type", "application/json");
                c.setConnectTimeout(15000);
                c.setReadTimeout(15000);
                c.setDoOutput(true);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(body.toString().getBytes(StandardCharsets.UTF_8));
                }
                int code = c.getResponseCode();
                String resp = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
                if (code >= 200 && code < 300) {
                    String url = new JSONObject(resp).optString("checkoutUrl", "");
                    if (url.isEmpty()) {
                        showError("No checkoutUrl in response: " + resp);
                    } else {
                        runOnUiThread(() -> openCheckout(url));
                    }
                } else {
                    showError("Order failed (" + code + "): " + resp);
                }
            } catch (Exception e) {
                showError("Error: " + e.getMessage());
            }
        }).start();
    }

    /** Swap the form for Viva's hosted checkout page + a Close bar. */
    private void openCheckout(String url) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.END);
        bar.setBackgroundColor(Color.parseColor("#0B1F1A"));
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

        setContentView(root);
        web.loadUrl(url);
    }

    /** Quick reachability check — GET /api/v1/health with a short timeout. */
    private void testConnection() {
        final String base = backendUrl.getText().toString().trim().replaceAll("/+$", "");
        setStatus("Testing " + base + " ...");
        new Thread(() -> {
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(base + "/api/v1/health").openConnection();
                c.setConnectTimeout(4000);
                c.setReadTimeout(4000);
                int code = c.getResponseCode();
                String resp = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
                if (code == 200) {
                    setStatus("✓ Backend reachable: " + resp);
                } else {
                    setStatus("Reachable, but HTTP " + code + " — wrong path? " + resp);
                }
            } catch (Exception e) {
                setStatus("✗ Not reachable: " + e.getMessage()
                        + "\nCheck: backend running? same Wi-Fi? firewall TCP 3000 open? correct PC IP?");
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
