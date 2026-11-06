package dev.sertum.mobile;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Finds daemons through Android's NsdManager. Written here rather than taken
 * from a plugin because it is this small and the licensing of the maintained
 * option is unconfirmed. Android 13+ manages multicast for a foreground app;
 * the lock is for the older releases that do not.
 */
@CapacitorPlugin(name = "NsdBrowser")
public class NsdBrowserPlugin extends Plugin {
    private NsdManager manager;
    private NsdManager.DiscoveryListener listener;
    private WifiManager.MulticastLock lock;

    private void fail(String stage, int code) {
        JSObject data = new JSObject();
        data.put("stage", stage);
        data.put("code", code);
        notifyListeners("error", data);
    }

    @PluginMethod
    public void start(PluginCall call) {
        String type = call.getString("type");
        if (type == null) {
            call.reject("type is required");
            return;
        }
        Context context = getContext();
        manager = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
        WifiManager wifi = (WifiManager) context.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wifi != null) {
            lock = wifi.createMulticastLock("sertum-discovery");
            lock.setReferenceCounted(false);
            lock.acquire();
        }
        listener = new NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String t, int code) { fail("start", code); }
            @Override public void onStopDiscoveryFailed(String t, int code) { fail("stop", code); }
            @Override public void onDiscoveryStarted(String t) { }
            @Override public void onDiscoveryStopped(String t) { }
            @Override public void onServiceLost(NsdServiceInfo info) { }

            @Override
            public void onServiceFound(NsdServiceInfo info) {
                manager.resolveService(info, new NsdManager.ResolveListener() {
                    @Override public void onResolveFailed(NsdServiceInfo i, int code) { fail("resolve", code); }

                    @Override
                    public void onServiceResolved(NsdServiceInfo i) {
                        JSObject data = new JSObject();
                        data.put("name", i.getServiceName());
                        data.put("host", i.getHost() == null ? null : i.getHost().getHostAddress());
                        data.put("port", i.getPort());
                        notifyListeners("found", data);
                    }
                });
            }
        };
        manager.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (manager != null && listener != null) manager.stopServiceDiscovery(listener);
        listener = null;
        if (lock != null && lock.isHeld()) lock.release();
        call.resolve();
    }
}
