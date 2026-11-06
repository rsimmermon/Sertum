package dev.sertum.mobile;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Collections;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

import okhttp3.ConnectionSpec;
import okhttp3.Handshake;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.TlsVersion;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * A WebSocket whose TLS trust is one pinned public key and nothing else.
 *
 * A LAN daemon has no name a public CA could vouch for, and its address moves,
 * so the system trust store and hostname check are both replaced by the key
 * learned out of band from the pairing QR code. The socket lives here rather
 * than in the WebView because a WebView offers no way to pin one.
 */
@CapacitorPlugin(name = "PinnedSocket")
public class PinnedSocketPlugin extends Plugin {
    private WebSocket socket;
    private int connections = 0;

    private static X509TrustManager pinnedTo(final byte[] pin) {
        return new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                throw new CertificateException("This client does not accept client connections.");
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0) throw new CertificateException("No certificate presented.");
                try {
                    byte[] actual = MessageDigest.getInstance("SHA-256").digest(chain[0].getPublicKey().getEncoded());
                    if (!MessageDigest.isEqual(actual, pin)) {
                        throw new CertificateException("Server key does not match the paired key.");
                    }
                } catch (GeneralSecurityException e) {
                    throw new CertificateException(e);
                }
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        };
    }

    @PluginMethod
    public void connect(PluginCall call) {
        String url = call.getString("url");
        String pinText = call.getString("pinSha256");
        if (url == null || pinText == null) {
            call.reject("url and pinSha256 are required");
            return;
        }
        byte[] pin = Base64.decode(pinText, Base64.DEFAULT);
        if (pin.length != 32) {
            call.reject("pinSha256 must be a base64 SHA-256 digest");
            return;
        }
        try {
            // A socket being replaced may still report. Every event names its
            // connection, so the app can tell that from the one it is using.
            if (socket != null) socket.cancel();
            final int connection = ++connections;
            X509TrustManager trust = pinnedTo(pin);
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[] { trust }, null);
            OkHttpClient client = new OkHttpClient.Builder()
                .sslSocketFactory(context.getSocketFactory(), trust)
                // The pin authenticates the peer; the address proves nothing here.
                .hostnameVerifier((hostname, session) -> true)
                .connectionSpecs(Collections.singletonList(
                    new ConnectionSpec.Builder(ConnectionSpec.RESTRICTED_TLS).tlsVersions(TlsVersion.TLS_1_3).build()))
                .connectTimeout(8, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .pingInterval(20, TimeUnit.SECONDS)
                .build();
            socket = client.newWebSocket(new Request.Builder().url(url).build(), new WebSocketListener() {
                @Override
                public void onOpen(WebSocket webSocket, Response response) {
                    JSObject data = new JSObject();
                    data.put("connection", connection);
                    Handshake handshake = response.handshake();
                    data.put("tls", handshake == null ? "none" : handshake.tlsVersion().javaName() + " " + handshake.cipherSuite().javaName());
                    notifyListeners("open", data);
                }

                @Override
                public void onMessage(WebSocket webSocket, String text) {
                    JSObject data = new JSObject();
                    data.put("connection", connection);
                    data.put("text", text);
                    notifyListeners("message", data);
                }

                @Override
                public void onClosing(WebSocket webSocket, int code, String reason) {
                    webSocket.close(1000, null);
                    onClosed(webSocket, code, reason);
                }

                @Override
                public void onClosed(WebSocket webSocket, int code, String reason) {
                    JSObject data = new JSObject();
                    data.put("connection", connection);
                    data.put("code", code);
                    notifyListeners("closed", data);
                }

                @Override
                public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                    JSObject data = new JSObject();
                    data.put("connection", connection);
                    data.put("message", String.valueOf(t.getMessage()));
                    notifyListeners("failure", data);
                }
            });
            JSObject result = new JSObject();
            result.put("connection", connection);
            call.resolve(result);
        } catch (GeneralSecurityException e) {
            call.reject(e.getMessage());
        }
    }

    @PluginMethod
    public void send(PluginCall call) {
        String text = call.getString("text");
        JSObject result = new JSObject();
        result.put("queued", socket != null && text != null && socket.send(text));
        call.resolve(result);
    }

    @PluginMethod
    public void close(PluginCall call) {
        if (socket != null) socket.close(1000, null);
        socket = null;
        call.resolve();
    }
}
