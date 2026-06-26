package io.titan.pos;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

/**
 * Card terminal screen: pick a fiat profile, optionally run the offline flow
 * simulation, or take a real card payment via Viva Smart Checkout.
 */
public class ProfileActivity extends Activity {

    private static final int PROFILE_ID_BASE = 1000;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_profile);

        final List<TitanFlow.Profile> profiles = TitanFlow.profiles();
        final RadioGroup group = findViewById(R.id.profileGroup);
        for (int i = 0; i < profiles.size(); i++) {
            RadioButton rb = new RadioButton(this);
            rb.setId(PROFILE_ID_BASE + i);
            TitanFlow.Profile p = profiles.get(i);
            rb.setText(p.label + "   " + p.summary());
            rb.setTextColor(0xFFE6F4EF);
            group.addView(rb);
        }
        group.check(PROFILE_ID_BASE);

        final TextView log = findViewById(R.id.log);
        final ScrollView logScroll = findViewById(R.id.logScroll);
        final CheckBox sDecline = findViewById(R.id.scenarioDecline);
        final CheckBox sTimeout = findViewById(R.id.scenarioTimeout);
        final Button run = findViewById(R.id.runButton);

        run.setOnClickListener(v -> {
            int idx = group.getCheckedRadioButtonId() - PROFILE_ID_BASE;
            if (idx < 0) idx = 0;
            int scenario = sDecline.isChecked() ? 1 : sTimeout.isChecked() ? 2 : 0;
            log.setText("");
            run.setEnabled(false);
            TitanFlow.simulate(profiles.get(idx), scenario,
                line -> {
                    log.append(line + "\n");
                    logScroll.post(() -> logScroll.fullScroll(View.FOCUS_DOWN));
                },
                () -> run.setEnabled(true));
        });

        // Real card payment via Viva Smart Checkout (hosted page; no card data here).
        Button viva = findViewById(R.id.vivaButton);
        viva.setOnClickListener(v -> {
            int idx = group.getCheckedRadioButtonId() - PROFILE_ID_BASE;
            if (idx < 0) idx = 0;
            Intent i = new Intent(this, VivaCheckoutActivity.class);
            i.putExtra("currency", profiles.get(idx).currency);
            startActivity(i);
        });

        Button exit = findViewById(R.id.exitButton);
        exit.setOnClickListener(v -> {
            try { stopLockTask(); } catch (Exception ignored) { }
            finishAndRemoveTask();
        });
    }
}
