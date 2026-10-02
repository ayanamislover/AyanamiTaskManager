package moe.ayanami.atm;

import android.content.res.Configuration;
import android.graphics.drawable.ColorDrawable;
import android.os.Bundle;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

/**
 * 在 Capacitor 的 BridgeActivity 上补三件事：
 *
 * <ol>
 *   <li><b>系统栏留边。</b>edge-to-edge：状态栏、导航栏透明，页面的柔彩背景一直画到屏幕边缘。
 *   系统栏高度在这里量好，以 CSS 像素交给网页（{@code --inset-top / --inset-bottom}），由网页给头部和底栏留白；
 *   键盘与横屏刘海则直接垫在 DecorView 上——这样键盘弹起时 WebView 真的变矮，Chromium 会把焦点输入框滚进可视区。
 *   垫在 DecorView 而不是 WebView 上：给 WebView 自己 setPadding 只内缩绘制区，CSS 视口仍是整屏
 *   （AyanamiCloud 在同一台 OnePlus 9 上量过：innerHeight 800 对 749）。交给 WebView 的系统栏 inset 清零，
 *   防止 Chromium 140+ 的 env(safe-area-inset-*) 再垫一层。</li>
 *   <li><b>深浅色。</b>不依赖 WebView 对 prefers-color-scheme 的判定（不同 WebView / API 组合上不可靠），
 *   同步接口 {@code AtmNativeSync.isDark()} 给网页首帧用，系统切换主题时派发 {@code atm:native} 事件。
 *   状态栏图标深浅由网页按最终主题（含用户手动选的）回调 {@link #applySystemBars} 决定。</li>
 *   <li><b>自己的插件。</b>{@link AtmNativePlugin}：Keystore 加密存储、系统栏样式、设备信息。</li>
 * </ol>
 *
 * 返回键交给 @capacitor/app 的 backButton 事件：网页逐级返回，根页面调 App.exitApp()。
 */
public class MainActivity extends BridgeActivity {
    private volatile boolean systemDark;
    private volatile String insetsJson = "{\"top\":0,\"right\":0,\"bottom\":0,\"left\":0}";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AtmNativePlugin.class);
        super.onCreate(savedInstanceState);
        systemDark = isNight();
        applySystemBars(systemDark, null);
        if (bridge == null) return;
        WebView webView = bridge.getWebView();
        // 下拉刷新由网页自己画；根滚动容器不在 WebView 上，关掉原生的越界拉伸免得两套效果叠在一起。
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.addJavascriptInterface(new NativeSync(), "AtmNativeSync");
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView view) {
                pushState();
            }
        });
        installInsets();
    }

    private void installInsets() {
        View decor = getWindow().getDecorView();
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        ViewCompat.setOnApplyWindowInsetsListener(decor, (view, insets) -> {
            int barTypes = WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout();
            Insets bars = insets.getInsets(barTypes);
            boolean imeVisible = insets.isVisible(WindowInsetsCompat.Type.ime());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, 0, bars.right, imeVisible ? ime.bottom : 0);

            float density = getResources().getDisplayMetrics().density;
            String next = String.format(
                Locale.US,
                "{\"top\":%.2f,\"right\":0,\"bottom\":%.2f,\"left\":0}",
                bars.top / density,
                imeVisible ? 0f : bars.bottom / density
            );
            if (!next.equals(insetsJson)) {
                insetsJson = next;
                pushState();
            }
            return new WindowInsetsCompat.Builder(insets).setInsets(barTypes, Insets.NONE).build();
        });
        ViewCompat.requestApplyInsets(decor);
    }

    /** 网页按最终主题调用（src/ui/theme.ts）；启动时先按系统深浅色设一次。 */
    void applySystemBars(boolean dark, Integer background) {
        int color = background != null ? background : getColor(R.color.atm_background);
        getWindow().setBackgroundDrawable(new ColorDrawable(color));
        getWindow().getDecorView().setBackgroundColor(color);
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.setAppearanceLightStatusBars(!dark);
        controller.setAppearanceLightNavigationBars(!dark);
        if (bridge != null) bridge.getWebView().setBackgroundColor(color);
    }

    @Override
    public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        boolean dark = isNight();
        if (dark != systemDark) {
            systemDark = dark;
            pushState();
        }
    }

    private boolean isNight() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    private void pushState() {
        if (bridge == null) return;
        String script =
            "window.dispatchEvent(new CustomEvent('atm:native',{detail:{dark:" + systemDark + ",insets:" + insetsJson + "}}))";
        runOnUiThread(() -> bridge.getWebView().evaluateJavascript(script, null));
    }

    /** 首帧前同步读取。只返回布尔值和数字；页面只加载 APK 内置资源。 */
    private final class NativeSync {
        @JavascriptInterface
        public boolean isDark() {
            return systemDark;
        }

        @JavascriptInterface
        public String insets() {
            return insetsJson;
        }
    }
}
