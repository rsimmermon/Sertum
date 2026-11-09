package dev.sertum.mobile;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins have to be registered before the bridge is created.
        registerPlugin(PinnedSocketPlugin.class);
        registerPlugin(PhoneDevicePlugin.class);
        registerPlugin(NsdBrowserPlugin.class);
        super.onCreate(savedInstanceState);

        // The shell's screens (a conversation, the PCs page, pairing) are entries in
        // the WebView's own history. Without @capacitor/app nothing walks them, and
        // Back closed the app from any screen; it now steps back through them and
        // only leaves the app from the session list.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() == null ? null : getBridge().getWebView();
                if (web != null && web.canGoBack()) {
                    web.goBack();
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
    }
}
