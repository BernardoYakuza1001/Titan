package io.titan.pos;

import android.os.Handler;
import android.os.Looper;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Local simulation of the FIAT card-acquiring flow — mirrors the Viva backend's
 * fiat_transaction_log lifecycle (FIAT_CREATED → FIAT_PROCESSING → FIAT_APPROVED /
 * FIAT_DECLINED). It moves no money; it's an offline demo of the terminal flow.
 * The REAL payment is "Pay by card (Viva)", which creates an order on the backend
 * and opens Viva's hosted checkout.
 */
public final class TitanFlow {

    private TitanFlow() { }

    public interface Emit { void line(String s); }

    /** A card-terminal profile (fiat acquiring — no crypto). */
    public static final class Profile {
        public final String label, cvm, capture, currency;
        public final int capMajor;   // per-transaction cap in major units
        Profile(String label, String cvm, String capture, int capMajor, String currency) {
            this.label = label; this.cvm = cvm; this.capture = capture;
            this.capMajor = capMajor; this.currency = currency;
        }
        public String summary() {
            return cvm + " · " + capture + " · cap " + capMajor + " " + currency;
        }
    }

    /** Card-terminal profiles. */
    public static List<Profile> profiles() {
        return Arrays.asList(
            new Profile("201.1", "Contactless (no CVM)", "CARD_PRESENT", 150,  "EUR"),
            new Profile("201.2", "Chip & PIN",           "CARD_PRESENT", 500,  "EUR"),
            new Profile("201.3", "MOTO (keyed)",         "CARD_NOT_PRESENT", 1000, "EUR"),
            new Profile("201.4", "Pre-authorization",    "CARD_PRESENT", 2000, "EUR")
        );
    }

    /** scenario: 0=approved, 1=declined, 2=gateway timeout. */
    public static void simulate(Profile p, int scenario, Emit emit, Runnable onDone) {
        List<String> lines = new ArrayList<>();
        lines.add("▶ " + p.label + "  " + p.summary());
        lines.add("   → FIAT_CREATED");
        lines.add("   → FIAT_PROCESSING (Viva)");

        if (scenario == 1) {
            lines.add("   ⛔ issuer declined (Do not honor)");
            lines.add("   → FIAT_DECLINED");
            lines.add("✖ DECLINED — no funds captured");
        } else if (scenario == 2) {
            lines.add("   ⚠ gateway timeout");
            lines.add("   → FIAT_DECLINED");
            lines.add("✖ TIMEOUT — safe to retry (idempotent)");
        } else {
            lines.add("   authorized · auth code 8A1B2C");
            lines.add("   → FIAT_APPROVED");
            lines.add("   masked PAN 4111 11** **** 1111 · logged to immutable ledger");
            lines.add("✔ APPROVED — receipt printed");
        }

        stepOut(lines, 0, emit, onDone, new Handler(Looper.getMainLooper()));
    }

    private static void stepOut(List<String> lines, int i, Emit emit, Runnable onDone, Handler h) {
        if (i >= lines.size()) { onDone.run(); return; }
        emit.line(lines.get(i));
        h.postDelayed(() -> stepOut(lines, i + 1, emit, onDone, h), 220);
    }
}
