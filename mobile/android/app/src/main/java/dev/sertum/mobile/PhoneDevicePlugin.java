package dev.sertum.mobile;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.common.MlKitException;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.ECGenParameterSpec;

/**
 * What the WebView cannot do itself: hold a key that cannot leave this phone,
 * point the camera at a pairing code, and read the clipboard for a paste.
 *
 * The key lives in the Android Keystore, so neither this app nor a backup of it
 * can read it. Google's code scanner runs in its own process and hands back only
 * what it scanned, which is why the app does not need the camera permission.
 */
@CapacitorPlugin(name = "PhoneDevice")
public class PhoneDevicePlugin extends Plugin {
    private static final String ALIAS = "sertum-device";
    private static final String KEYSTORE = "AndroidKeyStore";

    private static KeyStore store() throws Exception {
        KeyStore keys = KeyStore.getInstance(KEYSTORE);
        keys.load(null);
        return keys;
    }

    @PluginMethod
    public void deviceKey(PluginCall call) {
        try {
            KeyStore keys = store();
            if (!keys.containsAlias(ALIAS)) {
                KeyPairGenerator generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE);
                generator.initialize(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                    .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    // A locked phone cannot prove anything, so a thief needs the unlock too.
                    .setUnlockedDeviceRequired(true)
                    .build());
                generator.generateKeyPair();
            }
            JSObject result = new JSObject();
            result.put("publicKey", Base64.encodeToString(
                keys.getCertificate(ALIAS).getPublicKey().getEncoded(), Base64.NO_WRAP));
            result.put("name", Build.MANUFACTURER + " " + Build.MODEL);
            call.resolve(result);
        } catch (Exception e) {
            call.reject("Could not reach this phone's key: " + e.getMessage());
        }
    }

    @PluginMethod
    public void sign(PluginCall call) {
        String text = call.getString("text");
        if (text == null) {
            call.reject("text is required");
            return;
        }
        try {
            PrivateKey key = (PrivateKey) store().getKey(ALIAS, null);
            if (key == null) {
                call.reject("This phone has no key yet.");
                return;
            }
            Signature signer = Signature.getInstance("SHA256withECDSA");
            signer.initSign(key);
            signer.update(text.getBytes(StandardCharsets.UTF_8));
            JSObject result = new JSObject();
            result.put("signature", Base64.encodeToString(signer.sign(), Base64.NO_WRAP));
            call.resolve(result);
        } catch (GeneralSecurityException e) {
            call.reject("Could not sign: " + e.getMessage());
        } catch (Exception e) {
            call.reject("Could not reach this phone's key: " + e.getMessage());
        }
    }

    @PluginMethod
    public void scanQr(PluginCall call) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build();
        GmsBarcodeScanning.getClient(getContext(), options).startScan()
            .addOnSuccessListener((barcode) -> {
                JSObject result = new JSObject();
                result.put("text", barcode.getRawValue());
                call.resolve(result);
            })
            .addOnCanceledListener(() -> {
                JSObject result = new JSObject();
                result.put("cancelled", true);
                call.resolve(result);
            })
            .addOnFailureListener((failure) -> {
                if (failure instanceof MlKitException
                    && ((MlKitException) failure).getErrorCode() == MlKitException.CODE_SCANNER_CANCELLED) {
                    JSObject result = new JSObject();
                    result.put("cancelled", true);
                    call.resolve(result);
                    return;
                }
                // Not "could not start": on a Fold6 the back button lands here too, as
                // internal error 13, with the scanner having run perfectly well.
                String code = failure instanceof MlKitException
                    ? " (scanner error " + ((MlKitException) failure).getErrorCode() + ")"
                    : "";
                call.reject("No code was read" + code + ".");
            });
    }

    @PluginMethod
    public void readClipboard(PluginCall call) {
        JSObject result = new JSObject();
        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
        CharSequence text = clip == null || clip.getItemCount() == 0 ? null : clip.getItemAt(0).coerceToText(getContext());
        result.put("text", text == null ? "" : text.toString());
        call.resolve(result);
    }
}
