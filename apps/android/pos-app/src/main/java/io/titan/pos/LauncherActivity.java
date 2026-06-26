package io.titan.pos;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Kiosk home + admin login (Phase 2 launcher surface).
 *
 * SKELETON: the PIN check is a local demo constant. A production terminal
 * authenticates the TERMINAL_ADMIN role against the backend Auth service over
 * mTLS; this screen only shows the kiosk shell.
 */
public class LauncherActivity extends Activity {

    /** DEMO ONLY — real auth is server-side. */
    private static final String DEMO_ADMIN_PIN = "8888";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_launcher);

        TextView deviceId = findViewById(R.id.deviceId);
        deviceId.setText("Device  •  " + Build.MANUFACTURER + " " + Build.MODEL);

        // Best-effort kiosk pinning; only effective as Device Owner, harmless otherwise.
        try { startLockTask(); } catch (Exception ignored) { }

        final EditText pin = findViewById(R.id.pinInput);
        Button login = findViewById(R.id.loginButton);
        login.setOnClickListener(v -> {
            String entered = pin.getText() == null ? "" : pin.getText().toString();
            if (DEMO_ADMIN_PIN.equals(entered)) {
                startActivity(new Intent(this, ProfileActivity.class));
                pin.setText("");
            } else {
                Toast.makeText(this, R.string.wrong_pin, Toast.LENGTH_SHORT).show();
                pin.setText("");
            }
        });

        Button exit = findViewById(R.id.exitButton);
        exit.setOnClickListener(v -> exitApp());
    }

    /** Leave kiosk lock-task (if active) and close the app cleanly. */
    private void exitApp() {
        try { stopLockTask(); } catch (Exception ignored) { }
        finishAndRemoveTask();
    }
}
