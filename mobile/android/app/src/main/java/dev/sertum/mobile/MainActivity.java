package dev.sertum.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugins have to be registered before the bridge is created.
        registerPlugin(PinnedSocketPlugin.class);
        registerPlugin(NsdBrowserPlugin.class);
        registerPlugin(PhoneDevicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
