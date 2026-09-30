package moe.ayanami.atm;

import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.os.Build;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;

/**
 * 网页用的原生能力，对应 src/native/platform.ts 的 AtmNativePlugin 接口。
 * 只有这几个方法，没有通用的「执行任意操作」入口。
 */
@CapacitorPlugin(name = "AtmNative")
public class AtmNativePlugin extends Plugin {
    private SecureStore store;

    @Override
    public void load() {
        store = new SecureStore(getContext());
    }

    private String name(PluginCall call) {
        String key = call.getString("key");
        if (!SecureStore.validName(key)) {
            call.reject("条目名不合法", "INVALID_KEY");
            return null;
        }
        return key;
    }

    @PluginMethod
    public void secureGet(PluginCall call) {
        String key = name(call);
        if (key == null) return;
        String value = store.get(key);
        JSObject result = new JSObject();
        result.put("value", value == null ? JSONObject.NULL : value);
        call.resolve(result);
    }

    @PluginMethod
    public void secureSet(PluginCall call) {
        String key = name(call);
        if (key == null) return;
        String value = call.getString("value");
        if (value == null || value.length() > 16 * 1024) {
            call.reject("内容为空或过长", "INVALID_VALUE");
            return;
        }
        try {
            store.set(key, value);
            call.resolve();
        } catch (Exception failure) {
            call.reject("安全存储写入失败", "SECURE_STORE_FAILED");
        }
    }

    @PluginMethod
    public void secureRemove(PluginCall call) {
        String key = name(call);
        if (key == null) return;
        store.remove(key);
        call.resolve();
    }

    @PluginMethod
    public void setSystemBars(PluginCall call) {
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        Integer background = null;
        String raw = call.getString("background");
        if (raw != null) {
            try {
                background = Color.parseColor(raw);
            } catch (IllegalArgumentException ignored) {
                background = null;
            }
        }
        final Integer color = background;
        getActivity().runOnUiThread(() -> {
            if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).applySystemBars(dark, color);
            call.resolve();
        });
    }

    @PluginMethod
    public void deviceInfo(PluginCall call) {
        JSObject result = new JSObject();
        result.put("manufacturer", Build.MANUFACTURER);
        result.put("model", Build.MODEL);
        result.put("sdk", Build.VERSION.SDK_INT);
        PackageInfo webView = WebView.getCurrentWebViewPackage();
        result.put("webView", webView == null ? "" : webView.versionName);
        call.resolve(result);
    }
}
